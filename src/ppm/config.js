// `ppm config get/set/delete/list/edit` — directly edits the user's
// `~/.pulsar/.apmrc` file instead of shelling out to `npm config`.

const fs = require('fs');
const path = require('path');
const yargs = require('yargs');

const paths = require('./paths');
const Command = require('./command');
const npmrc = require('./npmrc');

function parseIni(text) {
  const out = [];
  for (let line of text.split(/\r?\n/)) {
    const raw = line;
    line = line.replace(/^\s+|\s+$/g, '');
    if (!line || line.startsWith(';') || line.startsWith('#') || line.startsWith('[')) {
      out.push({ raw });
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) { out.push({ raw }); continue; }
    out.push({ raw, key: line.slice(0, eq).trim(), value: line.slice(eq + 1).trim() });
  }
  return out;
}

function serializeIni(entries) {
  return entries.map(e => (e.key ? `${e.key} = ${e.value}` : e.raw)).join('\n');
}

function readUserConfig() {
  const file = paths.getUserConfigPath();
  try { return parseIni(fs.readFileSync(file, 'utf8')); }
  catch (_) { return []; }
}

function writeUserConfig(entries) {
  const file = paths.getUserConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeIni(entries) + (entries.length ? '\n' : ''));
}

module.exports =
class Config extends Command {
  static commandNames = ['config'];

  parseOptions(argv) {
    const options = yargs(argv).wrap(Math.min(100, yargs.terminalWidth()));
    options.usage(`Usage: ppm config set <key> <value>
       ppm config get <key>
       ppm config delete <key>
       ppm config list
       ppm config edit
`);
    return options.alias('h', 'help').describe('help', 'Print this usage message');
  }

  async run(options) {
    const opts = this.parseOptions(options.commandArgs);
    const [action, key, value] = opts.argv._;

    if (action === 'get') {
      npmrc.reset();
      const v = npmrc.get(key);
      if (v !== undefined) process.stdout.write(String(v) + '\n');
      return;
    }

    if (action === 'set') {
      const entries = readUserConfig();
      const existing = entries.find(e => e.key === key);
      if (existing) existing.value = String(value);
      else entries.push({ key, value: String(value) });
      writeUserConfig(entries);
      npmrc.reset();
      return;
    }

    if (action === 'delete' || action === 'rm') {
      const entries = readUserConfig().filter(e => e.key !== key);
      writeUserConfig(entries);
      npmrc.reset();
      return;
    }

    if (action === 'list' || action === 'ls') {
      npmrc.reset();
      const cfg = npmrc.load();
      for (const k of Object.keys(cfg)) process.stdout.write(`${k} = ${cfg[k]}\n`);
      return;
    }

    if (action === 'edit') {
      const editor = process.env.EDITOR || process.env.VISUAL;
      if (!editor) return 'Set the EDITOR or VISUAL env var to edit the config file.';
      const { spawnSync } = require('child_process');
      const file = paths.getUserConfigPath();
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); if (!fs.existsSync(file)) fs.writeFileSync(file, ''); } catch (_) {}
      const r = spawnSync(editor, [file], { stdio: 'inherit', shell: true });
      if (r.status !== 0) return new Error(`Editor exited ${r.status}`);
      npmrc.reset();
      return;
    }

    return `Unknown config action: ${action}`;
  }
};
