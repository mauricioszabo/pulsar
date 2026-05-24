'use strict';

const fs = require('fs');
const path = require('path');

const { Disposable } = require('../types/disposable');

const commandRegistry = new Map(); // id → handler (for internal dispatch)
const commandMetadataCache = new Map(); // id → VSCode contributes.commands metadata
const scannedCommandMetadataPackagePaths = new Set();

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

function loadCommandMetadataFromManifest(manifest, source) {
  const contributedCommands = manifest && manifest.contributes && manifest.contributes.commands;
  if (!Array.isArray(contributedCommands)) return;

  const sourceMetadata = source
    ? {
      extensionName: source.displayName || source.name,
      extensionId: source.publisher && source.name ? `${source.publisher}.${source.name}` : undefined,
      publisher: source.publisher
    }
    : undefined;

  for (const contribution of contributedCommands) {
    if (!contribution || typeof contribution.command !== 'string') continue;
    if (!commandMetadataCache.has(contribution.command)) {
      commandMetadataCache.set(contribution.command, {
        ...contribution,
        _vscodeExtension: sourceMetadata
      });
    }
  }
}

function loadCommandMetadata() {
  const packageManager = atom && atom.packages;
  const loadedPackages = packageManager && typeof packageManager.getLoadedPackages === 'function'
    ? packageManager.getLoadedPackages()
    : [];

  for (const loadedPackage of loadedPackages) {
    if (!loadedPackage || !loadedPackage.path) continue;
    if (scannedCommandMetadataPackagePaths.has(loadedPackage.path)) continue;
    scannedCommandMetadataPackagePaths.add(loadedPackage.path);

    // VSCode extensions wrapped by pulsar-vscode-compat keep the original
    // extension manifest under extension/package.json. That manifest contains
    // contributes.commands entries with the human-facing title/category strings
    // VSCode's command palette shows instead of raw ids like calva.connect.
    const extensionManifestPath = path.join(loadedPackage.path, 'extension', 'package.json');
    const extensionManifest = readJSON(extensionManifestPath);
    loadCommandMetadataFromManifest(extensionManifest, extensionManifest);

    // Also accept inlined metadata in wrapper package.json for hand-authored or
    // future wrappers that choose not to keep an extension/ directory layout.
    const wrapperManifest = readJSON(path.join(loadedPackage.path, 'package.json'));
    loadCommandMetadataFromManifest(wrapperManifest, wrapperManifest);
    if (wrapperManifest && wrapperManifest._vscodeExtension) {
      loadCommandMetadataFromManifest(wrapperManifest._vscodeExtension, wrapperManifest._vscodeExtension);
    }
  }
}

function getCommandMetadata(command) {
  loadCommandMetadata();
  return commandMetadataCache.get(command) || null;
}

function getCommandDisplayName(contribution) {
  if (!contribution) return undefined;

  const title = contribution.title || contribution.shortTitle;
  const category = contribution.category;
  if (typeof title !== 'string' || title.length === 0) return undefined;
  if (typeof category === 'string' && category.length > 0 && !title.startsWith(`${category}:`)) {
    return `${category}: ${title}`;
  }
  return title;
}

function getCommandDescription(contribution) {
  if (!contribution) return undefined;
  if (typeof contribution.description === 'string' && contribution.description.length > 0) {
    return contribution.description;
  }
  return undefined;
}

function createCommandListener(command, didDispatch) {
  const contribution = getCommandMetadata(command);
  const displayName = getCommandDisplayName(contribution);
  const description = getCommandDescription(contribution);

  // Intentionally not setting `tags`: command-palette renders a "matching
  // tags: <id>" secondary row for any descriptor with non-empty tags, and the
  // raw command id (calva.connect, rubyLsp.showSyntaxTree) makes that row
  // noisy and unhelpful. The displayName already includes
  // "category: title", which the palette scores against directly, so search
  // relevance for VSCode commands is unaffected by omitting tags.

  const extensionMetadata = contribution && contribution._vscodeExtension;

  return {
    ...(displayName ? { displayName } : {}),
    ...(description ? { description } : {}),
    ...(extensionMetadata ? {
      vscodeExtensionCommand: true,
      vscodeCommand: command,
      vscodeExtensionName: extensionMetadata.extensionName,
      vscodeExtensionId: extensionMetadata.extensionId,
      vscodeExtensionPublisher: extensionMetadata.publisher
    } : {}),
    didDispatch
  };
}

