'use strict';

const { Disposable } = require('event-kit');

// Registry of module name → provider. Only the highest-score provider wins.
const apis = new Map();

function apiConsumer(provider) {
  const existing = apis.get(provider.moduleName);
  if (existing && existing.score > (provider.score || 0)) {
    return new Disposable(() => {});
  }
  provider.score = provider.score || 0;
  apis.set(provider.moduleName, provider);
  return new Disposable(() => {
    if (apis.get(provider.moduleName) === provider) {
      apis.delete(provider.moduleName);
    }
    if (provider.dispose) provider.dispose();
  });
}

module.exports = { apis, apiConsumer };
