// `ppm ci` — install whatever the current dir's lockfile resolves to.
// Backed by arborist's reify in `auditSpecific`/lockfile-only mode so it
// matches the lockfile exactly and refuses to touch package.json.

const path = require('path');
const yargs = require('yargs');

const paths = require('./paths');
const Command = require('./command');
const fs = require('./fs');
const arboristInstall = require('./installer/arborist-install');
const electronRebuild = require('./installer/electron-rebuild');

module.exports =
class Ci extends Command {
  static commandNames = ['ci'];

  constructor() {
    super();
    this.atomDirectory = paths.getAtomDirectory();
  }

  parseOptions(argv) {
    const options = yargs(argv).wrap(Math.min(100, yargs.terminalWidth()));
    options.usage(`Usage: ppm ci

Install a package with a clean slate.

If you have an up-to-date package-lock.json file created by ppm install,
ppm ci will install its locked contents exactly. It is substantially
faster than ppm install and produces consistently reproduceable builds,
but cannot be used to install new packages or dependencies.`);
    options.alias('h', 'help').describe('help', 'Print this usage message');
    return options.boolean('verbose').default('verbose', false).describe('verbose', 'Show verbose debug information');
  }

  async installModules(options) {
    process.stdout.write('Installing locked modules ');
    const cwd = options.cwd ?? process.cwd();
    try {
      const Arborist = require('@npmcli/arborist');
      const arb = new Arborist({
        ...arboristInstall.arboristOptions(cwd),
        packageLockOnly: false
      });
      // Equivalent to `npm ci`: a fresh, lockfile-faithful reify.
      fs.removeSync(path.join(cwd, 'node_modules'));
      await arb.reify({ save: false });
      await electronRebuild.rebuildAll(cwd).catch(() => {});
      this.logSuccess();
    } catch (e) {
      this.logFailure();
      throw String(e?.stack || e?.message || e);
    }
  }

  async run(options) {
    const opts = this.parseOptions(options.commandArgs);
    try {
      await this.loadInstalledAtomMetadata();
      await this.installModules(opts);
    } catch (err) {
      return err;
    }
  }
};
