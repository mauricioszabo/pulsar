'use strict';

const { EventEmitter } = require('../types/event-emitter');
const { Disposable } = require('../types/disposable');

const _onDidChangeChatModels = new EventEmitter();

module.exports = {
  tools: [],
  selectChatModels() { return Promise.resolve([]); },
  invokeTool() { return Promise.reject(new Error('Language models not supported in Pulsar')); },
  registerTool() { return new Disposable(() => {}); },
  registerLanguageModelChatProvider() { return new Disposable(() => {}); },
  registerMcpServerDefinitionProvider() { return new Disposable(() => {}); },
  onDidChangeChatModels: _onDidChangeChatModels.event
};
