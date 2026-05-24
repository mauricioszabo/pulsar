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
      const extensionDir = path.join(tmpDir, 'extension');
      const extPkgPath = path.join(extensionDir, 'package.json');
      if (!fs.existsSync(extPkgPath))
        throw new Error('Missing extension/package.json inside VSIX');

      const extMeta = JSON.parse(fs.readFileSync(extPkgPath, 'utf8'));
      const extName      = extMeta.name        || 'unknown';
      const extPublisher = extMeta.publisher   || 'unknown';
      const extMain      = extMeta.main        || './extension';
      const extVersion   = extMeta.version     || '0.0.0';
      const extDesc      = extMeta.description || '';
      const activationEvents = extMeta.activationEvents || ['*'];
      const icon = normalizeRelativePath(extMeta.icon);

      const pulsarPkgName = `vscode-${extPublisher}-${extName}`;
      const outDir = path.join(destDir, pulsarPkgName);

      if (fs.existsSync(outDir)) {
        onProgress('Removing previous version…');
        fs.rmSync(outDir, { recursive: true });
      }
      fs.mkdirSync(path.join(outDir, 'lib'), { recursive: true });

      onProgress('Copying extension files…');
      fs.cpSync(extensionDir, path.join(outDir, 'extension'), { recursive: true });

      const atomConfig    = buildAtomConfig(extMeta.contributes);
      const configSections = getConfigSections(extMeta.contributes);
      const contributedCommandIds = getContributedCommandIds(extMeta.contributes);
      const displayName = extMeta.displayName || extName;
      const repository = normalizeRepository(extMeta.repository);
      const bugs = normalizeBugs(extMeta.bugs);
      const homepage = extMeta.homepage || (repository && (typeof repository === 'string' ? repository : repository.url));

      const pulsarPkg = {
        name: pulsarPkgName,
        version: extVersion,
        description: `[VSCode compat] ${extDesc}`,
        main: './lib/main.js',
        engines: { atom: '>=1.0.0 <2.0.0' },
        activationCommands: contributedCommandIds.length
          ? { 'atom-workspace': contributedCommandIds }
          : undefined,
        displayName,
        author: extMeta.author,
        license: extMeta.license,
        repository,
        bugs,
        homepage,
        keywords: Array.isArray(extMeta.keywords) ? extMeta.keywords : undefined,
        categories: Array.isArray(extMeta.categories) ? extMeta.categories : undefined,
        icon: icon ? path.posix.join('extension', icon) : undefined,
        _vscodeExtension: {
          id: `${extPublisher}.${extName}`,
          name: extName,
          publisher: extPublisher,
          displayName,
          description: extDesc,
          icon,
          main: extMain,
          activationEvents,
          configSections,
        },
      };
      if (Object.keys(atomConfig).length) {
        // Pulsar/Atom reads package configuration schemas from package.json's
        // `configSchema` metadata during package load. A `config` key in
        // package.json is ignored; `config` is only read from the package's main
        // module after it has been required. Store the schema under
        // `configSchema` so Settings View can show VSCode extension settings as
        // soon as the wrapper package is loaded.
        pulsarPkg.configSchema = atomConfig;
      }

      pruneUndefined(pulsarPkg);
      fs.writeFileSync(path.join(outDir, 'package.json'), JSON.stringify(pulsarPkg, null, 2));
      fs.writeFileSync(path.join(outDir, 'lib', 'main.js'), generateWrapperMain());
      writePulsarReadme(extensionDir, outDir, extMeta, pulsarPkg);
      copyTopLevelDoc(extensionDir, outDir, ['CHANGELOG', 'HISTORY']);
      copyTopLevelDoc(extensionDir, outDir, ['LICENSE', 'LICENCE', 'COPYING']);

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

function getContributedCommandIds(contributes) {
  const commands = contributes && contributes.commands;
  if (!Array.isArray(commands)) return [];
  const ids = new Set();
  for (const contribution of commands) {
    if (contribution && typeof contribution.command === 'string' && contribution.command.trim()) {
      ids.add(contribution.command);
    }
  }
  return Array.from(ids);
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
    out.type = typeMap[schema.type.find(t => t !== 'null')] || inferAtomType(schema) || 'string';
  } else {
    out.type = typeMap[schema.type] || inferAtomType(schema) || 'string';
  }

  if (schema.default     !== undefined) out.default     = schema.default;
  if (schema.title)                     out.title       = normalizeMarkdownText(schema.title);
  if (schema.description)               out.description = normalizeMarkdownText(schema.description);
  else if (schema.markdownDescription)  out.description = normalizeMarkdownText(schema.markdownDescription);
  if (schema.enum)                      out.enum        = schema.enum;
  if (schema.minimum     !== undefined) out.minimum     = schema.minimum;
  if (schema.maximum     !== undefined) out.maximum     = schema.maximum;
  if (schema.order       !== undefined) out.order       = schema.order;

  if (out.type === 'array' && schema.items) out.items = convertSchema(schema.items);
  if (out.type === 'object' && schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties))
      out.properties[k] = convertSchema(v);
  }
  return out;
}

