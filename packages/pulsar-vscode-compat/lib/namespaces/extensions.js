'use strict';

const { EventEmitter } = require('../types/event-emitter');
const { Uri } = require('../types/uri');
const fs = require('fs');
const path = require('path');

const _onDidChange = new EventEmitter();

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function originalExtensionManifest(pkgPath, wrapperManifest) {
  const nestedPath = path.join(pkgPath || '', 'extension', 'package.json');
  const nestedManifest = readJsonIfExists(nestedPath);
  if (nestedManifest) {
    return {
      packageJSON: nestedManifest,
      extensionPath: path.dirname(nestedPath)
    };
  }

  return {
    packageJSON: wrapperManifest,
    extensionPath: pkgPath
  };
}

function wrapPackage(pkg) {
  const meta = pkg.metadata || {};
  const pkgPath = pkg.path || '';
  const original = originalExtensionManifest(pkgPath, meta);
  const packageJSON = original.packageJSON || meta;
  const extensionPath = original.extensionPath || pkgPath;
  return {
    id: (packageJSON.publisher && packageJSON.name ? `${packageJSON.publisher}.${packageJSON.name}` : null) ||
      (meta._vscodeExtension && meta._vscodeExtension.id) ||
      pkg.name,
    extensionUri: Uri.file(extensionPath),
    extensionPath,
    isActive: pkg.isActive ? pkg.isActive() : true,
    packageJSON,
    get exports() { return pkg.mainModule || null; },
    activate() { return Promise.resolve(this.exports); }
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
