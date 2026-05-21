'use strict';

const { EventEmitter } = require('../types/event-emitter');
const { Uri } = require('../types/uri');
const path = require('path');

const _onDidChange = new EventEmitter();

function wrapPackage(pkg) {
  const meta = pkg.metadata || {};
  const pkgPath = pkg.path || '';
  return {
    id: pkg.name,
    extensionUri: Uri.file(pkgPath),
    extensionPath: pkgPath,
    isActive: pkg.isActive ? pkg.isActive() : true,
    packageJSON: meta,
    get exports() { return pkg.mainModule || null; }
  };
}

function getExtension(extensionId) {
  const pkg = atom.packages.getActivePackage(extensionId) || atom.packages.getLoadedPackage(extensionId);
  return pkg ? wrapPackage(pkg) : undefined;
}

module.exports = {
  get all() {
    return atom.packages.getActivePackages().map(wrapPackage);
  },
  getExtension,
  onDidChange: _onDidChange.event
};
