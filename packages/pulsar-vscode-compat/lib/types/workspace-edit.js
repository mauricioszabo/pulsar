'use strict';

const { TextEdit } = require('./text-edit');

class WorkspaceEdit {
  constructor() {
    this._edits = new Map(); // uri.toString() → TextEdit[]
    this._fileOps = [];
  }

  replace(uri, range, newText, metadata) {
    this._getEdits(uri).push(TextEdit.replace(range, newText));
  }

  insert(uri, position, newText, metadata) {
    this._getEdits(uri).push(TextEdit.insert(position, newText));
  }

  delete(uri, range, metadata) {
    this._getEdits(uri).push(TextEdit.delete(range));
  }

  createFile(uri, options, metadata) {
    this._fileOps.push({ type: 'create', uri, options });
  }

  deleteFile(uri, options, metadata) {
    this._fileOps.push({ type: 'delete', uri, options });
  }

  renameFile(oldUri, newUri, options, metadata) {
    this._fileOps.push({ type: 'rename', oldUri, newUri, options });
  }

  has(uri) { return this._edits.has(uri.toString()); }

  set(uri, edits) {
    if (!edits || edits.length === 0) {
      this._edits.delete(uri.toString());
    } else {
      this._edits.set(uri.toString(), edits);
    }
  }

  get(uri) { return this._edits.get(uri.toString()) || []; }

  entries() {
    const { Uri } = require('./uri');
    return [...this._edits.entries()].map(([k, v]) => [Uri.parse(k), v]);
  }

  get size() { return this._edits.size; }

  _getEdits(uri) {
    const key = uri.toString();
    if (!this._edits.has(key)) this._edits.set(key, []);
    return this._edits.get(key);
  }
}

module.exports = { WorkspaceEdit };
