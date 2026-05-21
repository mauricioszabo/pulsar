'use strict';

const { EventEmitter } = require('../types/event-emitter');
const { Uri } = require('../types/uri');
const { TextDocument } = require('../types/text-document');
const { WorkspaceEdit } = require('../types/workspace-edit');
const { FileSystemWatcher } = require('../types/file-system-watcher');
const { Disposable } = require('../types/disposable');
const { Range } = require('../types/range');
const path = require('path');

const _onDidOpenTextDocument = new EventEmitter();
const _onDidCloseTextDocument = new EventEmitter();
const _onDidChangeTextDocument = new EventEmitter();
const _onDidSaveTextDocument = new EventEmitter();
const _onWillSaveTextDocument = new EventEmitter();
const _onDidChangeConfiguration = new EventEmitter();
const _onDidChangeWorkspaceFolders = new EventEmitter();
const _onDidCreateFiles = new EventEmitter();
const _onDidDeleteFiles = new EventEmitter();
const _onDidRenameFiles = new EventEmitter();
const _onWillCreateFiles = new EventEmitter();
const _onWillDeleteFiles = new EventEmitter();
const _onWillRenameFiles = new EventEmitter();

// Virtual document content providers: scheme → provider
const contentProviders = new Map();

let _initialized = false;

function _init() {
  if (_initialized) return;
  _initialized = true;

  atom.workspace.observeTextEditors(editor => {
    _onDidOpenTextDocument.fire(new TextDocument(editor));

    editor.onDidChange(() => {
      _onDidChangeTextDocument.fire({
        document: new TextDocument(editor),
        contentChanges: [],
        reason: undefined
      });
    });

    editor.getBuffer().onWillSave(() => {
      _onWillSaveTextDocument.fire({
        document: new TextDocument(editor),
        reason: 1
      });
    });

    editor.getBuffer().onDidSave(() => {
      _onDidSaveTextDocument.fire(new TextDocument(editor));
    });

    editor.onDidDestroy(() => {
      _onDidCloseTextDocument.fire(new TextDocument(editor));
    });
  });

  atom.config.onDidChange(() => {
    _onDidChangeConfiguration.fire({ affectsConfiguration: () => true });
  });

  atom.project.onDidChangePaths(paths => {
    _onDidChangeWorkspaceFolders.fire({
      added: paths.map(p => ({ uri: Uri.file(p), name: path.basename(p), index: 0 })),
      removed: []
    });
  });
}

function openTextDocument(uriOrPathOrOptions) {
  let filePath;
  if (!uriOrPathOrOptions) {
    return atom.workspace.open('').then(e => new TextDocument(e));
  } else if (typeof uriOrPathOrOptions === 'string') {
    filePath = uriOrPathOrOptions;
  } else if (uriOrPathOrOptions.fsPath) {
    filePath = uriOrPathOrOptions.fsPath;
  } else if (uriOrPathOrOptions.content !== undefined || uriOrPathOrOptions.language) {
    // Untitled document with content
    return atom.workspace.open('').then(async editor => {
      if (uriOrPathOrOptions.content) editor.setText(uriOrPathOrOptions.content);
      if (uriOrPathOrOptions.language) {
        const grammar = atom.grammars.grammarForScopeName(`source.${uriOrPathOrOptions.language}`);
        if (grammar) editor.setGrammar(grammar);
      }
      return new TextDocument(editor);
    });
  }

  return atom.workspace.open(filePath, { activatePane: false, activateItem: false })
    .then(editor => new TextDocument(editor));
}

function saveAll(includeUntitled) {
  const editors = atom.workspace.getTextEditors();
  const saves = editors
    .filter(e => e.isModified() && (includeUntitled || !e.isUntitled()))
    .map(e => e.getBuffer().save().catch(() => {}));
  return Promise.all(saves).then(() => undefined);
}

function findFiles(include, exclude, maxResults, token) {
  return new Promise((resolve, reject) => {
    const results = [];
    const pattern = typeof include === 'string' ? include : (include && include.pattern) || '**/*';
    const excludePattern = typeof exclude === 'string' ? exclude : (exclude && exclude.pattern) || null;

    atom.project.scan(new RegExp(''), { paths: [pattern] }, () => {}).catch(() => {});

    // Use project.getDirectories to enumerate files
    try {
      const glob = require('glob');
      const projectPaths = atom.project.getPaths();
      let allFiles = [];
      for (const projectPath of projectPaths) {
        const files = glob.sync(pattern, { cwd: projectPath, absolute: true, ignore: excludePattern ? [excludePattern] : [] });
        allFiles.push(...files);
        if (maxResults && allFiles.length >= maxResults) break;
      }
      if (maxResults) allFiles = allFiles.slice(0, maxResults);
      resolve(allFiles.map(f => Uri.file(f)));
    } catch (e) {
      resolve([]);
    }
  });
}

async function findTextInFiles(query, optionsOrCallback, callback) {
  const opts = typeof optionsOrCallback === 'object' ? optionsOrCallback : {};
  const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
  const results = [];

  await new Promise(resolve => {
    const pattern = typeof query === 'string' ? query : (query.pattern || '');
    atom.project.scan(new RegExp(pattern, query.isRegExp ? '' : 'i'), {}, (result) => {
      const match = {
        uri: Uri.file(result.filePath),
        ranges: result.matches ? result.matches.map(m => Range.fromAtomRange(m.range)) : [],
        preview: { text: result.line || '', matches: [] }
      };
      results.push(match);
      if (cb) cb(match);
    }).then(resolve).catch(resolve);
  });

  return results;
}

