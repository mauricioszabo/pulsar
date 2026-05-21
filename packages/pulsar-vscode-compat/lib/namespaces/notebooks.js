'use strict';

const { EventEmitter } = require('../types/event-emitter');
const { Disposable } = require('../types/disposable');

const _onDidOpenNotebook = new EventEmitter();
const _onDidCloseNotebook = new EventEmitter();

module.exports = {
  createNotebookController() { return { dispose() {} }; },
  registerNotebookCellStatusBarItemProvider() { return new Disposable(() => {}); },
  registerNotebookSerializer() { return new Disposable(() => {}); },
  createRendererMessaging() { return { postMessage() { return Promise.resolve(); }, onDidReceiveMessage: new EventEmitter().event }; },
  onDidOpenNotebookDocument: _onDidOpenNotebook.event,
  onDidCloseNotebookDocument: _onDidCloseNotebook.event,
  notebookDocuments: []
};
