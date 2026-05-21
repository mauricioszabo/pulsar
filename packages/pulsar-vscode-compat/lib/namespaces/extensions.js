'use strict';

const { EventEmitter } = require('../types/event-emitter');
const { Uri } = require('../types/uri');
const path = require('path');

const _onDidChange = new EventEmitter();

function wrapPackage(pkg) {
  const meta = pkg.metadata || {};
  const pkgPath = pkg.path || '';
  return {
    id: (meta._vscodeExtension && meta._vscodeExtension.id) || pkg.name,
    extensionUri: Uri.file(pkgPath),
    extensionPath: pkgPath,
    isActive: pkg.isActive ? pkg.isActive() : true,
    packageJSON: meta,
    get exports() { return pkg.mainModule || null; }
  };
}

function allPackages() {
  const packages = [];
  try { packages.push(...atom.packages.getActivePackages()); } catch (e) {}
  try {
    for (const pkg of atom.packages.getLoadedPackages()) {
      if (!packages.includes(pkg)) packages.push(pkg);
    }
  } catch (e) {}
  return packages;
}

function packageMatchesExtensionId(pkg, extensionId) {
  const meta = pkg.metadata || {};
  return pkg.name === extensionId ||
    (meta._vscodeExtension && meta._vscodeExtension.id === extensionId);
}

function getExtension(extensionId) {
  let pkg;
  try { pkg = atom.packages.getActivePackage(extensionId); } catch (e) {}
  if (!pkg) {
    try { pkg = atom.packages.getLoadedPackage(extensionId); } catch (e) {}
  }
  if (!pkg) pkg = allPackages().find(candidate => packageMatchesExtensionId(candidate, extensionId));
  return pkg ? wrapPackage(pkg) : undefined;
}

module.exports = {
  get all() {
    return allPackages().map(wrapPackage);
  },
  getExtension,
  onDidChange: _onDidChange.event
};
