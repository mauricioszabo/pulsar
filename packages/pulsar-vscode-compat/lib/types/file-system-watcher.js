'use strict';

const { EventEmitter } = require('./event-emitter');
const { Uri } = require('./uri');

const FileChangeType = Object.freeze({ Changed: 1, Created: 2, Deleted: 3 });

class FileSystemWatcher {
  constructor(globPattern, ignoreCreate, ignoreChange, ignoreDelete) {
    this._onCreate = new EventEmitter();
    this._onChange = new EventEmitter();
    this._onDelete = new EventEmitter();
    this.onDidCreate = this._onCreate.event;
    this.onDidChange = this._onChange.event;
    this.onDidDelete = this._onDelete.event;
    this._watcher = null;
    this._globPattern = typeof globPattern === 'string' ? globPattern : (globPattern.pattern || '**/*');

    this._setupWatcher(ignoreCreate, ignoreChange, ignoreDelete);
  }

  _setupWatcher(ignoreCreate, ignoreChange, ignoreDelete) {
    try {
      const { watchPath } = require('atom');
      const projectPaths = atom.project.getPaths();
      const watchDir = projectPaths[0] || process.cwd();

      watchPath(watchDir, {}, events => {
        for (const event of events) {
          const uri = Uri.file(event.path);
          if (event.action === 'created' && !ignoreCreate) this._onCreate.fire(uri);
          else if (event.action === 'modified' && !ignoreChange) this._onChange.fire(uri);
          else if (event.action === 'deleted' && !ignoreDelete) this._onDelete.fire(uri);
        }
      }).then(watcher => { this._watcher = watcher; }).catch(() => {});
    } catch (e) {}
  }

  dispose() {
    if (this._watcher) {
      try { this._watcher.dispose(); } catch (e) {}
      this._watcher = null;
    }
    this._onCreate.dispose();
    this._onChange.dispose();
    this._onDelete.dispose();
  }
}

module.exports = { FileSystemWatcher, FileChangeType };
