#!/usr/bin/env node
/**
 * wrap-vsix.js — Install a VSCode extension (.vsix) into Pulsar.
 *
 * Usage:
 *   node wrap-vsix.js <path-to.vsix>         # install into ~/.pulsar/packages/
 *   node wrap-vsix.js <path-to.vsix> <dest>  # install into <dest>/
 *
 * What it does:
 *   1. Extracts the .vsix (it's a ZIP)
 *   2. Reads extension/package.json for name, main, activationEvents
 *   3. Writes a thin Pulsar wrapper package into the packages directory
 *   4. The wrapper bridges Pulsar's activate(state) → VSCode's activate(context)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const vsixPath = process.argv[2];
if (!vsixPath) {
  console.error('Usage: node wrap-vsix.js <path-to.vsix> [dest-packages-dir]');
  process.exit(1);
}

const destDir = process.argv[3] || path.join(os.homedir(), '.pulsar', 'packages');

if (!fs.existsSync(vsixPath)) {
  console.error(`File not found: ${vsixPath}`);
  process.exit(1);
}

// Step 1: extract vsix to a temp dir
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsix-'));
console.log(`Extracting ${vsixPath} to ${tmpDir}...`);

try {
  execSync(`unzip -q "${path.resolve(vsixPath)}" -d "${tmpDir}"`, { stdio: 'inherit' });
} catch (e) {
  console.error('Failed to extract vsix. Is `unzip` installed?');
  process.exit(1);
}

// Step 2: read the extension manifest
const extPackageJsonPath = path.join(tmpDir, 'extension', 'package.json');
if (!fs.existsSync(extPackageJsonPath)) {
  console.error('Could not find extension/package.json inside the vsix.');
  process.exit(1);
}

const extMeta = JSON.parse(fs.readFileSync(extPackageJsonPath, 'utf8'));
const extName = extMeta.name || path.basename(vsixPath, '.vsix');
const extPublisher = extMeta.publisher || 'unknown';
const extMain = extMeta.main || './extension';
const extVersion = extMeta.version || '0.0.0';
const extDescription = extMeta.description || '';
const activationEvents = extMeta.activationEvents || ['*'];

const pulsarPkgName = `vscode-${extPublisher}-${extName}`;
const outDir = path.join(destDir, pulsarPkgName);

if (fs.existsSync(outDir)) {
  console.log(`Removing existing package at ${outDir}`);
  fs.rmSync(outDir, { recursive: true });
}

fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(path.join(outDir, 'lib'), { recursive: true });

// Step 3: copy extracted extension content
console.log(`Copying extension files to ${outDir}/extension...`);
fs.cpSync(path.join(tmpDir, 'extension'), path.join(outDir, 'extension'), { recursive: true });

// Step 4: write Pulsar package.json
const pulsarPkg = {
  name: pulsarPkgName,
  version: extVersion,
  description: `[VSCode compat] ${extDescription}`,
  main: './lib/main.js',
  engines: { atom: '>=1.0.0 <2.0.0' },
  _vscodeExtension: {
    id: `${extPublisher}.${extName}`,
    name: extName,
    publisher: extPublisher,
    main: extMain,
    activationEvents
  }
};

fs.writeFileSync(
  path.join(outDir, 'package.json'),
  JSON.stringify(pulsarPkg, null, 2)
);

// Step 5: write the Pulsar wrapper main.js
const mainJs = `'use strict';

const path = require('path');
const meta = require('../package.json')._vscodeExtension;
const extensionPath = path.join(__dirname, '..', 'extension');

let _context = null;
let _vsext = null;

module.exports = {
  activate(state) {
    // Load the VSCode extension module
    const mainFile = path.resolve(extensionPath, meta.main);
    try {
      _vsext = require(mainFile);
    } catch (e) {
      console.error('[vscode-compat] Failed to load extension:', mainFile, e.message);
      return;
    }

    // Build an ExtensionContext
    const { ExtensionContext } = require('vscode');
    _context = new ExtensionContext(
      meta.id,
      extensionPath,
      1, // ExtensionMode.Production
      state
    );

    // Activate
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
      try { _vsext.deactivate(); } catch (e) {}
    }
    if (_context) {
      _context._dispose();
      _context = null;
    }
  },

  serialize() {
    if (!_context) return {};
    return {
      global: Object.fromEntries(
        _context.globalState.keys().map(k => [k, _context.globalState.get(k)])
      ),
      workspace: Object.fromEntries(
        _context.workspaceState.keys().map(k => [k, _context.workspaceState.get(k)])
      )
    };
  }
};
`;

fs.writeFileSync(path.join(outDir, 'lib', 'main.js'), mainJs);

// Step 6: clean up tmp
fs.rmSync(tmpDir, { recursive: true });

console.log(`
✓ Done! Installed as Pulsar package: ${pulsarPkgName}
  Location: ${outDir}

To activate in Pulsar:
  • Restart Pulsar, or
  • Run: atom.packages.loadPackage('${pulsarPkgName}').then(() => atom.packages.activatePackage('${pulsarPkgName}'))
    in the Developer Console (View > Developer > Toggle Developer Tools)

Make sure 'pulsar-vscode-compat' is enabled first!
`);
