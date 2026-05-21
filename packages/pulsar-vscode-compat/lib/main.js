'use strict';

const Module = require('module');
const path = require('path');

const VSCODE_MODULE_KEY = '\x00pulsar-vscode-compat\x00';

let _vscodeModule = null;
let _originalResolve = null;
let _hooked = false;

module.exports = {
  activate() {
    _patchRequire();
    _initNamespaces();
  },

  deactivate() {
    _unpatchRequire();
  },

  // Service consumers
  consumeStatusBar(service) {
    require('./namespaces/window').consumeStatusBar(service);
  },

  consumeLinterIndie(registerIndie) {
    const indie = registerIndie({ name: 'VSCode Compatibility Layer' });
    require('./namespaces/languages')._setLinterIndie(indie);
  },

  consumeWatchEditor(watchEditor) {
    // Not needed; we manage editors via atom.workspace.observeTextEditors
  },

  // Service providers
  provideAutocomplete() {
    return require('./namespaces/languages')._completionProviders;
  },

  provideSymbols() {
    return require('./namespaces/languages')._symbolProviders;
  }
};

function _patchRequire() {
  if (_hooked) return;
  _hooked = true;

  _originalResolve = Module._resolveFilename;

  Module._resolveFilename = function(request, parent, isMain, options) {
    if (request === 'vscode') return VSCODE_MODULE_KEY;
    return _originalResolve.call(this, request, parent, isMain, options);
  };

  // Pre-populate the module cache
  const mod = new Module(VSCODE_MODULE_KEY, null);
  mod.exports = _getVscodeModule();
  mod.loaded = true;
  require.cache[VSCODE_MODULE_KEY] = mod;
}

function _unpatchRequire() {
  if (!_hooked) return;
  _hooked = false;
  if (_originalResolve) {
    Module._resolveFilename = _originalResolve;
    _originalResolve = null;
  }
  delete require.cache[VSCODE_MODULE_KEY];
}

function _getVscodeModule() {
  if (_vscodeModule) return _vscodeModule;
  _vscodeModule = require('./vscode');
  return _vscodeModule;
}

function _initNamespaces() {
  // Initialize event subscriptions in workspace and window namespaces
  try { require('./namespaces/workspace')._init(); } catch (e) { console.error('[vscode-compat] workspace init:', e); }
  try { require('./namespaces/window')._init(); } catch (e) { console.error('[vscode-compat] window init:', e); }
}
