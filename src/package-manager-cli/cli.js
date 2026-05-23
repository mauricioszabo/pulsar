// Command dispatcher. Ported from ppm/src/apm-cli.js.
//
// Differences from the original:
//  * No `npm`, no `asar-require`, no `process.title = 'apm'`. We run
//    inside the Pulsar main process, so the title belongs to Pulsar.
//  * `printVersions` reports Electron + Pulsar version instead of the
//    bundled-Node + bundled-npm version.
//  * Command modules are loaded lazily, so a missing optional dependency
//    in one command (e.g. `plist` for `package-converter`) doesn't take
//    down the whole package manager — the breakage is scoped to that
//    one command. Same trick for `colors` and `wordwrap`: we polyfill
//    them when they're not installed so the dispatcher still works.

const path = require('path');
const yargs = require('yargs');

const paths = require('./paths');
const fs = require('./fs');
const git = require('./git');

// `colors` monkey-patches String.prototype with chainable getters. If it
// isn't installed we add no-op getters so `'foo'.green` still resolves to
// the string itself — every command file uses these expressions inline.
try {
  require('colors');
} catch (_) {
  const props = [
    'black','red','green','yellow','blue','magenta','cyan','white',
    'gray','grey','rainbow','zebra','random','disable','strip',
    'bold','underline','italic','inverse','strikethrough','reset',
    'bgBlack','bgRed','bgGreen','bgYellow','bgBlue','bgMagenta','bgCyan','bgWhite'
  ];
  for (const p of props) {
    if (!(p in String.prototype)) {
      Object.defineProperty(String.prototype, p, {
        get() { return this.toString(); },
        configurable: true
      });
    }
  }
}

// `wordwrap` is a tiny dep — fall back to a no-op if it's missing.
let wordwrap;
try { wordwrap = require('wordwrap'); }
catch (_) { wordwrap = () => (s) => s; }

// `temp` is used to make the OS tmp dir; if it's not present we skip
// the auto-cleanup. Commands that actually need temp will require it
// themselves and surface a clearer error.
try {
  const temp = require('temp');
  let tempDirectory = require('os').tmpdir();
  tempDirectory = path.resolve(fs.absolute(tempDirectory));
  temp.dir = tempDirectory;
  try { fs.makeTreeSync(temp.dir); } catch (_) {}
  temp.track();
} catch (_) {}

// Map of command name (and aliases) → factory that lazily requires the
// matching module. Loading a single command's module never triggers the
// other 26.
const commandFiles = [
  'ci', 'clean', 'config', 'dedupe', 'develop', 'disable', 'docs',
  'enable', 'featured', 'init', 'install', 'links', 'link', 'list',
  'login', 'publish', 'rebuild', 'rebuild-module-cache', 'search',
  'star', 'stars', 'test', 'uninstall', 'unlink', 'unpublish',
  'unstar', 'upgrade', 'view'
];

// Build a name→loader index without touching disk. We need the list of
// aliases for help and dispatch, but loading is deferred.
const commandLoaders = {};
const knownCommandNames = new Set();
function aliasesFor(name) {
  // Hand-rolled alias table for the few commands that expose more than
  // one name. Keeping these here avoids requiring every module just to
  // read its `commandNames` static.
  switch (name) {
    case 'install': return ['install', 'i'];
    case 'list':    return ['list', 'ls'];
    case 'clean':   return ['clean', 'prune'];
    case 'develop': return ['dev', 'develop'];
    case 'upgrade': return ['upgrade', 'outdated', 'update'];
    default: return [name];
  }
}
for (const name of commandFiles) {
  const loader = () => require(`./${name}.js`);
  for (const alias of aliasesFor(name)) {
    commandLoaders[alias] = loader;
    knownCommandNames.add(alias);
  }
}

function parseOptions(args) {
  args ??= [];
  const options = yargs(args).wrap(Math.min(100, yargs.terminalWidth()));
  options.usage(`
Pulsar Package Manager powered by https://pulsar-edit.dev

  Usage: pulsar --package <command>

  where <command> is one of:
  ${wordwrap(4, 80)(Array.from(knownCommandNames).sort().join(', '))}.

  Run \`pulsar --package help <command>\` to see more details about a specific command.`
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

function loadCommand(name) {
  const loader = commandLoaders[name];
  if (!loader) return null;
  try {
    return loader();
  } catch (e) {
    console.error(`Failed to load \`${name}\` command: ${e.message}`.red);
    return null;
  }
}

module.exports = {
  run(args, callback) {
    paths.setupApmRcFile();
    const options = parseOptions(args);

    if (!options.argv.color && String.prototype.disable) {
      // colors@1's disable() is a no-op when colors isn't loaded
      String.prototype.disable.call('');
    }

    let callbackCalled = false;
    const errorHandler = error => {
      if (callbackCalled) return;
      callbackCalled = true;
      if (error != null) {
        const message = typeof error === 'string' ? error : (error.stack || error.message || String(error));
        if (message === 'canceled') console.log();
        else if (message) console.error(message.red);
      }
      return callback?.(error);
    };

    args = options.argv;
    const { command } = options;
    try {
      if (args.version) {
        return printVersions(args).then(errorHandler, errorHandler);
      } else if (args.help) {
        const Command = loadCommand(options.command);
        if (Command) showHelp(new Command().parseOptions?.(options.command));
        else showHelp(options);
        return errorHandler();
      } else if (command) {
        if (command === 'help') {
          const helpTarget = Array.isArray(options.commandArgs) ? options.commandArgs[0] : options.commandArgs;
          const Command = loadCommand(helpTarget);
          if (Command) showHelp(new Command().parseOptions?.(helpTarget));
          else showHelp(options);
          return errorHandler();
        }
        const Command = loadCommand(command);
        if (Command) {
          const instance = new Command();
          return Promise.resolve()
            .then(() => instance.run(options))
            .then(errorHandler, errorHandler);
        }
        return errorHandler(`Unrecognized command: ${command}`);
      } else {
        showHelp(options);
        return errorHandler();
      }
    } catch (e) {
      return errorHandler(e);
    }
  }
};
