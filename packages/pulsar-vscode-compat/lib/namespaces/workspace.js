'use strict';

const { EventEmitter } = require('../types/event-emitter');
const { Uri } = require('../types/uri');
const { getTextDocument, forgetTextDocument } = require('../types/text-document');
const { WorkspaceEdit } = require('../types/workspace-edit');
const { FileSystemWatcher } = require('../types/file-system-watcher');
const { Disposable } = require('../types/disposable');
const { Range } = require('../types/range');
const { Position } = require('../types/position');
const path = require('path');
const fs = require('fs');
const os = require('os');

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

// Defaults for VSCode's built-in configuration keys that extensions commonly
// read. These keys do not come from any extension manifest, but VSCode still
// provides stable values for them. Returning undefined can break extensions that
// feed these values into parser/formatter code during activation.
const VS_CODE_CONFIGURATION_DEFAULTS = Object.freeze({
  'editor.maxTokenizationLineLength': 20000,
  'editor.rulers': []
});

// Virtual document content providers: scheme → provider
const contentProviders = new Map();

let _initialized = false;
let _configurationDefaults = null;
const openedDocumentLanguageIds = new WeakMap();

function readJSON(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { return null; }
}

function cloneDefaultValue(value) {
  if (value === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(value)); } catch (e) { return value; }
}

function configurationSections(contributes) {
  if (!contributes || !contributes.configuration) return [];
  return Array.isArray(contributes.configuration) ? contributes.configuration : [contributes.configuration];
}

function packageSearchPaths() {
  const paths = new Set();

  try {
    for (const pkg of atom.packages.getLoadedPackages()) {
      if (pkg && pkg.path) paths.add(pkg.path);
    }
  } catch (e) {}

  try {
    for (const pkgPath of atom.packages.getAvailablePackagePaths()) {
      paths.add(pkgPath);
    }
  } catch (e) {}

  const userPackagesPath = path.join(os.homedir(), '.pulsar', 'packages');
  try {
    for (const name of fs.readdirSync(userPackagesPath)) {
      paths.add(path.join(userPackagesPath, name));
    }
  } catch (e) {}

  return Array.from(paths);
}

function loadConfigurationDefaults() {
  if (_configurationDefaults) return _configurationDefaults;

  _configurationDefaults = new Map();
  for (const packagePath of packageSearchPaths()) {
    const manifest = readJSON(path.join(packagePath, 'extension', 'package.json'));
    if (!manifest || !manifest.contributes) continue;

    for (const section of configurationSections(manifest.contributes)) {
      const properties = section && section.properties;
      if (!properties) continue;

      for (const [key, schema] of Object.entries(properties)) {
        if (schema && Object.prototype.hasOwnProperty.call(schema, 'default') && !_configurationDefaults.has(key)) {
          _configurationDefaults.set(key, schema.default);
        }
      }
    }
  }

  return _configurationDefaults;
}

function getConfigurationDefault(fullKey) {
  if (Object.prototype.hasOwnProperty.call(VS_CODE_CONFIGURATION_DEFAULTS, fullKey)) {
    return cloneDefaultValue(VS_CODE_CONFIGURATION_DEFAULTS[fullKey]);
  }

  const defaults = loadConfigurationDefaults();
  if (!defaults.has(fullKey)) return undefined;
  return cloneDefaultValue(defaults.get(fullKey));
}

function textDocumentContentChanges(editor, changes) {
  if (!Array.isArray(changes)) return [];
  const buffer = editor.getBuffer && editor.getBuffer();
  return changes.map(change => {
    const oldRange = change.oldRange || change.range;
    const newRange = change.newRange || oldRange;
    const text = newRange && editor.getTextInBufferRange ? editor.getTextInBufferRange(newRange) : '';
    const range = oldRange ? Range.fromAtomRange(oldRange) : new Range(new Position(0, 0), new Position(0, 0));
    return {
      range,
      rangeOffset: oldRange && buffer && buffer.characterIndexForPosition ? buffer.characterIndexForPosition(oldRange.start) : 0,
      rangeLength: oldRange && typeof oldRange.getExtent === 'function'
        ? oldRange.getExtent().row === 0 ? oldRange.getExtent().column : undefined
        : undefined,
      text
    };
  });
}