function inferAtomType(schema) {
  if (Array.isArray(schema.enum) && schema.enum.length) {
    const firstDefined = schema.enum.find(v => v !== null && v !== undefined);
    if (Array.isArray(firstDefined)) return 'array';
    return typeof firstDefined;
  }
  if (schema.default !== undefined && schema.default !== null) {
    if (Array.isArray(schema.default)) return 'array';
    return typeof schema.default;
  }
  if (schema.properties) return 'object';
  if (schema.items) return 'array';
  return null;
}

function normalizeMarkdownText(value) {
  if (Array.isArray(value)) return value.map(normalizeMarkdownText).join('\n\n');
  if (value == null) return '';
  return String(value);
}

// ─── Package metadata/readme conversion ───────────────────────────────────────

function normalizeRelativePath(value) {
  if (!value || typeof value !== 'string') return null;
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(normalized)) return null;
  if (normalized.split('/').some(part => part === '..')) return null;
  return normalized;
}

function normalizeRepository(repository) {
  if (!repository) return undefined;
  if (typeof repository === 'string') return repository;
  if (typeof repository === 'object' && repository.url) {
    return {
      type: repository.type || 'git',
      url: repository.url,
    };
  }
  return undefined;
}

function normalizeBugs(bugs) {
  if (!bugs) return undefined;
  if (typeof bugs === 'string') return { url: bugs };
  if (typeof bugs === 'object' && bugs.url) return { url: bugs.url };
  return undefined;
}

function pruneUndefined(value) {
  if (!value || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
    else if (value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) pruneUndefined(value[key]);
  }
  return value;
}

function findTopLevelDoc(extensionDir, basenames) {
  for (const child of fs.readdirSync(extensionDir)) {
    const ext = path.extname(child);
    const base = path.basename(child, ext).toUpperCase();
    if (basenames.includes(base)) {
      const fullPath = path.join(extensionDir, child);
      if (fs.statSync(fullPath).isFile()) return fullPath;
    }
  }
  return null;
}

function copyTopLevelDoc(extensionDir, outDir, basenames) {
  const src = findTopLevelDoc(extensionDir, basenames);
  if (!src) return;
  const dest = path.join(outDir, path.basename(src));
  if (fs.existsSync(dest)) return;
  fs.copyFileSync(src, dest);
}

function writePulsarReadme(extensionDir, outDir, extMeta, pulsarPkg) {
  const readmePath = findTopLevelDoc(extensionDir, ['README']);
  let readme = readmePath ? fs.readFileSync(readmePath, 'utf8') : '';
  readme = rewriteReadmeResourceLinks(readme);

  const header = buildPulsarReadmeHeader(extMeta, pulsarPkg);
  fs.writeFileSync(path.join(outDir, 'README.md'), `${header}${readme || 'No README was included in the VSIX.\n'}`);
}

function buildPulsarReadmeHeader(extMeta, pulsarPkg) {
  const title = extMeta.displayName || extMeta.name || pulsarPkg.name;
  const icon = normalizeRelativePath(extMeta.icon);
  const iconHtml = icon ? `<p align="center"><img src="extension/${escapeHtmlAttribute(icon)}" alt="${escapeHtmlAttribute(title)} icon" width="96" height="96"></p>\n\n` : '';
  const description = extMeta.description ? `\n\n> ${String(extMeta.description).replace(/\n/g, ' ')}` : '';
  return `${iconHtml}# ${title}${description}\n\n---\n\n`;
}

function rewriteReadmeResourceLinks(markdown) {
  if (!markdown) return '';
  let out = markdown.replace(/(!?\[[^\]]*\]\()\s*([^\s)]+)(\s*(?:"[^"]*"|'[^']*')?\))/g, (match, prefix, target, suffix) => {
    return `${prefix}${prefixReadmeTarget(target)}${suffix}`;
  });
  out = out.replace(/\b(src|href)=(['"])([^'"]+)\2/gi, (match, attr, quote, target) => {
    return `${attr}=${quote}${prefixReadmeTarget(target)}${quote}`;
  });
  return out;
}

function prefixReadmeTarget(target) {
  const cleaned = String(target || '').replace(/^<|>$/g, '');
  if (!cleaned || cleaned.startsWith('#') || cleaned.startsWith('//') || cleaned.startsWith('/')) return target;
  if (/^[a-z][a-z0-9+.-]*:/i.test(cleaned)) return target;
  if (cleaned.startsWith('extension/')) return cleaned;
  const match = cleaned.match(/^([^?#]*)([?#].*)?$/);
  const resource = normalizeRelativePath(match ? match[1] : cleaned);
  if (!resource) return target;
  return `extension/${resource}${match && match[2] ? match[2] : ''}`;
}

function escapeHtmlAttribute(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── Generated wrapper main.js ────────────────────────────────────────────────

function generateWrapperMain() {
  return `'use strict';

const path = require('path');
const packageMeta = require('../package.json');
const meta = packageMeta._vscodeExtension;
const extensionPath = path.join(__dirname, '..', 'extension');

let _context = null;
let _vsext = null;

module.exports = {
  // Pulsar also registers configuration schemas from the main module config
  // property when Settings View calls pack.activateConfig(). Keep this here as
  // a compatibility fallback for wrapper packages generated with older metadata
  // shapes, while new packages expose the schema as package.json configSchema.
  config: packageMeta.configSchema || packageMeta.config,

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
