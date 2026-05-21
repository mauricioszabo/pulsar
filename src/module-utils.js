'use strict';

const path = require('path');
const Module = require('module');
const { apis, apiConsumer } = require('./services/pulsar-apis');

const originalLoad = Module._load;

// Intercept require() calls so packages can provide custom module
// implementations via the pulsar.api service, with a lazy-load fallback
// for 'vscode' that doesn't depend on ServiceHub activation order.
function patchRequire(globalAtom) {
  globalAtom.packages.serviceHub.consume('pulsar.api', '0.1.0', apiConsumer);

  let _vscodeCache = null;

  Module._load = function(request, parent, isMain) {
    // 1. Check ServiceHub-registered providers (highest priority).
    const provider = apis.get(request);
    if (provider) {
      return provider.exports !== undefined
        ? provider.exports
        : provider.exportFunction();
    }

    // 2. Lazy fallback for 'vscode': find pulsar-vscode-compat by package
    //    path and load it directly, bypassing ServiceHub timing entirely.
    if (request === 'vscode') {
      if (_vscodeCache) return _vscodeCache;
      const pkg = globalAtom.packages.getLoadedPackage('pulsar-vscode-compat');
      if (pkg) {
        try {
          _vscodeCache = originalLoad(
            path.join(pkg.path, 'lib', 'vscode.js'),
            parent,
            false
          );
          return _vscodeCache;
        } catch (e) {
          console.error('[pulsar] Failed to load vscode compat module:', e);
        }
      }
    }

    return originalLoad(request, parent, isMain);
  };
}

// a require function with both ES5 and ES6 default export support
function requireModule(modPath) {
  const modul = require(modPath);
  if (modul === null || modul === undefined) {
    return modul;
  }
  if (
    modul.__esModule === true &&
    modul.default !== undefined &&
    modul.default !== null
  ) {
    return modul.default;
  }
  return modul;
}

exports.requireModule = requireModule;
exports.patchRequire = patchRequire;
