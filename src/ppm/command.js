// Base class for ppm commands. Ported from ppm/src/command.js.
//
// Differences from the original:
//  * No `addNodeBinToEnv` — we no longer ship a separate Node binary.
//  * `loadInstalledAtomMetadata` first tries Electron's `app.getVersion()`,
//    so we always have the real running Pulsar version even when invoked
//    from a renderer via IPC.
//  * Uses `npmrc.get()` instead of `this.npm.config.get()`.

const child_process = require('child_process');
const path = require('path');
const semver = require('semver');
const paths = require('./paths');
const git = require('./git');
const npmrc = require('./npmrc');

module.exports = class Command {

  // Spawns a child process and gathers stdout/stderr into buffers (unless
  // `options.streaming` is set, in which case output is piped to the
  // parent's stdio).
  spawn(command, args, optionsOrCallback, callbackOrMissing) {
    const [callback, options] = callbackOrMissing == null
      ? [optionsOrCallback]
      : [callbackOrMissing, optionsOrCallback];

    const spawned = child_process.spawn(command, args, options);
    const errorChunks = [];
    const outputChunks = [];

    spawned.stdout.on('data', chunk => {
      if (options?.streaming) process.stdout.write(chunk);
      else outputChunks.push(chunk);
    });
    spawned.stderr.on('data', chunk => {
      if (options?.streaming) process.stderr.write(chunk);
      else errorChunks.push(chunk);
    });

    const onChildExit = errorOrExitCode => {
      spawned.removeListener('error', onChildExit);
      spawned.removeListener('close', onChildExit);
      if (typeof callback === 'function') {
        callback(errorOrExitCode, Buffer.concat(errorChunks).toString(), Buffer.concat(outputChunks).toString());
      }
    };
    spawned.on('error', onChildExit);
    spawned.on('close', onChildExit);
    return spawned;
  }

  fork(script, args, ...remaining) {
    return this.spawn(process.execPath, [script, ...args], ...remaining);
  }

  packageNamesFromArgv(argv) {
    return this.sanitizePackageNames(argv._);
  }

  sanitizePackageNames(packageNames) {
    packageNames ??= [];
    packageNames = packageNames.map(n => String(n).trim());
    return Array.from(new Set(packageNames)).filter(Boolean);
  }

  logSuccess() {
    process.stdout.write((process.platform === 'win32' ? 'done\n' : '✓\n').green);
  }

  logFailure() {
    process.stdout.write((process.platform === 'win32' ? 'failed\n' : '✗\n').red);
  }

  async logCommandResults(code, stderr, stdout) {
    stderr ??= ''; stdout ??= '';
    if (code !== 0) {
      this.logFailure();
      throw `${stdout}\n${stderr}`.trim();
    }
    this.logSuccess();
  }

  async logCommandResultsIfFail(code, stderr, stdout) {
    stderr ??= ''; stdout ??= '';
    if (code !== 0) {
      this.logFailure();
      throw `${stdout}\n${stderr}`.trim();
    }
  }

  normalizeVersion(version) {
    return typeof version === 'string' ? version.replace(/-.*$/, '') : version;
  }

  async loadInstalledAtomMetadata() {
    // When running inside Electron's main process this is the cheapest and
    // most reliable source. Falls back to reading the resourcePath's
    // package.json the way ppm used to.
    let version, electronVersion;
    try {
      const { app } = require('electron');
      if (app && typeof app.getVersion === 'function') {
        version = this.normalizeVersion(app.getVersion());
        electronVersion = process.versions.electron;
      }
    } catch (_) {}

    if (!version) {
      const resourcePath = await this.getResourcePath();
      try {
        const pkg = require(path.join(resourcePath, 'package.json'));
        version = this.normalizeVersion(pkg.version);
        electronVersion = pkg.electronVersion ?? electronVersion;
      } catch (_) {}
    }

    if (semver.valid(version)) this.installedAtomVersion = version;
    this.electronVersion = process.env.ATOM_ELECTRON_VERSION ?? electronVersion ?? process.versions.electron;
    if (!this.electronVersion) throw new Error('Could not determine Electron version');
  }

  getResourcePath() {
    if (this.resourcePath) return Promise.resolve(this.resourcePath);
    return paths.getResourcePath().then(r => (this.resourcePath = r));
  }

  // Builds the environment used when invoking native-build tooling (kept for
  // any commands that still shell out, e.g. `ppm test`). We always target
  // Electron now.
  addBuildEnvVars(env) {
    if (paths.isWin32()) git.addGitToEnv(env);
    this.addProxyToEnv(env);
    env.npm_config_runtime = 'electron';
    env.npm_config_target = this.electronVersion;
    env.npm_config_disturl = paths.getElectronUrl();
    env.npm_config_arch = paths.getElectronArch();
    env.npm_config_target_arch = paths.getElectronArch();
  }

  getNpmBuildFlags() {
    return [
      `--target=${this.electronVersion}`,
      `--disturl=${paths.getElectronUrl()}`,
      `--arch=${paths.getElectronArch()}`
    ];
  }

  addProxyToEnv(env) {
    const httpProxy = npmrc.get('proxy');
    if (httpProxy) {
      env.HTTP_PROXY ??= httpProxy;
      env.http_proxy ??= httpProxy;
    }
    const httpsProxy = npmrc.get('https-proxy');
    if (httpsProxy) {
      env.HTTPS_PROXY ??= httpsProxy;
      env.https_proxy ??= httpsProxy;
      env.HTTP_PROXY ??= httpsProxy;
      env.http_proxy ??= httpsProxy;
    }
    if (npmrc.get('strict-ssl') === false) env.NODE_TLS_REJECT_UNAUTHORIZED = 0;
  }
};