async function applyEdit(workspaceEdit) {
  const entries = workspaceEdit.entries ? workspaceEdit.entries() : [];
  for (const [uri, edits] of entries) {
    const filePath = uri.fsPath;
    let editor;
    try {
      editor = await atom.workspace.open(filePath, { activatePane: false, activateItem: false });
    } catch (e) { continue; }

    editor.transact(() => {
      const sorted = [...edits].sort((a, b) => {
        const bRow = b.range.start.line, aRow = a.range.start.line;
        return bRow !== aRow ? bRow - aRow : b.range.start.character - a.range.start.character;
      });
      for (const edit of sorted) {
        editor.setTextInBufferRange(edit.range.toAtomRange(), edit.newText);
      }
    });
  }

  // File operations
  if (workspaceEdit._fileOps) {
    const fs = require('fs').promises;
    for (const op of workspaceEdit._fileOps) {
      try {
        if (op.type === 'create') await fs.writeFile(op.uri.fsPath, '', { flag: op.options && op.options.overwrite ? 'w' : 'wx' });
        else if (op.type === 'delete') await fs.unlink(op.uri.fsPath);
        else if (op.type === 'rename') await fs.rename(op.oldUri.fsPath, op.newUri.fsPath);
      } catch (e) {}
    }
  }

  return true;
}

class WorkspaceConfiguration {
  constructor(section, atomConfig) {
    this._section = section;
    this._atomConfig = atomConfig;
  }

  get(key, defaultValue) {
    const fullKey = this._section ? `${this._section}.${key}` : key;
    // Try pulsar config first
    let val;
    try { val = atom.config.get(fullKey); } catch (e) {}
    if (val === undefined) {
      // Try direct key
      try { val = atom.config.get(key); } catch (e) {}
    }
    return val !== undefined ? val : defaultValue;
  }

  has(key) { return this.get(key) !== undefined; }

  inspect(key) {
    const fullKey = this._section ? `${this._section}.${key}` : key;
    const val = atom.config.get(fullKey);
    return { key: fullKey, globalValue: val, defaultValue: undefined, workspaceValue: undefined };
  }

  async update(key, value, target) {
    const fullKey = this._section ? `${this._section}.${key}` : key;
    atom.config.set(fullKey, value);
  }
}

function getConfiguration(section, scopeOrUri) {
  return new WorkspaceConfiguration(section);
}

function getWorkspaceFolder(uri) {
  const filePath = uri.fsPath || '';
  const projectPaths = atom.project.getPaths();
  for (const p of projectPaths) {
    if (filePath.startsWith(p)) {
      return { uri: Uri.file(p), name: path.basename(p), index: projectPaths.indexOf(p) };
    }
  }
  return undefined;
}

function createFileSystemWatcher(globPattern, ignoreCreate, ignoreChange, ignoreDelete) {
  return new FileSystemWatcher(globPattern, ignoreCreate, ignoreChange, ignoreDelete);
}

function registerTextDocumentContentProvider(scheme, provider) {
  contentProviders.set(scheme, provider);
  const opener = atom.workspace.addOpener(uri => {
    if (!uri.startsWith(scheme + ':')) return;
    const { Uri: UriClass } = require('../types/uri');
    const vsUri = UriClass.parse(uri);
    return provider.provideTextDocumentContent(vsUri, new (require('../types/cancellation').CancellationTokenSource)().token)
      .then(content => {
        const editor = atom.workspace.buildTextEditor();
        editor.setText(content || '');
        return editor;
      });
  });
  return new Disposable(() => {
    contentProviders.delete(scheme);
    opener.dispose();
  });
}

function asRelativePath(pathOrUri, includeWorkspaceFolder) {
  const filePath = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
  const projectPaths = atom.project.getPaths();
  for (const p of projectPaths) {
    if (filePath.startsWith(p + path.sep)) {
      const rel = filePath.slice(p.length + 1);
      if (includeWorkspaceFolder) return path.basename(p) + path.sep + rel;
      return rel;
    }
  }
  return filePath;
}

module.exports = {
  get name() {
    const paths = atom.project.getPaths();
    return paths.length ? path.basename(paths[0]) : undefined;
  },
  get rootPath() { return atom.project.getPaths()[0] || undefined; },
  get workspaceFolders() {
    return atom.project.getPaths().map((p, i) => ({ uri: Uri.file(p), name: path.basename(p), index: i }));
  },
  get isTrusted() { return true; },
  get textDocuments() { return atom.workspace.getTextEditors().map(e => new TextDocument(e)); },
  get notebookDocuments() { return []; },

  openTextDocument,
  saveAll,
  findFiles,
  findTextInFiles,
  applyEdit,
  getConfiguration,
  getWorkspaceFolder,
  createFileSystemWatcher,
  registerTextDocumentContentProvider,
  asRelativePath,

  onDidOpenTextDocument: _onDidOpenTextDocument.event,
  onDidCloseTextDocument: _onDidCloseTextDocument.event,
  onDidChangeTextDocument: _onDidChangeTextDocument.event,
  onDidSaveTextDocument: _onDidSaveTextDocument.event,
  onWillSaveTextDocument: _onWillSaveTextDocument.event,
  onDidChangeConfiguration: _onDidChangeConfiguration.event,
  onDidChangeWorkspaceFolders: _onDidChangeWorkspaceFolders.event,
  onDidCreateFiles: _onDidCreateFiles.event,
  onDidDeleteFiles: _onDidDeleteFiles.event,
  onDidRenameFiles: _onDidRenameFiles.event,
  onWillCreateFiles: _onWillCreateFiles.event,
  onWillDeleteFiles: _onWillDeleteFiles.event,
  onWillRenameFiles: _onWillRenameFiles.event,

  _init
};
