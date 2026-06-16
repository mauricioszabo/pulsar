'use strict';

// CI guard for the shipped V8 cache seed (blob-store-seed/).
//
// The V8 bytecode seed is only valid for the exact Electron/V8 it was generated
// with. After an Electron bump, an un-regenerated seed is silently rejected at
// boot — it ships as dead weight and the startup win quietly disappears. This
// script makes that failure loud: it boots the app against a clean ATOM_HOME so
// the seed fallback is exercised, reads the hit/miss/reject counts, and exits
// non-zero if the seed isn't doing its job.
//
// Usage:
//   node script/check-v8-cache-seed.js [--electron <path>] [--max-reject-rate 0.05] [--min-hits 200]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    electron: null,
    maxRejectRate: 0.05,
    minHits: 200
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--electron') args.electron = argv[++i];
    else if (argv[i] === '--max-reject-rate')
      args.maxRejectRate = parseFloat(argv[++i]);
    else if (argv[i] === '--min-hits') args.minHits = parseInt(argv[++i], 10);
  }
  return args;
}

function defaultElectronBinary() {
  return process.platform === 'win32'
    ? path.join(ROOT, 'node_modules', '.bin', 'electron.cmd')
    : path.join(ROOT, 'node_modules', '.bin', 'electron');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const electron = args.electron || defaultElectronBinary();

  const seedDir = path.join(ROOT, 'blob-store-seed');
  if (
    !fs.existsSync(path.join(seedDir, 'BLOB')) ||
    !fs.existsSync(path.join(seedDir, 'MAP'))
  ) {
    console.error(
      `No V8 cache seed found at ${path.relative(ROOT, seedDir)}/. ` +
        'Run `node script/generate-v8-cache-seed.js` first.'
    );
    process.exit(1);
  }

  const cleanHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-seed-check-'));

  const result = spawnSync(
    electron,
    [
      '--no-sandbox',
      '--enable-logging',
      ROOT,
      '-f',
      '--test',
      path.join(ROOT, 'spec', 'v8-cache-seed-check-spec.js')
    ],
    {
      cwd: ROOT,
      env: { ...process.env, ATOM_HOME: cleanHome },
      encoding: 'utf8',
      timeout: 5 * 60 * 1000
    }
  );

  fs.rmSync(cleanHome, { recursive: true, force: true });

  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const match = output.match(/V8_SEED_STATS (\{.*\})/);
  if (!match) {
    console.error('Could not read V8_SEED_STATS from the seed-check run.');
    console.error(output);
    process.exit(1);
  }

  const stats = JSON.parse(match[1]);
  const consulted = stats.hits + stats.rejected;
  const rejectRate = consulted > 0 ? stats.rejected / consulted : 1;

  console.log(
    `V8 cache seed: ${stats.hits} hits, ${stats.rejected} rejected, ` +
      `${stats.misses} misses (reject rate ${(rejectRate * 100).toFixed(1)}%)`
  );

  if (stats.hits < args.minHits) {
    console.error(
      `FAIL: only ${stats.hits} cache hits (expected >= ${args.minHits}). ` +
        'The seed is not being consumed — regenerate it for the current Electron.'
    );
    process.exit(1);
  }

  if (rejectRate > args.maxRejectRate) {
    console.error(
      `FAIL: reject rate ${(rejectRate * 100).toFixed(1)}% exceeds ` +
        `${(args.maxRejectRate * 100).toFixed(1)}%. The seed was likely built ` +
        'against a different Electron/V8 — regenerate it.'
    );
    process.exit(1);
  }

  console.log('V8 cache seed OK.');
}

main();
