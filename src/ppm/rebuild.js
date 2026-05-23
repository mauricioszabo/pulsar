// `ppm rebuild` — rebuilds native modules in the current directory's
// `node_modules/` against the running Electron's ABI via `@electron/rebuild`.

const path = require('path');
const yargs = require('yargs');

const Command = require('./command');
const fs = require('./fs');
const electronRebuild = require('./installer/electron-rebuild');

module.exports =
class Rebuild extends Command {
  static commandNames = ['rebuild'];

  parseOptions(argv) {
    const options = yargs(argv).wrap(Math.min(100, yargs.terminalWidth()));
    options.usage(`
Usage: ppm rebuild [<name> [<name> ...]]

Rebuild the given modules currently installed in the node_modules folder
in the current working directory.

All the modules will be rebuilt if no module names are specified.`
    );
    return options.alias('h', 'help').describe('help', 'Print this usage message');
  }

  async run(options) {
    options = this.parseOptions(options.commandArgs);
    const cwd = process.cwd();

    if (!fs.isDirectorySync(path.join(cwd, 'node_modules'))) {
      return `No node_modules directory found in ${cwd}`;
    }

    process.stdout.write('Rebuilding modules ');
    try {
      await this.loadInstalledAtomMetadata();
      const onlyModules = options.argv._.length ? options.argv._ : undefined;
      await electronRebuild.rebuildAll(cwd, { onlyModules, force: true });
      this.logSuccess();
    } catch (error) {
      this.logFailure();
      return String(error?.stack || error?.message || error);
    }
  }
};
