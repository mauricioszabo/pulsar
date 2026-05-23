'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const OPEN_VSX_API = 'https://open-vsx.org/api';

// ─── Public entry point ──────────────────────────────────────────────────────

async function installFromOpenVsx(namespace, name, version, onProgress) {
  onProgress = onProgress || (() => {});

  onProgress('Fetching extension info…');
  const info = await fetchJson(`${OPEN_VSX_API}/${namespace}/${name}/${version || 'latest'}`);
  if (!info || info.error) throw new Error(`Extension not found: ${namespace}.${name}`);

  const vsixUrl = info.files && info.files.download;
  if (!vsixUrl) throw new Error('No download URL for this extension version');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-vsx-'));
  const vsixPath = path.join(tmpDir, `${namespace}.${name}-${info.version}.vsix`);
  try {
    onProgress(`Downloading v${info.version}…`);
    await downloadFile(vsixUrl, vsixPath);

    const destDir = path.join(os.homedir(), '.pulsar', 'packages');
    fs.mkdirSync(destDir, { recursive: true });

    onProgress('Extracting and installing…');
    const pkgName = await wrapAndInstall(vsixPath, destDir, onProgress);
    return pkgName;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
  }
}

// ─── Core install logic (also used by wrap-vsix.js CLI) ──────────────────────

function wrapAndInstall(vsixPath, destDir, onProgress) {
  onProgress = onProgress || (() => {});
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsix-'));
    try {
      execSync(`unzip -q "${vsixPath}" -d "${tmpDir}"`, { stdio: 'pipe' });
    } catch (e) {
      fs.rmSync(tmpDir, { recursive: true });
      return reject(new Error('Failed to extract VSIX — is `unzip` installed?'));
    }

    try {
      const extPkgPath = path.join(tmpDir, 'extension', 'package.json');
      if (!fs.existsSync(extPkgPath))
        throw new Error('Missing extension/package.json inside VSIX');

      const extMeta = JSON.parse(fs.readFileSync(extPkgPath, 'utf8'));
      const extName      = extMeta.name        || 'unknown';
      const extPublisher = extMeta.publisher   || 'unknown';
      const extMain      = extMeta.main        || './extension';
      const extVersion   = extMeta.version     || '0.0.0';
      const extDesc      = extMeta.description || '';
      const activationEvents = extMeta.activationEvents || ['*'];

      const pulsarPkgName = `vscode-${extPublisher}-${extName}`;
      const outDir = path.join(destDir, pulsarPkgName);

      if (fs.existsSync(outDir)) {
        onProgress('Removing previous version…');
        fs.rmSync(outDir, { recursive: true });
      }
      fs.mkdirSync(path.join(outDir, 'lib'), { recursive: true });

      onProgress('Copying extension files…');
      fs.cpSync(path.join(tmpDir, 'extension'), path.join(outDir, 'extension'), { recursive: true });

      const atomConfig    = buildAtomConfig(extMeta.contributes);
      const configSections = getConfigSections(extMeta.contributes);

      const pulsarPkg = {
        name: pulsarPkgName,
        version: extVersion,
        description: `[VSCode compat] ${extDesc}`,
        main: './lib/main.js',
        engines: { atom: '>=1.0.0 <2.0.0' },
        _vscodeExtension: {
          id: `${extPublisher}.${extName}`,
          name: extName,
          publisher: extPublisher,
          main: extMain,
          activationEvents,
          configSections,
        },
      };
      if (Object.keys(atomConfig).length) pulsarPkg.config = atomConfig;

      fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(pulsarPkg, null, 2));
      fs.writeFileSync(path.join(outDir, 'lib', 'main.js'), generateWrapperMain());

      onProgress(`Installed as ${pulsarPkgName}`);
      resolve(pulsarPkgName);
    } catch (e) {
      reject(e);
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
    }
  });
}

// ─── Config schema conversion ─────────────────────────────────────────────────

function getConfigSections(contributes) {
  if (!contributes || !contributes.configuration) return [];
  const sections = Array.isArray(contributes.configuration)
    ? contributes.configuration : [contributes.configuration];
  const names = new Set();
  for (const s of sections)
    for (const key of Object.keys(s.properties || {})) {
      const prefix = key.split('.')[0];
      if (prefix) names.add(prefix);
    }
  return Array.from(names);
}

