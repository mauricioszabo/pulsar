'use strict';

const { Disposable } = require('../types/disposable');

const commandRegistry = new Map(); // id → handler (for internal dispatch)

function registerCommand(command, callback) {
  commandRegistry.set(command, callback);
  const disposable = atom.commands.add('atom-workspace', { [command]: (event) => {
    callback();
  }});
  return new Disposable(() => {
    commandRegistry.delete(command);
    disposable.dispose();
  });
}

function registerTextEditorCommand(command, callback) {
  commandRegistry.set(command, callback);
  const disposable = atom.commands.add('atom-text-editor', { [command]: (event) => {
    const editor = atom.workspace.getActiveTextEditor();
    if (!editor) return;
    const { TextEditor } = require('../types/text-editor');
    const { TextEditorEdit } = require('../types/text-editor');
    const wrapped = new TextEditor(editor);
    const edit = new TextEditorEdit(editor);
    callback(wrapped, edit, []);
  }});
  return new Disposable(() => {
    commandRegistry.delete(command);
    disposable.dispose();
  });
}

function executeCommand(command, ...args) {
  // If it's a registered VSCode command, call it directly
  if (commandRegistry.has(command)) {
    try {
      const result = commandRegistry.get(command)(...args);
      return Promise.resolve(result);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  // Otherwise dispatch as an Atom command
  const target = atom.views.getView(atom.workspace);
  try {
    atom.commands.dispatch(target, command);
  } catch (e) {}
  return Promise.resolve(undefined);
}

function getCommands(filterInternal) {
  const atomCommands = atom.commands.findCommands({ target: document.body }).map(c => c.name);
  const vsCommands = [...commandRegistry.keys()];
  const all = [...new Set([...atomCommands, ...vsCommands])];
  return Promise.resolve(filterInternal ? all.filter(c => !c.startsWith('core:')) : all);
}

module.exports = { registerCommand, registerTextEditorCommand, executeCommand, getCommands };
