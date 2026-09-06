// Path utilities for the in-process package manager. Ported from
// ppm's `src/apm.js`, with the bundled-Node and npm-config dependencies
// removed — those responsibilities now live in `./npmrc.js` and we always
// run on Electron's Node.

const path = require('path');
const fs = require('fs');

let cachedResourcePath = null;

module.exports = {
  getHomeDirectory() {
    return process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME;
  },

  getAtomDirectory() {
    return process.env.ATOM_HOME ?? path.join(this.getHomeDirectory(), '.pulsar');
  },

  getRustupHomeDirPath() {
    return process.env.RUSTUP_HOME ?? path.join(this.getHomeDirectory(), '.multirust');
  },

  getCacheDirectory() {
    return path.join(this.getAtomDirectory(), '.apm');
  },

  // Best-effort resolution of the resource path of the *currently running* Pulsar.
  // When executed inside Pulsar's main process this is trivial; we keep the
  // ppm-style discovery logic as a fallback for tests/scripts that may load
  // this module outside of Electron.
  getResourcePath() {
    if (cachedResourcePath) return Promise.resolve(cachedResourcePath);
    if (process.env.ATOM_RESOURCE_PATH) {
      cachedResourcePath = process.env.ATOM_RESOURCE_PATH;
      return Promise.resolve(cachedResourcePath);
    }
    try {
      const { app } = require('electron');
      if (app && typeof app.getAppPath === 'function') {
        cachedResourcePath = app.getAppPath();
        return Promise.resolve(cachedResourcePath);
      }
    } catch (_) {}
    // Last-ditch: walk up from this file. src/ppm -> src -> repo root.
    cachedResourcePath = path.resolve(__dirname, '..', '..');
    return Promise.resolve(cachedResourcePath);
  },

  getReposDirectory() {
    return process.env.ATOM_REPOS_HOME ?? path.join(this.getHomeDirectory(), 'github');
  },

  getElectronUrl() {
    return process.env.ATOM_ELECTRON_URL ?? 'https://artifacts.electronjs.org/headers/dist';
  },

  getAtomPackagesUrl() {
    return process.env.ATOM_PACKAGES_URL ?? `${this.getAtomApiUrl()}/packages`;
  },

  getAtomApiUrl() {
    return process.env.ATOM_API_URL ?? 'https://api.pulsar-edit.dev/api';
  },

  getElectronArch() {
    return process.env.ATOM_ARCH ?? process.arch;
  },

  getUserConfigPath() {
    return path.resolve(this.getAtomDirectory(), '.apmrc');
  },

  getGlobalConfigPath() {
    return path.resolve(this.getAtomDirectory(), '.apm', '.apmrc');
  },

  isWin32() {
    return process.platform === 'win32';
  },

  x86ProgramFilesDirectory() {
    return process.env['ProgramFiles(x86)'] || process.env['ProgramFiles'];
  },

  getInstalledVisualStudioFlag() {
    if (!this.isWin32()) return null;
    if (process.env.GYP_MSVS_VERSION) return process.env.GYP_MSVS_VERSION;
    if (this.visualStudioIsInstalled('2019')) return '2019';
    if (this.visualStudioIsInstalled('2017')) return '2017';
    if (this.visualStudioIsInstalled('14.0')) return '2015';
    return undefined;
  },

  visualStudioIsInstalled(version) {
    if (Number(version) < 2017) {
      return fs.existsSync(path.join(this.x86ProgramFilesDirectory(), `Microsoft Visual Studio ${version}`, 'Common7', 'IDE'));
    }
    return ['BuildTools', 'Community', 'Enterprise', 'Professional', 'WDExpress']
      .map(t => path.join(this.x86ProgramFilesDirectory(), 'Microsoft Visual Studio', `${version}`, t, 'Common7', 'IDE'))
      .find(f => fs.existsSync(f));
  },

  setupApmRcFile() {
    try {
      fs.mkdirSync(path.dirname(this.getGlobalConfigPath()), { recursive: true });
      fs.writeFileSync(
        this.getGlobalConfigPath(),
        `; This file is auto-generated and should not be edited since any
; modifications will be lost the next time any ppm command is run.
;
; You should instead edit your .apmrc config located in ~/.pulsar/.apmrc
cache = ${this.getCacheDirectory()}
; Hide progress-bar to prevent altering ppm console output.
progress = false
`
      );
    } catch (_) {}
  }
};
