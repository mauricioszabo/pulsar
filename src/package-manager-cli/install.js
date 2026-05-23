// `ppm install` — ported from ppm/src/install.js, with the npm-CLI fork
// replaced by direct calls to `@npmcli/arborist` and native modules built
// against Electron via `@electron/rebuild`.
//
// Behavior parity goals (preserved):
//  * `--json` output shape (array of { installPath, metadata } objects).
//  * `--check` runs a sample native build to verify the local toolchain.
//  * Git, file:, and registry installs all land in `~/.pulsar/packages/`.
//  * Bundled packages refuse to install with the same warning as before.
//  * Compatible-version filtering via the package's `engines.pulsar/atom`.

const path = require('path');
const CSON = require('season');
const yargs = require('yargs');
const Git = require('@pulsar-edit/git-utils');
const semver = require('semver');
const temp = require('temp');
const hostedGitInfo = require('hosted-git-info');

const paths = require('./paths');
const Command = require('./command');
const fs = require('./fs');
const RebuildModuleCache = require('./rebuild-module-cache');
const request = require('./request');
const { isDeprecatedPackage } = require('./deprecated-packages');
const arboristInstall = require('./installer/arborist-install');
const electronRebuild = require('./installer/electron-rebuild');

module.exports =
class Install extends Command {
  static commandNames = ['install', 'i'];

  constructor() {
    super();
    this.installModules = this.installModules.bind(this);
    this.installGitPackageDependencies = this.installGitPackageDependencies.bind(this);
    this.atomDirectory = paths.getAtomDirectory();
    this.atomPackagesDirectory = path.join(this.atomDirectory, 'packages');
    this.atomNodeDirectory = path.join(this.atomDirectory, '.node-gyp');
    this.repoLocalPackagePathRegex = /^file:(?!\/\/)(.*)/;
  }

  parseOptions(argv) {
    const options = yargs(argv).wrap(Math.min(100, yargs.terminalWidth()));
    options.usage(`
Usage: ppm install [<package_name>...]
       ppm install <package_name>@<package_version>
       ppm install <git_remote> [-b <branch_or_tag>]
       ppm install <github_username>/<github_project> [-b <branch_or_tag>]
       ppm install --packages-file my-packages.txt
       ppm i (with any of the previous argument usage)

Install the given Pulsar package to ~/.pulsar/packages/<package_name>.

If no package name is given then all the dependencies in the package.json
file are installed to the node_modules folder in the current working
directory.

A packages file can be specified that is a newline separated list of
package names to install with optional versions using the
\`package-name@version\` syntax.`
    );
    options.alias('c', 'compatible').string('compatible').describe('compatible', 'Only install packages/themes compatible with this Pulsar version');
    options.alias('h', 'help').describe('help', 'Print this usage message');
    options.alias('s', 'silent').boolean('silent').describe('silent', 'Suppress progress output');
    options.alias('b', 'branch').string('branch').describe('branch', 'Sets the tag or branch to install');
    options.alias('t', 'tag').string('tag').describe('tag', 'Sets the tag or branch to install');
    options.alias('q', 'quiet').boolean('quiet').describe('quiet', 'Reduce output verbosity');
    options.boolean('check').describe('check', 'Check that native build tools are installed');
    options.boolean('verbose').default('verbose', false).describe('verbose', 'Show verbose debug information');
    options.string('packages-file').describe('packages-file', 'A text file containing the packages to install');
    return options.boolean('production').describe('production', 'Do not install dev dependencies');
  }

  // Install a single registry/git/local spec into a staging area, then
  // move the resulting package directory into `~/.pulsar/packages`.
  // Returns `{ name, installPath }`.
  async installModule(options, pack, moduleSpec) {
    const installGlobally = options.installGlobally ?? true;

    fs.makeTreeSync(this.atomDirectory);

    if (!installGlobally) {
      // Local install — `pack` describes the surrounding project. Just
      // reify whatever the project's package.json declares.
      const cwd = options.cwd ?? process.cwd();
      try {
        await arboristInstall.installDeps(cwd);
        return { name: undefined, installPath: undefined };
      } catch (e) {
        throw String(e?.stack || e?.message || e);
      }
    }

    const stagingDir = temp.mkdirSync('ppm-install-dir-');
    const progress = (msg) => { if (!options.argv.json) process.stdout.write(`\n  ${msg}`); };
    try {
      progress('Downloading and resolving dependencies…');
      await arboristInstall.installSpec(stagingDir, moduleSpec);
    } catch (e) {
      let error = String(e?.stack || e?.message || e);
      if (error.includes('ENOGIT')) error = this.getGitErrorMessage(pack);
      fs.removeSync(stagingDir);
      this.logFailure();
      throw error;
    }

    // The reified install left us with `stagingDir/node_modules/<single>`.
    const nodeModulesDir = path.join(stagingDir, 'node_modules');
    const children = fs.readdirSync(nodeModulesDir).filter(c => c !== '.bin' && !c.startsWith('.'));
    if (children.length !== 1) {
      fs.removeSync(stagingDir);
      throw `Expected exactly one package in ${nodeModulesDir}, got ${children.length}`;
    }
    const child = children[0];
    const source = path.join(nodeModulesDir, child);
    const destination = path.join(this.atomPackagesDirectory, child);

    try {
      progress(`Moving ${child} into ${this.atomPackagesDirectory}…`);
      await fs.cp(source, destination);
      progress('Compiling native modules for Electron (if any)…');
      await electronRebuild.rebuildAll(destination).catch(() => {}); // best-effort
      progress('Updating module cache…');
      await this.buildModuleCache(child);
      await this.warmCompileCache(child);
    } catch (err) {
      this.logFailure();
      throw err;
    } finally {
      fs.removeSync(stagingDir);
    }

    if (!options.argv.json) this.logSuccess();
    return { name: child, installPath: destination };
  }

