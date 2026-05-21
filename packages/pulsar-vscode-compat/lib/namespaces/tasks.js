'use strict';

const { EventEmitter } = require('../types/event-emitter');
const { Disposable } = require('../types/disposable');

const _onDidStartTask = new EventEmitter();
const _onDidEndTask = new EventEmitter();
const _onDidStartTaskProcess = new EventEmitter();
const _onDidEndTaskProcess = new EventEmitter();

module.exports = {
  taskExecutions: [],
  registerTaskProvider() { return new Disposable(() => {}); },
  fetchTasks() { return Promise.resolve([]); },
  executeTask() { return Promise.reject(new Error('Tasks not supported in Pulsar')); },
  onDidStartTask: _onDidStartTask.event,
  onDidEndTask: _onDidEndTask.event,
  onDidStartTaskProcess: _onDidStartTaskProcess.event,
  onDidEndTaskProcess: _onDidEndTaskProcess.event
};