function buildAtomConfig(contributes) {
  if (!contributes || !contributes.configuration) return {};
  const sections = Array.isArray(contributes.configuration)
    ? contributes.configuration : [contributes.configuration];

  const result = {};
  for (const section of sections) {
    for (const [fullKey, schema] of Object.entries(section.properties || {})) {
      const parts = fullKey.split('.');
      let cursor = result;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (!cursor[p]) cursor[p] = { type: 'object', properties: {} };
        else if (!cursor[p].properties) cursor[p].properties = {};
        cursor = cursor[p].properties;
      }
      cursor[parts[parts.length - 1]] = convertSchema(schema);
    }
  }
  return result;
}

function convertSchema(schema) {
  if (!schema) return { type: 'string' };
  const typeMap = { string: 'string', number: 'number', integer: 'integer', boolean: 'boolean', array: 'array', object: 'object' };
  const out = {};

  if (Array.isArray(schema.type)) {
    out.type = typeMap[schema.type.find(t => t !== 'null')] || 'string';
  } else {
    out.type = typeMap[schema.type] || 'string';
  }

  if (schema.default     !== undefined) out.default     = schema.default;
  if (schema.description)               out.description = schema.description;
  else if (schema.markdownDescription)  out.description = schema.markdownDescription;
  if (schema.enum)                      out.enum        = schema.enum;
  if (schema.minimum     !== undefined) out.minimum     = schema.minimum;
  if (schema.maximum     !== undefined) out.maximum     = schema.maximum;

  if (out.type === 'array' && schema.items) out.items = convertSchema(schema.items);
  if (out.type === 'object' && schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties))
      out.properties[k] = convertSchema(v);
  }
  return out;
}

// ─── Generated wrapper main.js ────────────────────────────────────────────────

function generateWrapperMain() {
  return `'use strict';

const path = require('path');
const meta = require('../package.json')._vscodeExtension;
const extensionPath = path.join(__dirname, '..', 'extension');

let _context = null;
let _vsext = null;

module.exports = {
  activate(state) {
    const mainFile = path.resolve(extensionPath, meta.main);
    try {
      _vsext = require(mainFile);
    } catch (e) {
      console.error('[vscode-compat] Failed to load extension:', mainFile, e.message);
      return;
    }

    const { ExtensionContext } = require('vscode');
    _context = new ExtensionContext(meta.id, extensionPath, 1, state);

    if (_vsext && typeof _vsext.activate === 'function') {
      try {
        const result = _vsext.activate(_context);
        if (result && typeof result.then === 'function') {
          result.catch(e => console.error('[vscode-compat] activate error:', e));
        }
      } catch (e) {
        console.error('[vscode-compat] activate threw:', e);
      }
    }
  },

  deactivate() {
    if (_vsext && typeof _vsext.deactivate === 'function') {
      try { _vsext.deactivate(); } catch (_) {}
    }
    if (_context) { _context._dispose(); _context = null; }
  },

  serialize() {
    if (!_context) return {};
    return {
      global:     Object.fromEntries(_context.globalState.keys().map(k => [k, _context.globalState.get(k)])),
      workspace:  Object.fromEntries(_context.workspaceState.keys().map(k => [k, _context.workspaceState.get(k)])),
    };
  },
};
`;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const go = (u, hops) => {
      if (hops > 10) return reject(new Error('Too many redirects'));
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, { headers: { 'User-Agent': 'Pulsar-VSX/1.0', Accept: 'application/json' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
          return res.resume(), go(res.headers.location, hops + 1);
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
        res.on('error', reject);
      }).on('error', reject);
    };
    go(url, 0);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const go = (u, hops) => {
      if (hops > 10) return reject(new Error('Too many redirects'));
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, { headers: { 'User-Agent': 'Pulsar-VSX/1.0' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
          return res.resume(), go(res.headers.location, hops + 1);
        if (res.statusCode !== 200)
          return res.resume(), reject(new Error(`HTTP ${res.statusCode} downloading ${u}`));
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', err => { fs.unlink(dest, () => {}); reject(err); });
        res.on('error', err => { fs.unlink(dest, () => {}); reject(err); });
      }).on('error', reject);
    };
    go(url, 0);
  });
}

module.exports = { installFromOpenVsx, wrapAndInstall, buildAtomConfig, convertSchema, getConfigSections, generateWrapperMain };