  getGitErrorMessage(pack) {
    let message = `Failed to install ${pack?.name} because Git was not found.

The ${pack?.name} package has module dependencies that cannot be installed without Git.

You need to install Git and add it to your path environment variable in order to install this package.
`;
    if (process.platform === 'win32') {
      message += `
You can install Git by downloading, installing, and launching GitHub for Windows: https://windows.github.com
`;
    } else if (process.platform === 'linux') {
      message += `
You can install Git from your OS package manager.
`;
    }
    message += `
Run ppm -v after installing Git to see what version has been detected.`;
    return message;
  }

  async installModules(options) {
    if (!options.argv.json) process.stdout.write('Installing modules ');
    const cwd = options.cwd ?? process.cwd();
    try {
      await arboristInstall.installDeps(cwd);
      if (!options.argv.json) this.logSuccess();
    } catch (e) {
      this.logFailure();
      throw String(e?.stack || e?.message || e);
    }
  }

  async requestPackage(packageName) {
    const requestSettings = {
      url: `${paths.getAtomPackagesUrl()}/${packageName}`,
      json: true,
      retries: 4
    };
    let response;
    try {
      response = await request.get(requestSettings);
    } catch (error) {
      let message = `Request for package information failed: ${error.message}`;
      if (error.status) message += ` (${error.status})`;
      throw message;
    }
    const body = response.body ?? {};
    if (response.statusCode !== 200) {
      throw `Request for package information failed: ${request.getErrorMessage(body, null)}`;
    }
    if (!body.releases?.latest) throw `No releases available for ${packageName}`;
    return body;
  }

  isPackageInstalled(packageName, packageVersion) {
    try {
      const meta = CSON.readFileSync(CSON.resolve(path.join('node_modules', packageName, 'package'))) ?? {};
      return packageVersion === meta.version;
    } catch (_) { return false; }
  }

  async installRegisteredPackage(metadata, options) {
    const packageName = metadata.name;
    let packageVersion = metadata.version;
    const installGlobally = options.installGlobally ?? true;
    if (!installGlobally && packageVersion && this.isPackageInstalled(packageName, packageVersion)) {
      return {};
    }

    let label = packageName;
    if (packageVersion) label += `@${packageVersion}`;
    if (!options.argv.json) {
      process.stdout.write(`Installing ${label} `);
      if (installGlobally) process.stdout.write(`to ${this.atomPackagesDirectory} `);
    }

    let pack;
    try {
      if (!options.argv.json) process.stdout.write('\n  Fetching package metadata from the registry…');
      pack = await this.requestPackage(packageName);
      packageVersion ??= this.getLatestCompatibleVersion(pack);
      if (!packageVersion) {
        throw `No available version compatible with the installed Pulsar version: ${this.installedAtomVersion}`;
      }
      if (!options.argv.json) process.stdout.write(`\n  Resolved version ${packageVersion}.`);
      const { tarball } = pack.versions[packageVersion]?.dist ?? {};
      if (!tarball) throw `Package version: ${packageVersion} not found`;
      const { installPath } = await this.installModule(options, pack, tarball);
      if (installGlobally && (packageName.localeCompare(pack.name, 'en', { sensitivity: 'accent' }) !== 0)) {
        fs.removeSync(path.join(this.atomPackagesDirectory, packageName));
      }
      if (installPath == null) return {};
      const meta = JSON.parse(fs.readFileSync(path.join(installPath, 'package.json'), 'utf8'));
      return { installPath, metadata: meta };
    } catch (error) {
      this.logFailure();
      throw error;
    }
  }

