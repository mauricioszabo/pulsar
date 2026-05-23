// `ppm clean` — remove anything in node_modules that isn't a declared
// dependency. Implemented by re-reifying the current directory with
// arborist; arborist removes extraneous nodes during reify.

const path = require('path');
const yargs = require('yargs');

const Command = require('./command');
const fs = require('./fs');
const arboristInstall = require('./installer/arborist-install');

module.exports =
class Clean extends Command {
  static commandNames = ['clean', 'prune'];

  parseOptions(argv) {
    const options = yargs(argv).wrap(Math.min(100, yargs.terminalWidth()));
    options.usage(`Usage: ppm clean

Deletes all packages in the node_modules folder that are not referenced
as a dependency in the package.json file.`);
    return options.alias('h', 'help').describe('help', 'Print this usage message');
  }

  async run(_options) {
    process.stdout.write('Removing extraneous modules ');
    const cwd = process.cwd();
    if (!fs.isFileSync(path.join(cwd, 'package.json'))) {
      this.logFailure();
      return `No package.json found in ${cwd}`;
    }
    try {
      const Arborist = require('@npmcli/arborist');
      const arb = new Arborist(arboristInstall.arboristOptions(cwd));
      await arb.reify({ save: false });
      this.logSuccess();
    } catch (e) {
      this.logFailure();
      return String(e?.stack || e?.message || e);
    }
  }
};
