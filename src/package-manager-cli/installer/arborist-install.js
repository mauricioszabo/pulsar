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

async function installSpec(stagingDir, spec, opts = {}) {
  await ensureStaging(stagingDir);
  const Arborist = require('@npmcli/arborist');
  const arb = new Arborist(arboristOptions(stagingDir, opts));
  await arb.reify({ add: [spec], save: false });
  return stagingDir;
}

async function installDeps(packageDir, opts = {}) {
  const Arborist = require('@npmcli/arborist');
  const arb = new Arborist(arboristOptions(packageDir, opts));
  await arb.reify();
  return packageDir;
}

module.exports = { installSpec, installDeps, arboristOptions, ensureStaging };