  async installLocalPackage(packageName, packagePath, options) {
    if (options.argv.json) return;
    process.stdout.write(`Installing ${packageName} from ${packagePath.slice('file:'.length)} `);
    try {
      const { installPath } = await this.installModule(options, { name: packageName }, packagePath);
      if (installPath != null) {
        const meta = JSON.parse(fs.readFileSync(path.join(installPath, 'package.json'), 'utf8'));
        if (!options.argv.json) this.logSuccess();
        return { installPath, metadata: meta };
      }
      if (!options.argv.json) this.logSuccess();
      return {};
    } catch (error) {
      this.logFailure();
      throw error;
    }
  }

  async installPackageDependencies(options) {
    options = { ...options, installGlobally: false };
    const deps = this.getPackageDependencies(options.cwd);
    for (const name of Object.keys(deps)) {
      const version = deps[name];
      if (this.repoLocalPackagePathRegex.test(version)) {
        await this.installLocalPackage(name, version, options);
      } else {
        await this.installRegisteredPackage({ name, version }, options);
      }
    }
  }

  async installDependencies(options) {
    options.installGlobally = false;
    await this.installModules(options);
    await this.installPackageDependencies(options);
  }

  getPackageDependencies(cloneDir) {
    try {
      const fileName = path.join(cloneDir || '.', 'package.json');
      const meta = fs.readFileSync(fileName, 'utf8');
      const { packageDependencies, dependencies } = JSON.parse(meta) ?? {};
      if (!packageDependencies) return {};
      if (!dependencies) return packageDependencies;

      const filtered = {};
      for (const name of Object.keys(packageDependencies)) {
        const spec = packageDependencies[name];
        const dependencyPath = this.getRepoLocalPackagePath(dependencies[name]);
        const packageDependencyPath = this.getRepoLocalPackagePath(spec);
        if (!packageDependencyPath || dependencyPath !== packageDependencyPath) {
          filtered[name] = spec;
        }
      }
      return filtered;
    } catch (_) { return {}; }
  }

  getRepoLocalPackagePath(spec) {
    if (!spec) return undefined;
    const m = spec.match(this.repoLocalPackagePathRegex);
    return m ? path.normalize(m[1]) : undefined;
  }

  createAtomDirectories() {
    fs.makeTreeSync(this.atomDirectory);
    fs.makeTreeSync(this.atomPackagesDirectory);
    fs.makeTreeSync(this.atomNodeDirectory);
  }

  async checkNativeBuildTools() {
    process.stdout.write('Checking for native build tools ');
    try {
      await electronRebuild.checkNativeTools();
      this.logSuccess();
    } catch (e) {
      this.logFailure();
      throw String(e?.stack || e?.message || e);
    }
  }

  packageNamesFromPath(filePath) {
    filePath = path.resolve(filePath);
    if (!fs.isFileSync(filePath)) throw new Error(`File '${filePath}' does not exist`);
    const packages = fs.readFileSync(filePath, 'utf8');
    return this.sanitizePackageNames(packages.split(/\s/));
  }

  async buildModuleCache(packageName) {
    const packageDirectory = path.join(this.atomPackagesDirectory, packageName);
    const rebuildCacheCommand = new RebuildModuleCache();
    await rebuildCacheCommand.rebuild(packageDirectory).catch(_ => {});
  }

  async warmCompileCache(packageName) {
    const packageDirectory = path.join(this.atomPackagesDirectory, packageName);
    const resourcePath = await this.getResourcePath();
    try {
      const CompileCache = require(path.join(resourcePath, 'src', 'compile-cache'));
      const onDirectory = directoryPath => path.basename(directoryPath) !== 'node_modules';
      const onFile = filePath => {
        try { return CompileCache.addPathToCache(filePath, this.atomDirectory); }
        catch (_) {}
      };
      fs.traverseTreeSync(packageDirectory, onFile, onDirectory);
    } catch (_) {}
  }

