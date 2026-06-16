'use strict';

// Build-time generator for the V8 startup snapshot script.
//
// `electron-link` walks the require() graph from the renderer entry point and
// produces a single `startup.js` whose top-level effect is to define a
// `snapshotResult` object exposing every bundled module via `customRequire`
// (see node_modules/electron-link/lib/blueprint.js). That script is then fed to
// `electron-mksnapshot` to bake the parsed/initialized module heap into
// `snapshot_blob.bin` / `v8_context_snapshot.bin`.
//
// Modules that cannot run in the snapshot's restricted environment (no real
// `process`/`document`/native bindings at snapshot time) are excluded from the
// graph via `shouldExcludeModule`; at runtime `customRequire` falls through to
// Node's `require` for them.
//
// This is adapted from the pre-2022 `script/lib/generate-startup-snapshot.js`,
// updated for: (a) no `CONFIG`/intermediate-app staging — paths are relative to
// the repo root; (b) terser 5's async `minify`; (c) electron-link 0.6.0's
// `{ snapshotScript }` return shape.
//
// Usage:
//   node script/generate-startup-snapshot.js [--out <dir>]
// Produces `<out>/startup.js` (default: `<repo>/out/startup.js`).

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const electronLink = require('electron-link');
const terser = require('terser');

const ROOT = path.resolve(__dirname, '..');
const BASE_DIR = path.join(ROOT, 'static');
// Snapshot a curated set of heavy, parse-only core modules rather than the full
// app entry. initialize-application-window.js constructs AtomEnvironment and
// preloads packages at module-eval time — eager I/O the snapshot context cannot
// satisfy — so we point at src/snapshot-entry.js, which only requires the
// expensive modules to bake their compiled code into the snapshot heap.
const MAIN_PATH = path.resolve(BASE_DIR, '..', 'src', 'snapshot-entry.js');

// Core runtime modules that must never be snapshotted.
const CORE_MODULES = new Set(['electron', 'atom', 'shell', 'remote']);

// Modules backed by native `.node` bindings or that touch the DOM / real
// `process` at require time. They crash or misbehave in the snapshot's fake
// environment, so they're resolved lazily via Node `require` at runtime. Matched
// as `node_modules/<name>/` substrings of the resolved path, so a single entry
// covers a package's whole subtree regardless of its `main` file.
const EXCLUDED_PACKAGES = [
  // Electron itself: electron/index.js calls require('fs') at module-eval time
  // (getElectronPath), which the snapshot can't satisfy. Resolve it live.
  'electron',
  '@electron/remote',
  // Native-backed first-party deps
  '@pulsar-edit/text-buffer',
  '@pulsar-edit/superstring',
  '@pulsar-edit/git-utils',
  '@pulsar-edit/pathwatcher',
  '@pulsar-edit/scandal',
  '@pulsar-edit/fuzzy-native',
  // Tree-sitter / grammars (native + wasm, awaited at boot)
  'second-mate',
  'tree-sitter',
  'web-tree-sitter',
  // Spell checking (native)
  'spellchecker',
  'spell-check',
  'spelling-manager',
  // Other native / process-touching deps
  'nsfw',
  'dugite',
  'fs-admin',
  'ctags',
  'oniguruma',
  'vscode-ripgrep',
  '@vscode/ripgrep',
  'keytar',
  // Transpilers / build tooling (large, dynamic, never needed pre-evaluated)
  'babel-plugin',
  'babel-preset',
  'supports-color',
  // Dynamic-require offenders that break static graph analysis
  'xregexp',
  'coffeescript',
  'coffee-script',
  'graceful-fs',
  'fs-extra',
  'glob',
  'minimatch',
  'iconv-lite',
  'less',
  'resolve',
  'request',
  'node-fetch',
  'tar',
  'tmp',
  'temp',
  'yauzl',
  'winreg',
  'util-deprecate',
  'debug',
  // CSON/config parsers do deferred requires at module-eval time.
  'cson-parser',
  'season',
  // Source-map machinery loads files/wasm at eval; it must run live anyway.
  '@atom/source-map-support',
  'source-map',
  // Markup/HTML parsers with eval-time dynamic requires (carried over from the
  // historical Atom snapshot exclusion list; harmless if not in the graph).
  'parse5',
  'htmlparser2',
  'cheerio',
  'marked',
  'yaml-front-matter',
  // Utilities with conditional/dynamic `debug` requires at eval time.
  // NB: semver must NOT be excluded — module-cache.js does
  // `class Range extends semver.Range` at eval time, which needs the real module.
  'normalize-package-data',
  // Color libs do dynamic requires of their conversion tables at eval time.
  'color',
  'color-convert',
  'color-string',
  'color-name',
  // CSS selector parser with eval-time dynamic requires.
  // NB: scoped-property-store / property-accessors / emissary are pure JS and
  // are extended at class-definition time, so they must stay IN the snapshot.
  'atom-slick'
];

