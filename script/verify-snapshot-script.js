#!/usr/bin/env node
'use strict';

// Verifies that a generated startup snapshot script evaluates cleanly in a bare
// V8 context — i.e. it performs no disallowed I/O at snapshot-generation time and
// is syntactically valid. This is the same check mksnapshot will perform, run up
// front so a bad script fails fast with a readable error.
//
// For the real snapshot build, run this with the *packaged* Electron via
// ELECTRON_RUN_AS_NODE so the V8 version matches the shipping binary; running it
// with host node is a useful first approximation.
//
// Usage: node script/verify-snapshot-script.js <path-to-startup.js>

const fs = require('fs');
const vm = require('vm');

const snapshotScriptPath = process.argv[2];
if (!snapshotScriptPath) {
  console.error('Usage: verify-snapshot-script.js <path-to-startup.js>');
  process.exit(1);
}

const snapshotScript = fs.readFileSync(snapshotScriptPath, 'utf8');

vm.runInNewContext(snapshotScript, undefined, {
  filename: snapshotScriptPath,
  displayErrors: true
});

console.log('Snapshot script evaluated successfully.');
