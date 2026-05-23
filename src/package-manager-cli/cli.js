// Command dispatcher. Ported from ppm/src/apm-cli.js.
//
// Differences:
//  * No `npm`, no `asar-require`, no `process.title = 'apm'`. We run inside
//    the Pulsar main process, so the title belongs to Pulsar.
//  * `printVersions` reports the Electron Node + Pulsar version instead of
//    the bundled-Node + bundled-npm version.

const path = require('path');
const colors = require('colors');
const yargs = require('yargs');
const wordwrap = require('wordwrap');

const paths = require('./paths');
const fs = require('./fs');
const git = require('./git');

function setupTempDirectory() {
  const temp = require('temp');
  let tempDirectory = require('os').tmpdir();
  tempDirectory = path.resolve(fs.absolute(tempDirectory));
  temp.dir = tempDirectory;
  try { fs.makeTreeSync(temp.dir); } catch (_) {}
  return temp.track();
}
setupTempDirectory();

const commandClasses = [
  require('./ci.js'),
  require('./clean.js'),
  require('./config.js'),
  require('./dedupe.js'),
  require('./develop.js'),
  require('./disable.js'),
  require('./docs.js'),
  require('./enable.js'),
  require('./featured.js'),
  require('./init.js'),
  require('./install.js'),
  require('./links.js'),
  require('./link.js'),
  require('./list.js'),
  require('./login.js'),
  require('./publish.js'),
  require('./rebuild.js'),
  require('./rebuild-module-cache.js'),
  require('./search.js'),
  require('./star.js'),
  require('./stars.js'),
  require('./test.js'),
  require('./uninstall.js'),
  require('./unlink.js'),
  require('./unpublish.js'),
  require('./unstar.js'),
  require('./upgrade.js'),
  require('./view.js')
];

const commands = {};
for (const commandClass of commandClasses) {
  for (const name of commandClass.commandNames ?? []) {
    commands[name] = commandClass;
  }
}

function parseOptions(args) {
  args ??= [];
  const options = yargs(args).wrap(Math.min(100, yargs.terminalWidth()));
  options.usage(`
Pulsar Package Manager powered by https://pulsar-edit.dev

  Usage: pulsar --package <command>

  where <command> is one of:
  ${wordwrap(4, 80)(Object.keys(commands).sort().join(', '))}.

  Run \`pulsar --package help <command>\` to see the more details about a specific command.`
  );
  options.alias('v', 'version').describe('version', 'Print the ppm version');
  options.alias('h', 'help').describe('help', 'Print this usage message');
  options.boolean('color').default('color', true).describe('color', 'Enable colored output');
  options.command = options.argv._[0];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === options.command) {
      options.commandArgs = args.slice(index + 1);
      break;
    }
  }
  return options;
}

function showHelp(options) {
  if (options == null) return;
  let help = options.help();
  if (help.indexOf('Options:') >= 0) {
    help += '\n  Prefix an option with `no-` to set it to false such as --no-color to disable';
    help += '\n  colored output.';
  }
  console.error(help);
}

async function printVersions(args) {
  const ppmVersion = await getPulsarVersion();
  const pulsarVersion = ppmVersion;
  const nodeVersion = process.versions.node ?? '';
  const electronVersion = process.versions.electron ?? '';
  const pythonVersion = (await getPythonVersion()) ?? '';
  const gitVersion = (await git.getGitVersion()) ?? '';

  if (args.json) {
    const versions = {
      apm: ppmVersion, ppm: ppmVersion,
      node: nodeVersion, electron: electronVersion,
      atom: pulsarVersion, pulsar: pulsarVersion,
      python: pythonVersion, git: gitVersion,
      nodeArch: process.arch
    };
    if (paths.isWin32()) versions.visualStudio = paths.getInstalledVisualStudioFlag();
    console.log(JSON.stringify(versions));
    return;
  }

  let out =
    `${'ppm'.red}      ${ppmVersion.red}\n` +
    `${'node'.blue}     ${nodeVersion.blue} ${process.arch.blue}\n` +
    `${'electron'.blue} ${electronVersion.blue}\n` +
    `${'pulsar'.cyan}   ${pulsarVersion.cyan}\n` +
    `${'python'.yellow}   ${pythonVersion.yellow}\n` +
    `${'git'.magenta}      ${gitVersion.magenta}`;
  if (paths.isWin32()) out += `\n${'visual studio'.cyan} ${(paths.getInstalledVisualStudioFlag() ?? '').cyan}`;
  console.log(out);
}

async function getPulsarVersion() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getVersion === 'function') return app.getVersion();
  } catch (_) {}
  try {
    const resourcePath = await paths.getResourcePath();
    return require(path.join(resourcePath, 'package.json')).version ?? 'unknown';
  } catch (_) { return 'unknown'; }
}

function getPythonVersion() {
  return new Promise((resolve) => {
    const npmrc = require('./npmrc');
    let python = npmrc.get('python') ?? process.env.PYTHON;
    if (paths.isWin32() && !python) {
      let rootDir = process.env.SystemDrive ?? 'C:\\';
      if (rootDir[rootDir.length - 1] !== '\\') rootDir += '\\';
      const pythonExe = path.resolve(rootDir, 'Python27', 'python.exe');
      if (fs.isFileSync(pythonExe)) python = pythonExe;
    }
    python ??= 'python';
    const { spawn } = require('child_process');
    const spawned = spawn(python, ['--version']);
    const chunks = [];
    spawned.stderr.on('data', c => chunks.push(c));
    spawned.stdout.on('data', c => chunks.push(c));
    spawned.on('error', () => resolve(undefined));
    spawned.on('close', code => {
      if (code !== 0) return resolve(undefined);
      const parts = Buffer.concat(chunks).toString().split(' ');
      resolve(parts[1]?.trim());
    });
  });
}

module.exports = {
  run(args, callback) {
    let Command;
    paths.setupApmRcFile();
    const options = parseOptions(args);

    if (!options.argv.color) colors.disable();

    let callbackCalled = false;
    const errorHandler = error => {
      if (callbackCalled) return;
      callbackCalled = true;
      if (error != null) {
        const message = typeof error === 'string' ? error : error.message ?? String(error);
        if (message === 'canceled') console.log();
        else if (message) console.error(message.red);
      }
      return callback?.(error);
    };

    args = options.argv;
    const { command } = options;
    if (args.version) {
      return printVersions(args).then(errorHandler);
    } else if (args.help) {
      if (commands[options.command]) {
        Command = commands[options.command];
        showHelp(new Command().parseOptions?.(options.command));
      } else {
        showHelp(options);
      }
      return errorHandler();
    } else if (command) {
      if (command === 'help') {
        if (commands[options.commandArgs]) {
          Command = commands[options.commandArgs];
          showHelp(new Command().parseOptions?.(options.commandArgs));
        } else {
          showHelp(options);
        }
        return errorHandler();
      } else if ((Command = commands[command])) {
        const instance = new Command();
        return Promise.resolve(instance.run(options)).then(errorHandler).catch(errorHandler);
      } else {
        return errorHandler(`Unrecognized command: ${command}`);
      }
    } else {
      showHelp(options);
      return errorHandler();
    }
  }
};
