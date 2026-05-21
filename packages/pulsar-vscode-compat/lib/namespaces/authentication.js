'use strict';

const { EventEmitter } = require('../types/event-emitter');
const { Disposable } = require('../types/disposable');

const _onDidChangeSessions = new EventEmitter();

module.exports = {
  getSession() { return Promise.resolve(undefined); },
  getAccounts() { return Promise.resolve([]); },
  registerAuthenticationProvider() { return new Disposable(() => {}); },
  onDidChangeSessions: _onDidChangeSessions.event
};
