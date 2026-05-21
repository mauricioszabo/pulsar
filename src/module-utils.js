'use strict';

const Module = require('module');
const { apis, apiConsumer } = require('./services/pulsar-apis');

const originalLoad = Module._load;

// Intercept require() calls so packages can provide custom module
// implementations (e.g. 'vscode') via the pulsar.api service.
function patchRequire(globalAtom) {
  globalAtom.packages.serviceHub.consume('pulsar.api', '0.1.0', apiConsumer);

  Module._load = function(request, parent, isMain) {
    const provider = apis.get(request);
    if (provider) {
      return provider.exports !== undefined
        ? provider.exports
        : provider.exportFunction();
    }
    return originalLoad(request, parent, isMain);
  };
}

// a require function with both ES5 and ES6 default export support
function requireModule(path) {
  const modul = require(path);
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
