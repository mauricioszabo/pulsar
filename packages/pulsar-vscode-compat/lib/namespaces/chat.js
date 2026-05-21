'use strict';

const { Disposable } = require('../types/disposable');

function createChatParticipant(id, handler) {
  return {
    id,
    requestHandler: handler,
    iconPath: undefined,
    followupProvider: undefined,
    onDidReceiveFeedback: { event: () => new Disposable(() => {}) },
    dispose() {}
  };
}

module.exports = { createChatParticipant };
