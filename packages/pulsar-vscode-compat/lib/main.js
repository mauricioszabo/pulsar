'use strict';

function _initShims() {
  try { require('./shims/http-headers').install(); } catch (e) { console.error('[vscode-compat] http header shim init:', e); }
}

function _initNamespaces() {
  _initShims();
  try { require('./namespaces/workspace')._init(); } catch (e) { console.error('[vscode-compat] workspace init:', e); }
  try { require('./namespaces/window')._init(); } catch (e) { console.error('[vscode-compat] window init:', e); }
}

function _registerExtensionBrowser() {
  const { ExtensionBrowserView, BROWSER_URI } = require('./ui/extension-browser');

  atom.workspace.addOpener(uri => {
    if (uri === BROWSER_URI) return new ExtensionBrowserView();
  });

  atom.deserializers.add({
    name: 'PulsarVsxBrowser',
    deserialize: state => new ExtensionBrowserView(state),
  });

  atom.commands.add('atom-workspace', {
    'pulsar-vscode-compat:browse-extensions': () =>
      atom.workspace.open(BROWSER_URI),
  });
}

module.exports = {
  activate() {
    _initNamespaces();
    _registerExtensionBrowser();
  },

  deactivate() {},

  providePulsarApi() {
    return { moduleName: 'vscode', score: 1, exportFunction: () => require('./vscode') };
  },

  consumeStatusBar(service) {
    require('./namespaces/window').consumeStatusBar(service);
  },

  consumeLinterIndie(registerIndie) {
    const indie = registerIndie({ name: 'VSCode Compatibility Layer' });
    require('./namespaces/languages')._setLinterIndie(indie);
  },

  consumeWatchEditor() {},

  provideAutocomplete() {
    return require('./namespaces/languages')._completionProviders;
  },

  provideSymbols() {
    return require('./namespaces/languages')._symbolProviders;
  },
};
