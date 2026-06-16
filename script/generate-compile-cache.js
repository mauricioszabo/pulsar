'use strict';

// Build-time generator for a "warm" transpile cache that ships inside the app.
//
// At runtime, Pulsar transpiles CoffeeScript / `"use babel"` / TypeScript
// sources on first require and caches the result under
// `$ATOM_HOME/compile-cache` (see src/compile-cache.js). On a freshly installed
// app — or right after an update — that cache is empty, so the very first launch
// pays the full transpile cost for hundreds of files.
//
// This script pre-runs the exact same compilers over the bundled sources and
// writes their output into a read-only `compile-cache/` directory at the repo
// root, using the *same* content-addressed cache paths the runtime would
// compute. `compile-cache.js` consults this directory as a fallback when the
// writable cache misses (see CompileCache.setFallbackCacheDirectory), so the
// first launch gets cache hits instead of a cold compile.
//
// The cache keys depend only on source content (+ compiler version/options), so
// the generated directory is portable across machines and operating systems.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// Reuse the real compilers so the cache keys match the runtime byte-for-byte.
const COMPILERS = {
  '.js': require(path.join(ROOT, 'src', 'babel.js')),
  '.coffee': require(path.join(ROOT, 'src', 'coffee-script.js')),
  '.ts': require(path.join(ROOT, 'src', 'typescript.js')),
  '.tsx': require(path.join(ROOT, 'src', 'typescript.js'))
};

// Directories whose sources are required at runtime and benefit from warming.
// `node_modules` is intentionally excluded: third-party packages rarely use the
// `"use babel"` prefix, and walking the whole tree would be slow for little
// gain. Bundled first-party packages live under `packages/`.
const SOURCE_ROOTS = ['src', 'exports', 'static', 'packages'];

// Skip directories that never contain runtime-required transpilable sources.
const SKIP_DIRS = new Set([
  'node_modules',
  'spec',
  'test',
  'tests',
  '.git',
  'coverage',
  'dist',
  'benchmark',
  'benchmarks'
]);

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(fullPath);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

function writeCacheEntry(outDir, relativeCachePath, code) {
  const destPath = path.join(outDir, relativeCachePath);
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, code, 'utf8');
}

module.exports = function generateCompileCache(outDir) {
  outDir = outDir || path.join(ROOT, 'compile-cache');
  fs.mkdirSync(outDir, { recursive: true });

  const stats = { compiled: 0, skipped: 0, failed: 0, byExtension: {} };

  for (const sourceRoot of SOURCE_ROOTS) {
    const absRoot = path.join(ROOT, sourceRoot);
    if (!fs.existsSync(absRoot)) continue;

    for (const filePath of walk(absRoot)) {
      const ext = path.extname(filePath);
      const compiler = COMPILERS[ext];
      if (!compiler) continue;

      let sourceCode;
      try {
        sourceCode = fs.readFileSync(filePath, 'utf8');
      } catch (error) {
        continue;
      }

      if (!compiler.shouldCompile(sourceCode, filePath)) {
        stats.skipped++;
        continue;
      }

      try {
        const relativeCachePath = compiler.getCachePath(sourceCode, filePath);
        const compiledCode = compiler.compile(sourceCode, filePath);
        writeCacheEntry(outDir, relativeCachePath, compiledCode);
        stats.compiled++;
        stats.byExtension[ext] = (stats.byExtension[ext] || 0) + 1;
      } catch (error) {
        // A single uncompilable file must not abort the whole build. The runtime
        // will simply transpile it on demand (a cache miss), exactly as today.
        stats.failed++;
        console.warn(
          `  warn: could not pre-compile ${path.relative(ROOT, filePath)}: ${
            error.message
          }`
        );
      }
    }
  }

  console.log(
    `Generated compile cache at ${path.relative(ROOT, outDir) ||
      outDir}: ${stats.compiled} compiled, ${stats.skipped} skipped, ${
      stats.failed
    } failed`,
    stats.byExtension
  );

  return stats;
};

// Allow running directly: `node script/generate-compile-cache.js [outDir]`
if (require.main === module) {
  module.exports(process.argv[2]);
}
