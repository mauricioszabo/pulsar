// Wraps `@npmcli/arborist` to install a single package (or a directory's
// dependencies) into a staging directory, so we don't need the `npm` CLI.
//
// Use cases:
//  * `install pulsar-clock` → resolve the registry tarball URL, then call
//    `installSpec(stagingDir, tarballUrl)`. The result lives at
//    `stagingDir/node_modules/<name>/`.
//  * `install <git-url>` → `installSpec(stagingDir, gitUrl)`; arborist
//    knows how to fetch git specs via `npm-package-arg` + `pacote`.
//  * `install` (no args, inside a package) → `installDeps(packageDir)` to
//    install whatever `package.json` declares.

const path = require('path');
const fsp = require('fs/promises');
const paths = require('../paths');
const npmrc = require('../npmrc');

function arboristOptions(dir, extra = {}) {
  return {
    path: dir,
    cache: path.join(paths.getCacheDirectory(), '_cacache'),
    registry: 'https://registry.npmjs.org/',
    fund: false,
    audit: false,
    save: false,
    omit: ['dev'],
    // `nested` keeps every dependency under its requirer's `node_modules/`
    // instead of hoisting common deps to the root. That matches what the
    // legacy ppm relied on (`npm install --global-style`) so the top-level
    // `node_modules/` of the staging dir has exactly one child — the
    // package being installed — with all of its own deps tucked inside it.
    installStrategy: 'nested',
    // Don't run install scripts by default — same posture as ppm's old
    // `--production` install, which doesn't trigger lifecycle scripts for
    // packages we don't trust.
    ignoreScripts: true,
    strictSSL: npmrc.strictSSL(),
    proxy: npmrc.proxy(),
    httpsProxy: npmrc.proxy(),
    ...extra
  };
}

async function ensureStaging(dir) {
  await fsp.mkdir(dir, { recursive: true });
  // A minimal package.json so arborist treats this as a project root.
  const pkgPath = path.join(dir, 'package.json');
  try { await fsp.access(pkgPath); }
  catch (_) {
    await fsp.writeFile(
      pkgPath,
      JSON.stringify({ name: 'pulsar-package-install-staging', version: '0.0.0', private: true }, null, 2)
    );
  }
}

// Forward `proc-log` events (which arborist and its npm-cli dependencies
// emit) onto stdout so the caller's stdout capture / progress streaming
// sees them. Installed once per process; the listener is a no-op when
// arborist isn't running.
let _procLogWired = false;
function wireProcLog() {
  if (_procLogWired) return;
  _procLogWired = true;
  // proc-log emits a single `log` event on `process` with the level as
  // its first argument. Surface the human-relevant levels and drop the
  // chatter.
  const visible = new Set(['notice', 'http', 'info', 'warn', 'error']);
  process.on('log', (level, prefix, ...rest) => {
    if (!visible.has(level)) return;
    const line = [prefix, ...rest].filter(Boolean).join(' ');
    if (line) process.stdout.write(`  ${line}\n`);
  });
}

async function installSpec(stagingDir, spec, opts = {}) {
  await ensureStaging(stagingDir);
  wireProcLog();
  const Arborist = require('@npmcli/arborist');
  const arb = new Arborist(arboristOptions(stagingDir, opts));
  await arb.reify({ add: [spec], save: false });
  return stagingDir;
}

async function installDeps(packageDir, opts = {}) {
  wireProcLog();
  const Arborist = require('@npmcli/arborist');
  const arb = new Arborist(arboristOptions(packageDir, opts));
  await arb.reify();
  return packageDir;
}

module.exports = { installSpec, installDeps, arboristOptions, ensureStaging };
