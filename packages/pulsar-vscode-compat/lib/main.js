'use strict';

function _initNamespaces() {
  try { require('./namespaces/workspace')._init(); } catch (e) { console.error('[vscode-compat] workspace init:', e); }
  try { require('./namespaces/window')._init(); } catch (e) { console.error('[vscode-compat] window init:', e); }
}

module.exports = {
  activate() {
    _initNamespaces();
  },

  deactivate() {},

  // Provide the vscode module via the pulsar.api service so that
  // Module._load (patched in src/module-utils.js) can intercept require('vscode').
  providePulsarApi() {
    return {
      moduleName: 'vscode',
      score: 1,
      exportFunction: () => require('./vscode')
    };
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
