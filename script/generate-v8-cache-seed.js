'use strict';

// Build-time generator for a "warm" V8 bytecode-cache seed shipped with the app.
//
// At runtime, NativeCompileCache (src/native-compile-cache.js) caches the V8
// `cachedData` for every compiled module in a FileSystemBlobStore under
// `$ATOM_HOME/blob-store`. On a fresh install that store is empty, so the first
// launch recompiles every module's bytecode from scratch.
//
// This script warms that cache once, with the *exact* Electron/V8 that will ship
// (this is mandatory — V8 `cachedData` is rejected by any other V8 build), and
// captures the resulting `BLOB`/`MAP` as a read-only seed. At runtime,
// FileSystemBlobStore.load consults the seed when the writable store is empty.
//
// IMPORTANT: the seed is V8-version-specific. It MUST be regenerated whenever
// `electronVersion` changes, or it becomes silent dead weight (every entry is
// rejected at boot). `script/check-v8-cache-seed.js` is the CI guard for that.
//
// Usage:
//   node script/generate-v8-cache-seed.js [--electron <path>] [--out <dir>]
//
// Without `--electron`, it uses the project's `node_modules/.bin/electron`.
// `--out` defaults to `blob-store-seed/` at the repo root (shipped via the
// electron-builder `files` glob).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { electron: null, out: path.join(ROOT, 'blob-store-seed') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--electron') args.electron = argv[++i];
    else if (argv[i] === '--out') args.out = path.resolve(argv[++i]);
  }
  return args;
}

function defaultElectronBinary() {
  const bin =
    process.platform === 'win32'
      ? path.join(ROOT, 'node_modules', '.bin', 'electron.cmd')
      : path.join(ROOT, 'node_modules', '.bin', 'electron');
  return bin;
}

module.exports = function generateV8CacheSeed(opts = {}) {
  const electron = opts.electron || defaultElectronBinary();
  const outDir = opts.out || path.join(ROOT, 'blob-store-seed');

  // Warm against a throwaway ATOM_HOME so we never pollute the developer's real
  // profile and always start from a cold cache.
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-seed-home-'));
  const blobStoreDir = path.join(tmpHome, 'blob-store');

  console.log(`Warming V8 cache with ${electron}`);
  console.log(`  ATOM_HOME=${tmpHome}`);

  // Drive a full boot + clean shutdown via the warm-up spec, which initializes a
  // real AtomEnvironment (compiling the startup module graph) and then triggers
  // unloadEditorWindow so the blob store is flushed to disk.
  const result = spawnSync(
    electron,
    [
      '--no-sandbox',
      '--enable-logging',
      ROOT,
      '-f',
      '--test',
      path.join(ROOT, 'spec', 'v8-cache-warmup-spec.js')
    ],
    {
      cwd: ROOT,
      env: { ...process.env, ATOM_HOME: tmpHome },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5 * 60 * 1000
    }
  );

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  const blobFile = path.join(blobStoreDir, 'BLOB');
  const mapFile = path.join(blobStoreDir, 'MAP');

  if (!fs.existsSync(blobFile) || !fs.existsSync(mapFile)) {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    throw new Error(
      'V8 cache warm-up did not produce a blob store. Did the warm-up spec ' +
        'run and the window unload cleanly?'
    );
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(blobFile, path.join(outDir, 'BLOB'));
  fs.copyFileSync(mapFile, path.join(outDir, 'MAP'));

  const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
  const entryCount = Object.keys(map).length;
  const blobBytes = fs.statSync(blobFile).size;

  fs.rmSync(tmpHome, { recursive: true, force: true });

  console.log(
    `Generated V8 cache seed at ${path.relative(ROOT, outDir) ||
      outDir}: ${entryCount} entries, ${(blobBytes / 1024 / 1024).toFixed(
      1
    )} MB`
  );

  return { entryCount, blobBytes, outDir };
};

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  module.exports({ electron: args.electron, out: args.out });
}
