// Minimal .apmrc / .npmrc parser. Replaces the parts of `npm.load()` /
// `npm.config.get()` that the old ppm relied on, without pulling in the
// npm CLI as a dependency.

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

let loaded = null;

function parseIni(text) {
  const out = {};
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/^\s+|\s+$/g, '');
    if (!line || line.startsWith(';') || line.startsWith('#') || line.startsWith('[')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    out[key] = value;
  }
  return out;
}

function readIfExists(file) {
  try { return parseIni(fs.readFileSync(file, 'utf8')); }
  catch (_) { return {}; }
}

function load() {
  if (loaded) return loaded;
  // Precedence (lowest → highest): global apmrc, user apmrc, environment.
  // Matches the order npm itself would apply for these scopes.
  const global = readIfExists(paths.getGlobalConfigPath());
  const user = readIfExists(paths.getUserConfigPath());
  const env = {};
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('npm_config_')) {
      env[key.slice('npm_config_'.length).replace(/_/g, '-')] = process.env[key];
    }
  }
  loaded = { ...global, ...user, ...env };
  return loaded;
}

module.exports = {
  reset() { loaded = null; },
  load,
  get(key) { return load()[key]; },
  // Convenience helpers used by several commands.
  proxy() {
    const c = load();
    return c['https-proxy'] || c['proxy'] || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || undefined;
  },
  strictSSL() {
    const v = load()['strict-ssl'];
    return v === undefined ? true : Boolean(v);
  },
  userAgent() {
    if (load()['user-agent']) return load()['user-agent'];
    try {
      const { version } = require('../../package.json');
      return `PulsarPpm/${version}`;
    } catch (_) {
      return 'PulsarPpm/0.0.0';
    }
  }
};