function _init() {
  if (_initialized) return;
  _initialized = true;

  atom.workspace.observeTextEditors(editor => {
    const document = getTextDocument(editor);
    let lastLanguageId = document && document.languageId;
    fireDidOpenTextDocument(document);

    if (typeof editor.onDidChangeGrammar === 'function') {
      editor.onDidChangeGrammar(() => {
        const changedDocument = getTextDocument(editor);
        const nextLanguageId = changedDocument && changedDocument.languageId;
        if (nextLanguageId && nextLanguageId !== lastLanguageId) {
          lastLanguageId = nextLanguageId;
          fireDidOpenTextDocument(changedDocument);
        }
      });
    }

    editor.onDidChange(changes => {
      _onDidChangeTextDocument.fire({
        document: getTextDocument(editor),
        contentChanges: textDocumentContentChanges(editor, changes),
        reason: undefined
      });
    });

    editor.getBuffer().onWillSave(() => {
      _onWillSaveTextDocument.fire({
        document: getTextDocument(editor),
        reason: 1
      });
    });

    editor.getBuffer().onDidSave(() => {
      _onDidSaveTextDocument.fire(getTextDocument(editor));
    });

    editor.onDidDestroy(() => {
      const closedDocument = getTextDocument(editor);
      if (closedDocument) openedDocumentLanguageIds.delete(closedDocument);
      _onDidCloseTextDocument.fire(closedDocument);
      forgetTextDocument(editor, closedDocument);
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

function fireDidOpenTextDocument(document) {
  if (!document) return;
  openedDocumentLanguageIds.set(document, document.languageId);
  _onDidOpenTextDocument.fire(document);
}

function _ensureTextDocument(editor) {
  const document = getTextDocument(editor);
  if (!document) return document;

  const languageId = document.languageId;
  if (openedDocumentLanguageIds.get(document) !== languageId) {
    fireDidOpenTextDocument(document);
  }

  return document;
}

function openTextDocument(uriOrPathOrOptions) {
  // VSCode's workspace.openTextDocument creates an in-memory TextDocument
  // model without opening a visible editor — display only happens via
  // window.showTextDocument. atom.workspace.open always attaches the editor
  // to a pane (the {activatePane:false} flags only suppress focus, not the
  // tab itself), so we use atom.workspace.buildTextEditor (for new/untitled)
  // or createItemForURI (for path-backed) to materialize the editor without
  // adding it to a pane.
  let filePath;
  if (!uriOrPathOrOptions) {
    return Promise.resolve(getTextDocument(atom.workspace.buildTextEditor()));
  } else if (typeof uriOrPathOrOptions === 'string') {
    filePath = uriOrPathOrOptions;
  } else if (uriOrPathOrOptions.fsPath) {
    filePath = uriOrPathOrOptions.fsPath;
  } else if (uriOrPathOrOptions.content !== undefined || uriOrPathOrOptions.language) {
    // Untitled document with content
    const editor = atom.workspace.buildTextEditor();
    if (uriOrPathOrOptions.content) editor.setText(uriOrPathOrOptions.content);
    if (uriOrPathOrOptions.language) {
      const grammar = atom.grammars.grammarForScopeName(`source.${uriOrPathOrOptions.language}`);
      if (grammar) editor.setGrammar(grammar);
    }
    return Promise.resolve(getTextDocument(editor));
  }

  return Promise.resolve(atom.workspace.createItemForURI(filePath))
    .then(editor => getTextDocument(editor));
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

    if (atom.project && typeof atom.project.scan === 'function') {
      atom.project.scan(new RegExp(''), { paths: [pattern] }, () => {}).catch(() => {});
    }

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
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function textSearchRegex(query) {
  const pattern = typeof query === "string" ? query : (query.pattern || "");
  if (!pattern) return null;
  const flags = query.isCaseSensitive ? "g" : "gi";
  return query.isRegExp ? new RegExp(pattern, flags) : new RegExp(escapeRegExp(pattern), flags);
}

function rangeForTextMatch(line, start, length) {
  return new Range(new Position(line, start), new Position(line, start + length));
}

async function findTextInFilesFallback(query, options, callback) {
  const regex = textSearchRegex(query);
  if (!regex) return [];

  const results = [];
  const files = await findFiles(
    options.include || "**/*",
    options.exclude,
    options.maxResults
  );

  for (const uri of files) {
    let text;
    try { text = await fs.promises.readFile(uri.fsPath, "utf8"); } catch (e) { continue; }

    const lines = text.split(/\r?\n/);
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
      const line = lines[lineNumber];
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(line))) {
        const range = rangeForTextMatch(lineNumber, match.index, match[0].length);
        const result = {
          uri,
          ranges: [range],
          preview: { text: line, matches: [range] }
        };
        results.push(result);
        if (callback) callback(result);
        if (match[0].length === 0) regex.lastIndex++;
      }
    }
  }

  return results;
}

async function findTextInFiles(query, optionsOrCallback, callback) {
  const opts = typeof optionsOrCallback === "object" ? optionsOrCallback : {};
  const cb = typeof optionsOrCallback === "function" ? optionsOrCallback : callback;
  const results = [];

  if (!atom.project || typeof atom.project.scan !== "function") {
    return findTextInFilesFallback(query, opts, cb);
  }

  await new Promise(resolve => {
    const pattern = typeof query === "string" ? query : (query.pattern || "");
    atom.project.scan(new RegExp(pattern, query.isRegExp ? "" : "i"), {}, (result) => {
      const match = {
        uri: Uri.file(result.filePath),
        ranges: result.matches ? result.matches.map(m => Range.fromAtomRange(m.range)) : [],
        preview: { text: result.line || "", matches: [] }
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
    // VSCode's applyEdit operates on the in-memory document, never on the
    // visible tab. atom.workspace.open would create a tab — use
    // createItemForURI so we get a TextEditor backed by the file's buffer
    // without attaching to a pane. If the file is already open in a tab,
    // its buffer is shared so edits still propagate.
    let editor;
    try {
      editor = await Promise.resolve(atom.workspace.createItemForURI(filePath));
    } catch (e) { continue; }
    if (!editor) continue;

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
    if (val !== undefined) return val;

    const manifestDefault = getConfigurationDefault(fullKey);
    return manifestDefault !== undefined ? manifestDefault : defaultValue;
  }

  has(key) { return this.get(key) !== undefined; }

  inspect(key) {
    const fullKey = this._section ? `${this._section}.${key}` : key;
    const val = atom.config.get(fullKey);
    return {
      key: fullKey,
      globalValue: val,
      defaultValue: getConfigurationDefault(fullKey),
      workspaceValue: undefined,
      workspaceFolderValue: undefined,
      languageIds: []
    };
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

function registerNotebookSerializer(notebookType, serializer, options) {
  return new Disposable(() => {});
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

const FileType = Object.freeze({ Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 });

function uriToFsPath(uri) {
  return typeof uri === 'string' ? uri : uri.fsPath;
}

function statType(stats, targetStats) {
  if (stats.isSymbolicLink()) {
    if (targetStats && targetStats.isDirectory()) return FileType.SymbolicLink | FileType.Directory;
    if (targetStats && targetStats.isFile()) return FileType.SymbolicLink | FileType.File;
    return FileType.SymbolicLink;
  }
  if (stats.isDirectory()) return FileType.Directory;
  if (stats.isFile()) return FileType.File;
  return FileType.Unknown;
}

async function stat(uri) {
  const filePath = uriToFsPath(uri);
  const stats = await fs.promises.lstat(filePath);
  let targetStats;
  if (stats.isSymbolicLink()) {
    try { targetStats = await fs.promises.stat(filePath); } catch (e) {}
  }
  return {
    type: statType(stats, targetStats),
    ctime: stats.ctimeMs,
    mtime: stats.mtimeMs,
    size: stats.size
  };
}

const workspaceFileSystem = {
  stat,
  async readDirectory(uri) {
    const entries = await fs.promises.readdir(uriToFsPath(uri), { withFileTypes: true });
    return entries.map(entry => {
      let type = FileType.Unknown;
      if (entry.isDirectory()) type = FileType.Directory;
      else if (entry.isFile()) type = FileType.File;
      else if (entry.isSymbolicLink()) type = FileType.SymbolicLink;
      return [entry.name, type];
    });
  },
  async createDirectory(uri) {
    await fs.promises.mkdir(uriToFsPath(uri), { recursive: true });
  },
  async readFile(uri) {
    return fs.promises.readFile(uriToFsPath(uri));
  },
  async writeFile(uri, content) {
    await fs.promises.writeFile(uriToFsPath(uri), Buffer.from(content));
  },
  async delete(uri, options = {}) {
    await fs.promises.rm(uriToFsPath(uri), {
      recursive: !!options.recursive,
      force: !!options.useTrash
    });
  },
  async rename(source, target, options = {}) {
    if (!options.overwrite && fs.existsSync(uriToFsPath(target))) {
      const error = new Error('File exists: ' + uriToFsPath(target));
      error.code = 'EEXIST';
      throw error;
    }
    if (options.overwrite) {
      await fs.promises.rm(uriToFsPath(target), { recursive: true, force: true });
    }
    await fs.promises.rename(uriToFsPath(source), uriToFsPath(target));
  },
  async copy(source, target, options = {}) {
    if (!options.overwrite && fs.existsSync(uriToFsPath(target))) {
      const error = new Error('File exists: ' + uriToFsPath(target));
      error.code = 'EEXIST';
      throw error;
    }
    await fs.promises.cp(uriToFsPath(source), uriToFsPath(target), {
      recursive: true,
      force: !!options.overwrite,
      errorOnExist: !options.overwrite
    });
  },
  isWritableFileSystem(scheme) {
    return scheme === 'file';
  }
};

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
  get textDocuments() { return atom.workspace.getTextEditors().map(e => getTextDocument(e)); },
  get notebookDocuments() { return []; },
  fs: workspaceFileSystem,

  openTextDocument,
  saveAll,
  findFiles,
  findTextInFiles,
  applyEdit,
  getConfiguration,
  getWorkspaceFolder,
  createFileSystemWatcher,
  registerNotebookSerializer,
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

  _init,
  _ensureTextDocument
};