// Individual files (matched by forward-slash path suffix) that must run live
// because they touch native bindings / the DOM / deferred requires at module
// evaluation time, even though the rest of their package is snapshot-safe.
const EXCLUDED_FILE_SUFFIXES = [
  // atom-keymap's command-event subclasses the DOM CustomEvent and pulls in
  // deferred requires while the snapshot context has no globals yet.
  '@pulsar-edit/atom-keymap/src/command-event.js',
  // Tree-sitter / wasm grammar machinery loads native/wasm modules at eval time.
  'src/web-tree-sitter.js',
  'src/wasm-tree-sitter-grammar.js',
  'src/wasm-tree-sitter-language-mode.js',
  // The transpiler chain resolves its config via __dirname (e.g. babel.js does
  // `path.join(__dirname, './babel.config.js')`), which doesn't survive being
  // snapshotted — __dirname inside a snapshot module isn't the real src/ path.
  // These are bootstrap infra installed live by static/index.js anyway.
  'src/compile-cache.js',
  'src/babel.js',
  'src/babel.config.js',
  'src/typescript.js',
  'src/coffee-script.js',
  'src/package-transpilation-registry.js'
];

function toRelative(filePath) {
  return path.relative(BASE_DIR, filePath).replace(/\\/g, '/');
}

function shouldExcludeModule({ requiredModulePath }) {
  // Native addons can never be snapshotted.
  if (requiredModulePath.endsWith('.node')) return true;

  const relative = toRelative(requiredModulePath);

  // Core Electron modules.
  if (CORE_MODULES.has(requiredModulePath)) return true;

  // DOM-touching custom-element files in core.
  if (relative.startsWith('../src/') && relative.endsWith('-element.js')) {
    return true;
  }

  // Shared between main and renderer; snapshotting it breaks the marker bridge.
  if (relative === '../src/startup-time.js') return true;

  // The public atom export and electron shims must run live.
  if (relative === '../exports/atom.js') return true;
  if (relative === '../src/electron-shims.js') return true;

  // `@babel/*` except `@babel/runtime` (small, used by transpiled output).
  if (
    requiredModulePath.includes(`${path.sep}@babel${path.sep}`) &&
    !requiredModulePath.includes(
      `${path.sep}@babel${path.sep}runtime${path.sep}`
    )
  ) {
    return true;
  }

  // Excluded packages, matched anywhere in the resolved path.
  for (const pkg of EXCLUDED_PACKAGES) {
    if (requiredModulePath.includes(`${path.sep}node_modules${path.sep}${pkg}${path.sep}`)) {
      return true;
    }
  }

  // Individual excluded files, matched by forward-slash path suffix.
  const forwardSlashPath = requiredModulePath.replace(/\\/g, '/');
  for (const suffix of EXCLUDED_FILE_SUFFIXES) {
    if (forwardSlashPath.endsWith(suffix)) {
      return true;
    }
  }

  return false;
}