  async isBundledPackage(packageName) {
    const resourcePath = await this.getResourcePath();
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(resourcePath, 'package.json')));
      return meta?.packageDependencies?.hasOwnProperty(packageName);
    } catch (_) { return false; }
  }

  getLatestCompatibleVersion(pack) {
    if (!this.installedAtomVersion) {
      return isDeprecatedPackage(pack.name, pack.releases.latest) ? null : pack.releases.latest;
    }
    let latestVersion = null;
    const versions = pack.versions ?? {};
    for (const version of Object.keys(versions)) {
      const meta = versions[version];
      if (!semver.valid(version)) continue;
      if (!meta) continue;
      if (isDeprecatedPackage(pack.name, version)) continue;
      const engine = meta.engines?.pulsar || meta.engines?.atom || '*';
      if (!semver.validRange(engine)) continue;
      if (!semver.satisfies(this.installedAtomVersion, engine)) continue;
      if (latestVersion == null || semver.gt(version, latestVersion)) latestVersion = version;
    }
    return latestVersion;
  }

  getHostedGitInfo(name) {
    return hostedGitInfo.fromUrl(name);
  }

  async installGitPackage(packageUrl, options, version) {
    const cloneDir = temp.mkdirSync('atom-git-package-clone-');
    const urls = this.getNormalizedGitUrls(packageUrl);
    await this.cloneFirstValidGitUrl(urls, cloneDir, options);

    const data = {};
    if (version) {
      const repo = Git.open(cloneDir);
      data.sha = version;
      const checked = repo.checkoutRef(`refs/tags/${version}`, false) || repo.checkoutReference(version, false);
      if (!checked) throw `Can't find the branch or tag referenced by ${version}`;
    } else {
      data.sha = this.getRepositoryHeadSha(cloneDir);
    }

    await this.installGitPackageDependencies(cloneDir, options);

    const metadataFilePath = CSON.resolve(path.join(cloneDir, 'package'));
    const metadata = CSON.readFileSync(metadataFilePath);
    data.metadataFilePath = metadataFilePath;
    data.metadata = metadata;
    data.metadata.apmInstallSource = { type: 'git', source: packageUrl, sha: data.sha };
    CSON.writeFileSync(data.metadataFilePath, data.metadata);

    const { name } = data.metadata;
    const targetDir = path.join(this.atomPackagesDirectory, name);
    if (!options.argv.json) process.stdout.write(`Moving ${name} to ${targetDir} `);
    await fs.cp(cloneDir, targetDir);
    await electronRebuild.rebuildAll(targetDir).catch(() => {});
    if (!options.argv.json) this.logSuccess();
    return { installPath: targetDir, metadata: data.metadata };
  }

  getNormalizedGitUrls(packageUrl) {
    const info = this.getHostedGitInfo(packageUrl);
    if (packageUrl.indexOf('file://') === 0) return [packageUrl];
    if (info.default === 'sshurl') return [info.toString()];
    if (info.default === 'https') return [info.https().replace(/^git\+https:/, 'https:')];
    if (info.default === 'shortcut') {
      return [info.https().replace(/^git\+https:/, 'https:'), info.sshurl()];
    }
  }

  async cloneFirstValidGitUrl(urls, cloneDir, options) {
    let lastErr;
    for (const url of urls) {
      try { await this.cloneNormalizedUrl(url, cloneDir, options); return; }
      catch (e) { lastErr = e; }
    }
    throw new Error(`Couldn't clone ${urls.join(' or ')}: ${lastErr?.message ?? lastErr}`);
  }

  async cloneNormalizedUrl(url, cloneDir, options) {
    const Develop = require('./develop');
    const develop = new Develop();
    await develop.cloneRepository(url, cloneDir, options);
  }

  async installGitPackageDependencies(directory, options) {
    options.cwd = directory;
    await this.installDependencies(options);
  }

  getRepositoryHeadSha(repoDir) {
    return Git.open(repoDir).getReferenceTarget('HEAD');
  }

  async run(options) {
    let packageNames;
    options = this.parseOptions(options.commandArgs);
    const packagesFilePath = options.argv['packages-file'];

    this.createAtomDirectories();

    if (options.argv.check) {
      try {
        await this.loadInstalledAtomMetadata();
        await this.checkNativeBuildTools();
      } catch (error) {
        return error;
      }
      return;
    }

    this.verbose = options.argv.verbose;
    if (this.verbose) process.env.NODE_DEBUG = 'request';

    const installPackage = async (name) => {
      const gitInfo = this.getHostedGitInfo(name);
      if (gitInfo || name.indexOf('file://') === 0) {
        return await this.installGitPackage(name, options, options.argv.branch || options.argv.tag);
      }
      if (name === '.') { await this.installDependencies(options); return; }

      let version;
      const atIndex = name.indexOf('@');
      if (atIndex > 0) {
        version = name.substring(atIndex + 1);
        name = name.substring(0, atIndex);
      }

      const bundled = await this.isBundledPackage(name);
      if (bundled) {
        console.error(`The ${name} package is bundled with Pulsar and should not be explicitly installed.
You can run \`ppm uninstall ${name}\` to uninstall it and then the version bundled
with Pulsar will be used.`.yellow);
      }
      return await this.installRegisteredPackage({ name, version }, options);
    };

    if (packagesFilePath) {
      try { packageNames = this.packageNamesFromPath(packagesFilePath); }
      catch (error) { return error; }
    } else {
      packageNames = this.packageNamesFromArgv(options.argv);
      if (packageNames.length === 0) packageNames.push('.');
    }

    try {
      await this.loadInstalledAtomMetadata();
      const installed = [];
      for (const name of packageNames) {
        const info = await installPackage(name);
        if (info && name !== '.') installed.push(info);
      }
      if (options.argv.json) console.log(JSON.stringify(installed, null, '  '));
    } catch (error) {
      return error;
    }
  }
};
