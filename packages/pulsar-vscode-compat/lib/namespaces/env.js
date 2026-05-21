'use strict';

const { EventEmitter } = require('../types/event-emitter');
const { Disposable } = require('../types/disposable');

const UIKind = Object.freeze({ Desktop: 1, Web: 2 });
const LogLevel = Object.freeze({ Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 });

const _sessionId = `pulsar-${Date.now()}-${Math.random().toString(36).slice(2)}`;

const _onDidChangeLogLevel = new EventEmitter();
const _onDidChangeTelemetryEnabled = new EventEmitter();
const _onDidChangeShell = new EventEmitter();

const clipboard = {
  readText() {
    return Promise.resolve(atom.clipboard.read());
  },
  writeText(value) {
    atom.clipboard.write(value);
    return Promise.resolve();
  }
};

function asExternalUri(uri) {
  return Promise.resolve(uri);
}

function openExternal(target) {
  try {
    const { shell } = require('electron');
    shell.openExternal(target.toString());
  } catch (e) {
    try { require('open')(target.toString()); } catch (e2) {}
  }
  return Promise.resolve(true);
}

function createTelemetryLogger(sender, options) {
  return {
    logUsage() {},
    logError() {},
    dispose() {}
  };
}

module.exports = {
  get appName() { return 'Pulsar'; },
  get appRoot() {
    try { return atom.getLoadSettings().resourcePath || ''; } catch (e) { return ''; }
  },
  get appHost() { return 'desktop'; },
  get appPublisher() { return 'pulsar-edit'; },
  get appVersion() {
    try { return atom.getVersion() || ''; } catch (e) { return ''; }
  },
  get clipboard() { return clipboard; },
  get language() { return (typeof navigator !== 'undefined' && navigator.language) || 'en'; },
  get logLevel() { return LogLevel.Info; },
  get machineId() {
    try {
      let id = localStorage.getItem('pulsar.machineId');
      if (!id) {
        id = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
        localStorage.setItem('pulsar.machineId', id);
      }
      return id;
    } catch (e) { return 'unknown'; }
  },
  get remoteName() { return undefined; },
  get sessionId() { return _sessionId; },
  get shell() { return process.env.SHELL || process.env.ComSpec || ''; },
  get uiKind() { return UIKind.Desktop; },
  get uriScheme() { return 'pulsar'; },
  get isNewAppInstall() { return false; },
  get isTelemetryEnabled() { return false; },
  get isAppPortable() { return false; },

  asExternalUri,
  openExternal,
  createTelemetryLogger,

  onDidChangeLogLevel: _onDidChangeLogLevel.event,
  onDidChangeTelemetryEnabled: _onDidChangeTelemetryEnabled.event,
  onDidChangeShell: _onDidChangeShell.event,

  UIKind,
  LogLevel
};
