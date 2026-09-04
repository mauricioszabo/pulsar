// `ppm dedupe` — reduces duplicate transitive dependencies in
// `node_modules`. Calls arborist's dedupe.

const path = require('path');
const yargs = require('yargs');

const paths = require('./paths');
const Command = require('./command');
const fs = require('./fs');
const arboristInstall = require('./installer/arborist-install');

module.exports =
class Dedupe extends Command {
  static commandNames = ['dedupe'];

  constructor() {
    super();
    this.atomDirectory = paths.getAtomDirectory();
    this.atomPackagesDirectory = path.join(this.atomDirectory, 'packages');
  }

  parseOptions(argv) {
    const options = yargs(argv).wrap(Math.min(100, yargs.terminalWidth()));
    options.usage(`Usage: ppm dedupe [<package_name>...]

Reduce duplication in the node_modules folder in the current directory.

This command is experimental.`);
    return options.alias('h', 'help').describe('help', 'Print this usage message');
  }

  async run(options) {
    const { cwd } = options;
    const opts = this.parseOptions(options.commandArgs);
    const dir = cwd ?? process.cwd();

    fs.makeTreeSync(this.atomDirectory);
    process.stdout.write('Deduping modules ');

    try {
      await this.loadInstalledAtomMetadata();
      const Arborist = require('@npmcli/arborist');
      const arb = new Arborist(arboristInstall.arboristOptions(dir));
      await arb.dedupe({ save: false });
      this.logSuccess();
    } catch (err) {
      this.logFailure();
      return String(err?.stack || err?.message || err);
    }
  }
};
