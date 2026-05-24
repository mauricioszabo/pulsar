'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Uri } = require('./uri');

class Memento {
  constructor(storage) {
    this._storage = storage || {};
  }
  get(key, defaultValue) {
    return this._storage[key] !== undefined ? this._storage[key] : defaultValue;
  }
  update(key, value) {
    this._storage[key] = value;
    return Promise.resolve();
  }
  keys() { return Object.keys(this._storage); }
  setKeysForSync(keys) {}
}

class SecretStorage {
  constructor() { this._map = new Map(); }
  get(key) { return Promise.resolve(this._map.get(key)); }
  store(key, value) { this._map.set(key, value); return Promise.resolve(); }
  delete(key) { this._map.delete(key); return Promise.resolve(); }
  onDidChange(listener) { return { dispose() {} }; }
}

class EnvironmentVariableCollection {
  constructor() { this._map = new Map(); this.persistent = true; this.description = undefined; }
  replace(variable, value) { this._map.set(variable, { value, type: 0 }); }
  append(variable, value) { this._map.set(variable, { value, type: 1 }); }
  prepend(variable, value) { this._map.set(variable, { value, type: 2 }); }
  get(variable) { return this._map.get(variable); }
  forEach(fn, thisArg) { this._map.forEach((entry, variable) => fn.call(thisArg, variable, entry, this)); }
  delete(variable) { this._map.delete(variable); }
  clear() { this._map.clear(); }
  [Symbol.iterator]() { return this._map.entries(); }
  getScoped() { return new EnvironmentVariableCollection(); }
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function findPackageJsonForExtensionPath(extensionPath) {
  // VSIX wrapper packages keep the original VSCode extension under
  // <pulsar-package>/extension. VSCode's Extension.packageJSON is the original
  // extension manifest, not the generated Pulsar wrapper manifest.
  const extensionManifest = readJsonIfExists(path.join(extensionPath, 'package.json'));
  if (extensionManifest) return extensionManifest;

  const wrapperManifest = readJsonIfExists(path.join(path.dirname(extensionPath), 'package.json'));
  if (wrapperManifest) return wrapperManifest;

  return { name: path.basename(extensionPath || ''), version: '0.0.0' };
}

function createFallbackExtension(extensionId, extensionPath) {
  const packageJSON = findPackageJsonForExtensionPath(extensionPath);
  const id = extensionId || (packageJSON.publisher && packageJSON.name
    ? `${packageJSON.publisher}.${packageJSON.name}`
    : packageJSON.name);

  return {
    id,
    extensionUri: Uri.file(extensionPath),
    extensionPath,
    isActive: true,
    packageJSON,
    extensionKind: undefined,
    exports: undefined,
    activate() { return Promise.resolve(this.exports); }
  };
}

class ExtensionContext {
  constructor(extensionId, extensionPath, extensionMode, savedState) {
    this.subscriptions = [];
    this.extensionPath = extensionPath;
    this.extensionUri = Uri.file(extensionPath);
    this.extensionMode = extensionMode || 1; // Production
    this.extension = createFallbackExtension(extensionId, extensionPath);

    const atomHome = process.env.ATOM_HOME || path.join(os.homedir(), '.pulsar');
    const storageRoot = path.join(atomHome, 'storage', 'vscode-compat');
    const extStorageDir = path.join(storageRoot, extensionId);

    this.storagePath = extStorageDir;
    this.storageUri = Uri.file(extStorageDir);
    this.globalStoragePath = path.join(storageRoot, '_global', extensionId);
    this.globalStorageUri = Uri.file(this.globalStoragePath);
    this.logPath = path.join(atomHome, 'logs', 'vscode-compat', extensionId);
    this.logUri = Uri.file(this.logPath);

    this.globalState = new Memento(savedState && savedState.global);
    this.workspaceState = new Memento(savedState && savedState.workspace);
    this.secrets = new SecretStorage();
    this.environmentVariableCollection = new EnvironmentVariableCollection();
    this.languageModelAccessInformation = { onDidChange: () => ({ dispose() {} }), canSendRequest: () => undefined };
  }

  asAbsolutePath(relativePath) {
    return path.join(this.extensionPath, relativePath);
  }

  _dispose() {
    for (const sub of this.subscriptions) {
      try { if (sub && typeof sub.dispose === 'function') sub.dispose(); } catch (e) {}
    }
    this.subscriptions = [];
  }
}

module.exports = { ExtensionContext, Memento, SecretStorage, EnvironmentVariableCollection };
