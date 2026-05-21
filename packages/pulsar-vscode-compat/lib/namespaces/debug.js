'use strict';

const { EventEmitter } = require('../types/event-emitter');
const { Disposable } = require('../types/disposable');

const _onDidStartDebugSession = new EventEmitter();
const _onDidTerminateDebugSession = new EventEmitter();
const _onDidChangeBreakpoints = new EventEmitter();
const _onDidChangeActiveDebugSession = new EventEmitter();
const _onDidChangeActiveStackItem = new EventEmitter();
const _onDidReceiveDebugSessionCustomEvent = new EventEmitter();

module.exports = {
  activeDebugSession: undefined,
  activeDebugConsole: { appendLine() {}, append() {} },
  activeStackItem: undefined,
  breakpoints: [],

  startDebugging() { return Promise.resolve(false); },
  stopDebugging() { return Promise.resolve(); },
  restartDebugging() { return Promise.resolve(false); },
  addBreakpoints() {},
  removeBreakpoints() {},
  asDebugSourceUri(source) { return source.path ? require('../types/uri').Uri.file(source.path) : require('../types/uri').Uri.parse('debug:unknown'); },
  registerDebugConfigurationProvider() { return new Disposable(() => {}); },
  registerDebugAdapterDescriptorFactory() { return new Disposable(() => {}); },
  registerDebugAdapterTrackerFactory() { return new Disposable(() => {}); },

  onDidStartDebugSession: _onDidStartDebugSession.event,
  onDidTerminateDebugSession: _onDidTerminateDebugSession.event,
  onDidChangeBreakpoints: _onDidChangeBreakpoints.event,
  onDidChangeActiveDebugSession: _onDidChangeActiveDebugSession.event,
  onDidChangeActiveStackItem: _onDidChangeActiveStackItem.event,
  onDidReceiveDebugSessionCustomEvent: _onDidReceiveDebugSessionCustomEvent.event
};