function workspaceTextEditors() {
  try {
    return atom.workspace.getTextEditors ? atom.workspace.getTextEditors() : [];
  } catch (e) {
    return [];
  }
}

function isWorkspaceTextEditor(editor) {
  if (!editor) return false;
  try {
    if (typeof editor.isDestroyed === 'function' && editor.isDestroyed()) return false;
    if (atom.workspace.paneForItem && !atom.workspace.paneForItem(editor)) return false;
  } catch (e) {
    return false;
  }
  return workspaceTextEditors().includes(editor);
}

function activePaneTextEditor() {
  const panes = atom.workspace.getPanes ? atom.workspace.getPanes() : [];
  for (const pane of panes) {
    const item = pane && pane.getActiveItem && pane.getActiveItem();
    if (isWorkspaceTextEditor(item)) return item;
  }
  return undefined;
}

function atomTextEditorFromEvent(event) {
  const target = event && event.target;
  const editorElement = target && typeof target.closest === 'function'
    ? target.closest('atom-text-editor')
    : null;
  if (editorElement && typeof editorElement.getModel === 'function') {
    const editor = editorElement.getModel();
    if (isWorkspaceTextEditor(editor)) return editor;
  }

  const currentTarget = event && event.currentTarget;
  if (currentTarget && currentTarget.matches && currentTarget.matches('atom-text-editor') && typeof currentTarget.getModel === 'function') {
    const editor = currentTarget.getModel();
    if (isWorkspaceTextEditor(editor)) return editor;
  }

  const activeEditor = atom.workspace.getActiveTextEditor && atom.workspace.getActiveTextEditor();
  if (isWorkspaceTextEditor(activeEditor)) return activeEditor;

  const activePaneItem = atom.workspace.getActivePaneItem && atom.workspace.getActivePaneItem();
  if (isWorkspaceTextEditor(activePaneItem)) return activePaneItem;

  const paneEditor = activePaneTextEditor();
  if (paneEditor) return paneEditor;

  return workspaceTextEditors().find(isWorkspaceTextEditor);
}

function dispatchWithEditorOverride(event, callback) {
  const editor = atomTextEditorFromEvent(event);
  const workspaceNamespace = require('./workspace');
  if (workspaceNamespace && typeof workspaceNamespace._ensureTextDocument === 'function') {
    workspaceNamespace._ensureTextDocument(editor);
  }
  const windowNamespace = require('./window');
  if (windowNamespace && typeof windowNamespace._withActiveTextEditorOverride === 'function') {
    return windowNamespace._withActiveTextEditorOverride(editor, callback);
  }
  return callback();
}

function registerCommand(command, callback) {
  commandRegistry.set(command, callback);
  const listener = createCommandListener(command, (event) => {
    return dispatchWithEditorOverride(event, () => callback());
  });
  const disposable = atom.commands.add('atom-workspace', { [command]: listener });
  return new Disposable(() => {
    commandRegistry.delete(command);
    disposable.dispose();
  });
}

function registerTextEditorCommand(command, callback) {
  commandRegistry.set(command, callback);
  const listener = createCommandListener(command, (event) => {
    const editor = atomTextEditorFromEvent(event);
    if (!editor) return;
    const { TextEditor } = require('../types/text-editor');
    const { TextEditorEdit } = require('../types/text-editor');
    return dispatchWithEditorOverride(event, () => {
      const wrapped = new TextEditor(editor);
      const edit = new TextEditorEdit(editor);
      return callback(wrapped, edit, []);
    });
  });
  const disposable = atom.commands.add('atom-text-editor', { [command]: listener });
  return new Disposable(() => {
    commandRegistry.delete(command);
    disposable.dispose();
  });
}

function executeCommand(command, ...args) {
  if (command === 'vscode.executeCompletionItemProvider') {
    return require('./languages')._executeCompletionItemProvider(...args);
  }

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
