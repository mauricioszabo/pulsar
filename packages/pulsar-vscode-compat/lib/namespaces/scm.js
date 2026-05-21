'use strict';

const { EventEmitter } = require('../types/event-emitter');
const { Disposable } = require('../types/disposable');

function createSourceControl(id, label, rootUri) {
  const _onDidChangeResourceStates = new EventEmitter();
  const resourceGroups = [];

  const scm = {
    id,
    label,
    rootUri,
    inputBox: { value: '', placeholder: '', enabled: true },
    count: 0,
    quickDiffProvider: undefined,
    commitTemplate: undefined,
    acceptInputCommand: undefined,
    statusBarCommands: undefined,

    createResourceGroup(id, label) {
      const group = {
        id, label, resourceStates: [], hideWhenEmpty: false,
        dispose() { const idx = resourceGroups.indexOf(group); if (idx >= 0) resourceGroups.splice(idx, 1); }
      };
      resourceGroups.push(group);
      return group;
    },

    dispose() {}
  };

  return scm;
}

module.exports = { createSourceControl, inputBox: { value: '', placeholder: '' } };