module.exports = async function generateStartupSnapshot(opts = {}) {
  const outDir = opts.out || path.join(ROOT, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const snapshotScriptPath = path.join(outDir, 'startup.js');

  let processedFiles = 0;
  console.log(`Generating snapshot script from ${toRelative(MAIN_PATH)}`);

  const { snapshotScript } = await electronLink({
    baseDirPath: BASE_DIR,
    mainPath: MAIN_PATH,
    cachePath: path.join(outDir, 'snapshot-cache'),
    auxiliaryData: opts.auxiliaryData || {},
    shouldExcludeModule(modulePaths) {
      processedFiles++;
      if (processedFiles % 50 === 0) {
        process.stdout.write(`\r  processed ${processedFiles} modules`);
      }
      return shouldExcludeModule(modulePaths);
    }
  });
  process.stdout.write(`\r  processed ${processedFiles} modules\n`);

  console.log('Minifying startup script');
  const minification = await terser.minify(snapshotScript, {
    keep_fnames: true,
    keep_classnames: true,
    compress: { keep_fargs: true, keep_infinity: true }
  });
  if (minification.error) throw minification.error;

  fs.writeFileSync(snapshotScriptPath, minification.code);
  console.log(
    `Wrote ${path.relative(ROOT, snapshotScriptPath)} (${(
      minification.code.length /
      1024 /
      1024
    ).toFixed(1)} MB)`
  );

  // Sanity-check that the script at least evaluates in a bare V8 context before
  // anyone tries to feed it to mksnapshot.
  if (opts.verify !== false) {
    console.log('Verifying snapshot script evaluates in isolation');
    childProcess.execFileSync(
      process.execPath,
      [path.join(__dirname, 'verify-snapshot-script.js'), snapshotScriptPath],
      { stdio: 'inherit' }
    );
  }

  // Generate the actual V8 blobs with electron-mksnapshot (matched to the
  // shipping Electron's V8). Gated so the fast verify-only loop can skip it.
  let binaries = null;
  if (opts.mksnapshot) {
    binaries = generateBlobs(snapshotScriptPath, outDir);
  }

  return { snapshotScriptPath, binaries };
};

// Run electron-mksnapshot over the startup script, producing
// snapshot_blob.bin + v8_context_snapshot.bin in `outDir`.
function generateBlobs(snapshotScriptPath, outDir) {
  const mksnapshotDir = path.join(
    ROOT,
    'node_modules',
    'electron-mksnapshot'
  );
  // electron-mksnapshot downloads its (V8-matched) binary as a postinstall step.
  // That can be absent (e.g. installed with --ignore-scripts), so fetch it on
  // demand rather than failing the build.
  if (!fs.existsSync(path.join(mksnapshotDir, 'bin'))) {
    console.log('Downloading mksnapshot binary (matched to Electron version)');
    childProcess.execFileSync(
      process.execPath,
      [path.join(mksnapshotDir, 'download-mksnapshot.js')],
      { stdio: 'inherit' }
    );
  }

  console.log('Generating V8 blobs with mksnapshot');
  childProcess.execFileSync(
    process.execPath,
    [
      path.join(mksnapshotDir, 'mksnapshot.js'),
      snapshotScriptPath,
      '--output_dir',
      outDir
    ],
    { stdio: 'inherit' }
  );

  const binaries = ['snapshot_blob.bin', 'v8_context_snapshot.bin'].map(name =>
    path.join(outDir, name)
  );
  for (const bin of binaries) {
    if (!fs.existsSync(bin)) {
      throw new Error(`mksnapshot did not produce ${path.basename(bin)}`);
    }
  }
  console.log(
    `Generated ${binaries.map(b => path.basename(b)).join(', ')} in ${path.relative(
      ROOT,
      outDir
    ) || outDir}`
  );
  return binaries;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const outIdx = argv.indexOf('--out');
  const out = outIdx > -1 ? path.resolve(argv[outIdx + 1]) : undefined;
  // `--mksnapshot` runs the full pipeline through the V8 blobs; default is
  // script-only (fast, for iterating on exclusions).
  const mksnapshot = argv.includes('--mksnapshot');
  module.exports({ out, mksnapshot }).catch(error => {
    console.error(error);
    process.exit(1);
  });
}
