'use strict';

const path = require('path');
const minimatchModule = require('minimatch');
const { EventEmitter } = require('./event-emitter');
const { Uri } = require('./uri');

const minimatch = typeof minimatchModule === 'function'
  ? minimatchModule
  : minimatchModule.minimatch;

const FileChangeType = Object.freeze({ Changed: 1, Created: 2, Deleted: 3 });

function normalizePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/');
}

function basePathFromGlobPattern(globPattern) {
  if (!globPattern || typeof globPattern === 'string') return null;

  const base = globPattern.baseUri || globPattern.base;
  if (!base) return null;
  if (typeof base === 'string') return base;
  if (base.fsPath) return base.fsPath;
  if (base.uri && base.uri.fsPath) return base.uri.fsPath;
  return null;
}

function patternFromGlobPattern(globPattern) {
  if (typeof globPattern === 'string') return globPattern;
  return (globPattern && globPattern.pattern) || '**/*';
}

function isPathInsideBase(filePath, basePath) {
  const relative = path.relative(basePath, filePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

class FileSystemWatcher {
  constructor(globPattern, ignoreCreate, ignoreChange, ignoreDelete) {
    this._onCreate = new EventEmitter();
    this._onChange = new EventEmitter();
    this._onDelete = new EventEmitter();
    this.onDidCreate = this._onCreate.event;
    this.onDidChange = this._onChange.event;
    this.onDidDelete = this._onDelete.event;
    this._watchers = [];
    this._globPattern = patternFromGlobPattern(globPattern);
    this._basePath = basePathFromGlobPattern(globPattern);

    this._setupWatcher(ignoreCreate, ignoreChange, ignoreDelete);
  }

  _matches(filePath, watchDir) {
    if (!minimatch) return true;

    const basePath = this._basePath || watchDir;
    if (this._basePath && !isPathInsideBase(filePath, this._basePath)) return false;

    const normalizedAbsolute = normalizePath(filePath);
    const normalizedRelative = normalizePath(path.relative(basePath, filePath));
    const pattern = normalizePath(this._globPattern || '**/*');
    const options = { dot: true, matchBase: false, nocase: process.platform === 'win32' };

    return minimatch(normalizedRelative, pattern, options) ||
      minimatch(normalizedRelative + '/', pattern, options) ||
      minimatch(normalizedAbsolute, pattern, options) ||
      minimatch(normalizedAbsolute + '/', pattern, options);
  }

  _setupWatcher(ignoreCreate, ignoreChange, ignoreDelete) {
    try {
      const { watchPath } = require('atom');
      const projectPaths = this._basePath ? [this._basePath] : atom.project.getPaths();
      const watchDirs = projectPaths.length ? projectPaths : [process.cwd()];

      for (const watchDir of watchDirs) {
        watchPath(watchDir, {}, events => {
          for (const event of events) {
            if (!this._matches(event.path, watchDir)) continue;

            const uri = Uri.file(event.path);
            if (event.action === 'created' && !ignoreCreate) this._onCreate.fire(uri);
            else if (event.action === 'modified' && !ignoreChange) this._onChange.fire(uri);
            else if (event.action === 'deleted' && !ignoreDelete) this._onDelete.fire(uri);
          }
        }).then(watcher => { this._watchers.push(watcher); }).catch(() => {});
      }
    } catch (e) {}
  }

  dispose() {
    for (const watcher of this._watchers) {
      try { watcher.dispose(); } catch (e) {}
    }
    this._watchers = [];
    this._onCreate.dispose();
    this._onChange.dispose();
    this._onDelete.dispose();
  }
}

module.exports = { FileSystemWatcher, FileChangeType };
