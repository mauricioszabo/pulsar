// Wraps `@electron/rebuild` so native modules in a freshly-installed package
// are compiled against the currently running Electron's ABI. Replaces the
// `npm rebuild` invocation that ppm used to do via its bundled Node.

const path = require('path');

function detectElectronTarget() {
  // Inside Pulsar's main process this is exact. When called from contexts
  // without Electron (tests, scripts) we read it from the host package.json.
  if (process.versions.electron) {
    return { version: process.versions.electron, arch: process.arch };
  }
  try {
    const pkg = require('../../../package.json');
    return { version: pkg.electronVersion, arch: process.arch };
  } catch (_) {
    return { version: undefined, arch: process.arch };
  }
}

async function rebuildAll(packageDir, opts = {}) {
  const { rebuild } = require('@electron/rebuild');
  const { version, arch } = detectElectronTarget();
  if (!version) throw new Error('Could not determine Electron version for native rebuild');
  return rebuild({
    buildPath: packageDir,
    electronVersion: version,
    arch,
    force: opts.force ?? false,
    mode: opts.mode ?? 'sequential',
    types: ['prod', 'optional'],
    parallel: opts.parallel ?? 1
  });
}

// Run a tiny sample build to confirm native build tools are present.
async function checkNativeTools() {
  const sampleDir = path.resolve(__dirname, '..', 'native-module');
  await rebuildAll(sampleDir, { force: true });
}

module.exports = { rebuildAll, checkNativeTools, detectElectronTarget };
