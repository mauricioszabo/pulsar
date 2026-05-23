#!/usr/bin/env node
/**
 * wrap-vsix.js — Install a VSCode extension (.vsix) into Pulsar.
 *
 * Usage:
 *   node wrap-vsix.js <path-to.vsix>         # install into ~/.pulsar/packages/
 *   node wrap-vsix.js <path-to.vsix> <dest>  # install into <dest>/
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const vsixPath = process.argv[2];
if (!vsixPath) {
  console.error('Usage: node wrap-vsix.js <path-to.vsix> [dest-packages-dir]');
  process.exit(1);
}
if (!fs.existsSync(vsixPath)) {
  console.error(`File not found: ${vsixPath}`);
  process.exit(1);
}

const destDir = process.argv[3] || path.join(os.homedir(), '.pulsar', 'packages');
fs.mkdirSync(destDir, { recursive: true });

const { wrapAndInstall } = require('../lib/ui/install-vsx');

wrapAndInstall(path.resolve(vsixPath), destDir, msg => console.log(msg))
  .then(pulsarPkgName => {
    console.log(`
✓ Done! Installed as Pulsar package: ${pulsarPkgName}
  Location: ${path.join(destDir, pulsarPkgName)}

To activate in Pulsar:
  • Restart Pulsar, or
  • Run: atom.packages.loadPackage('${pulsarPkgName}').then(() => atom.packages.activatePackage('${pulsarPkgName}'))
    in the Developer Console (View > Developer > Toggle Developer Tools)

Make sure 'pulsar-vscode-compat' is enabled first!
`);
  })
  .catch(e => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  });
