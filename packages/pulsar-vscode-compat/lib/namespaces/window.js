'use strict';

const { EventEmitter } = require('../types/event-emitter');
const { TextEditor, TextEditorDecorationType, ViewColumn } = require('../types/text-editor');
const { TextDocument } = require('../types/text-document');
const { OutputChannel, LogOutputChannel } = require('../types/output-channel');
const { StatusBarItem, StatusBarAlignment } = require('../types/status-bar-item');
const { Uri } = require('../types/uri');
const { Disposable } = require('../types/disposable');
const { CancellationTokenSource } = require('../types/cancellation');
const path = require('path');
const fs = require('fs');

let AnsiUpClass;
let _ansiUp;

function resolveRequireableAnsiUp() {
  try {
    const resolved = require.resolve('ansi-up');
    // ansi-up@1.0.0 advertises a CommonJS "main", but the file actually ends
    // with an ESM `export { AnsiUp }`. Pulsar's CommonJS compile cache logs a
    // noisy "Error running script" before our try/catch can handle that syntax
    // error, so inspect the source first and only require versions that are
    // actually CommonJS-loadable.
    const source = fs.readFileSync(resolved, 'utf8');
    if (/^\s*export\s+/m.test(source)) return null;
    return resolved;
  } catch (e) {
    return null;
  }
}

function getAnsiUp() {
  if (_ansiUp) return _ansiUp;
  if (AnsiUpClass === undefined) {
    const resolved = resolveRequireableAnsiUp();
    if (resolved) {
      try {
        const mod = require(resolved);
        AnsiUpClass = mod.AnsiUp || mod.default || mod;
      } catch (e) {
        AnsiUpClass = null;
      }
    } else {
      AnsiUpClass = null;
    }
  }
  if (AnsiUpClass) {
    try {
      _ansiUp = new AnsiUpClass();
      // Calva output runs in an editor-themed pane, so keep the host background.
      _ansiUp.use_classes = false;
      _ansiUp.useClasses = false;
      _ansiUp.escape_for_html = true;
      _ansiUp.escapeForHtml = true;
      return _ansiUp;
    } catch (e) {}
  }
  return null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fallbackAnsiToHtml(value) {
  const colors = {
    30: '#000000', 31: '#cd3131', 32: '#0dbc79', 33: '#e5e510',
    34: '#2472c8', 35: '#bc3fbc', 36: '#11a8cd', 37: '#e5e5e5',
    90: '#666666', 91: '#f14c4c', 92: '#23d18b', 93: '#f5f543',
    94: '#3b8eea', 95: '#d670d6', 96: '#29b8db', 97: '#ffffff'
  };
  const bgColors = {
    40: '#000000', 41: '#cd3131', 42: '#0dbc79', 43: '#e5e510',
    44: '#2472c8', 45: '#bc3fbc', 46: '#11a8cd', 47: '#e5e5e5',
    100: '#666666', 101: '#f14c4c', 102: '#23d18b', 103: '#f5f543',
    104: '#3b8eea', 105: '#d670d6', 106: '#29b8db', 107: '#ffffff'
  };
  const state = { bold: false, italic: false, underline: false, foreground: null, background: null };
  let html = '';
  let open = false;
  const close = () => { if (open) { html += '</span>'; open = false; } };
  const style = () => {
    const parts = [];
    if (state.bold) parts.push('font-weight:bold');
    if (state.italic) parts.push('font-style:italic');
    if (state.underline) parts.push('text-decoration:underline');
    if (state.foreground) parts.push(`color:${state.foreground}`);
    if (state.background) parts.push(`background-color:${state.background}`);
    return parts.join(';');
  };
  const openSpan = () => {
    const css = style();
    if (css) { html += `<span style="${css}">`; open = true; }
  };
  String(value).split(/\x1b\[([0-9;]*)m/g).forEach((part, index) => {
    if (index % 2 === 0) {
      html += escapeHtml(part);
      return;
    }
    close();
    const codes = part === '' ? [0] : part.split(';').map(code => Number(code || 0));
    for (const code of codes) {
      if (code === 0) {
        state.bold = false; state.italic = false; state.underline = false;
        state.foreground = null; state.background = null;
      } else if (code === 1) state.bold = true;
      else if (code === 3) state.italic = true;
      else if (code === 4) state.underline = true;
      else if (code === 22) state.bold = false;
      else if (code === 23) state.italic = false;
      else if (code === 24) state.underline = false;
      else if (code === 39) state.foreground = null;
      else if (code === 49) state.background = null;
      else if (colors[code]) state.foreground = colors[code];
      else if (bgColors[code]) state.background = bgColors[code];
    }
    openSpan();
  });
  close();
  return html;
}

function terminalAnsiToHtml(value) {
  const ansiUp = getAnsiUp();
  if (ansiUp && typeof ansiUp.ansi_to_html === 'function') {
    return ansiUp.ansi_to_html(value);
  }
  if (ansiUp && typeof ansiUp.ansiToHtml === 'function') {
    return ansiUp.ansiToHtml(value);
  }
  return fallbackAnsiToHtml(value);
}

function stripUnsupportedTerminalSequences(value) {
  return String(value)
    // OSC sequences, including title-setting sequences, are not display text.
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    // Drop non-SGR CSI sequences that ansi-up does not render as colors/styles.
    .replace(/\x1b\[(?![0-9;]*m)[0-?]*[ -/]*[@-~]/g, '');
}

const _onDidChangeActiveTextEditor = new EventEmitter();
const _onDidChangeVisibleTextEditors = new EventEmitter();
const _onDidChangeTextEditorSelection = new EventEmitter();
const _onDidChangeTextEditorVisibleRanges = new EventEmitter();
const _onDidChangeTextEditorOptions = new EventEmitter();
const _onDidChangeTextEditorViewColumn = new EventEmitter();
const _onDidChangeWindowState = new EventEmitter();
const _onDidChangeActiveColorTheme = new EventEmitter();
const _onDidOpenTerminal = new EventEmitter();
const _onDidCloseTerminal = new EventEmitter();
const _onDidChangeTerminalState = new EventEmitter();
const _onDidChangeActiveNotebookEditor = new EventEmitter();
const _onDidChangeVisibleNotebookEditors = new EventEmitter();
const _onDidChangeNotebookEditorSelection = new EventEmitter();
const _onDidChangeNotebookEditorVisibleRanges = new EventEmitter();
const _onDidChangTextEditorViewColumn = new EventEmitter();

let _statusBarService = null;
let _initialized = false;
let _decorationCounter = 0;
let _terminalCounter = 0;
let _activeTerminal = undefined;
let _lastActiveTextEditor = undefined;
let _activeTextEditorOverride = undefined;
const _terminals = [];
const _terminalItemsByUri = new Map();
let _terminalOpenerDisposable = null;

function _init() {
  if (_initialized) return;
  _initialized = true;

  const activeEditor = atom.workspace.getActiveTextEditor && atom.workspace.getActiveTextEditor();
  if (isUsableAtomTextEditor(activeEditor)) {
    _lastActiveTextEditor = activeEditor;
  }

  atom.workspace.onDidChangeActiveTextEditor(editor => {
    const usableEditor = isUsableAtomTextEditor(editor) ? editor : undefined;
    if (usableEditor) _lastActiveTextEditor = usableEditor;
    _onDidChangeActiveTextEditor.fire(usableEditor ? new TextEditor(usableEditor) : undefined);
  });

  atom.workspace.observeTextEditors(editor => {
    if (!_lastActiveTextEditor && isUsableAtomTextEditor(editor)) _lastActiveTextEditor = editor;
    _onDidChangeVisibleTextEditors.fire(atom.workspace.getTextEditors().map(e => new TextEditor(e)));
    editor.onDidDestroy(() => {
      if (_lastActiveTextEditor === editor) _lastActiveTextEditor = undefined;
      _onDidChangeVisibleTextEditors.fire(atom.workspace.getTextEditors().map(e => new TextEditor(e)));
    });
  });

  atom.themes.onDidChangeActiveThemes(() => {
    const ColorTheme = require('./window').activeColorTheme;
    _onDidChangeActiveColorTheme.fire(ColorTheme);
  });
}

function consumeStatusBar(service) { _statusBarService = service; }

function wrapEditor(atomEditor) {
  return atomEditor ? new TextEditor(atomEditor) : undefined;
}

async function showTextDocument(documentOrUri, optionsOrColumn, preserveFocus) {
  let filePath;
  if (documentOrUri instanceof TextDocument) {
    filePath = documentOrUri.fileName;
  } else if (documentOrUri && documentOrUri.fsPath) {
    filePath = documentOrUri.fsPath;
  } else if (typeof documentOrUri === 'string') {
    filePath = documentOrUri;
  }
  const opts = typeof optionsOrColumn === 'object' ? optionsOrColumn : {};
  const activate = !(opts.preserveFocus || preserveFocus);
  const editor = await atom.workspace.open(filePath, { activatePane: activate, activateItem: activate });
  return wrapEditor(editor);
}

function _messageText(value) {
  if (value instanceof Error) return value.message || String(value);
  if (typeof value === 'string') return value;
  if (value && typeof value.message === 'string') return value.message;
  return String(value);
}

function _messageDetail(value) {
  if (value instanceof Error) return value.stack || value.message || String(value);
  if (value && typeof value.stack === 'string') return value.stack;
  if (value && typeof value.message === 'string') return value.message;
  return undefined;
}

// --- Notifications (Promise-based with button items) ---
function _showMessage(type, message, ...rest) {
  let items, options;
  if (rest.length && typeof rest[0] === 'object' && !Array.isArray(rest[0]) && !(rest[0] instanceof Error) && !rest[0].message && !rest[0].title && (rest[0].modal !== undefined || rest[0].detail !== undefined)) {
    options = rest[0];
    items = rest.slice(1);
  } else {
    items = rest;
    options = {};
  }

  const details = [];
  const buttonItems = [];
  for (const item of items) {
    if (item instanceof Error || (item && typeof item === 'object' && item.message && !item.title)) {
      const detail = _messageDetail(item);
      if (detail) details.push(detail);
    } else {
      buttonItems.push(item);
    }
  }

  const messageText = _messageText(message);
  const messageDetail = _messageDetail(message);
  if (messageDetail && messageDetail !== messageText) details.unshift(messageDetail);

  const buttons = buttonItems.map(item => {
    const label = typeof item === 'string' ? item : item.title || String(item);
    return { text: label, item };
  });

  return new Promise(resolve => {
    const notifOpts = { dismissable: true };
    if (buttons.length) {
      notifOpts.buttons = buttons.map(b => ({
        text: b.text,
        onDidClick: () => { notif.dismiss(); resolve(b.item); }
      }));
    }
    const optionDetail = options.detail ? _messageText(options.detail) : undefined;
    const allDetails = [...(optionDetail ? [optionDetail] : []), ...details].filter(Boolean);
    if (allDetails.length) notifOpts.detail = allDetails.join('\n\n');
    if (options.modal) notifOpts.dismissable = true;

    const notif = atom.notifications[`add${type}`](messageText, notifOpts);
    if (!buttons.length) resolve(undefined);
    notif.onDidDismiss(() => resolve(undefined));
  });
}

function showInformationMessage(message, ...rest) { return _showMessage('Info', message, ...rest); }
function showWarningMessage(message, ...rest) { return _showMessage('Warning', message, ...rest); }
function showErrorMessage(message, ...rest) { return _showMessage('Error', message, ...rest); }

// --- Quick pick ---
function showQuickPick(items, options) {
  return new Promise(resolve => {
    const resolvedItems = Promise.resolve(typeof items === 'function' ? items() : items);
    resolvedItems.then(resolvedList => {
      const list = resolvedList || [];
      const SelectListView = (() => {
        try {
          const mod = require('atom-select-list');
          return mod.SelectListView || mod.default || mod;
        } catch(e) { return null; }
      })();
      if (!SelectListView) { resolve(undefined); return; }

      const isMulti = options && options.canPickMany;
      const selected = [];

      const view = new SelectListView({
        items: list,
        filterKeyForItem: item => typeof item === 'string' ? item : ((item.label || '') + ' ' + (item.description || '')),
        elementForItem: (item) => {
          const li = document.createElement('li');
          li.classList.add('two-lines');
          if (typeof item === 'string') {
            li.textContent = item;
          } else {
            const label = document.createElement('div');
            label.classList.add('primary-line');
            label.textContent = item.label || '';
            li.appendChild(label);
            if (item.description || item.detail) {
              const detail = document.createElement('div');
              detail.classList.add('secondary-line');
              detail.textContent = item.description || item.detail || '';
              li.appendChild(detail);
            }
          }
          return li;
        },
        didConfirmSelection: (item) => {
          panel.destroy();
          resolve(isMulti ? [item] : item);
        },
        didCancelSelection: () => {
          panel.destroy();
          resolve(undefined);
        }
      });

      if (options && options.placeHolder) view.element.querySelector('input') && (view.element.querySelector('input').placeholder = options.placeHolder);

      const panel = atom.workspace.addModalPanel({ item: view.element });
      view.focus();
    });
  });
}

// --- Input box ---
function showInputBox(options) {
  return new Promise(resolve => {
    const editorEl = document.createElement('atom-text-editor');
    editorEl.setAttribute('mini', '');
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'padding:8px;';
    if (options && options.prompt) {
      const label = document.createElement('div');
      label.style.cssText = 'margin-bottom:4px;font-size:12px;';
      label.textContent = options.prompt;
      wrapper.appendChild(label);
    }
    wrapper.appendChild(editorEl);
    const panel = atom.workspace.addModalPanel({ item: wrapper });

    // Wait for the editor model to be ready
    setTimeout(() => {
      const editorModel = editorEl.getModel ? editorEl.getModel() : null;
      if (editorModel) {
        if (options && options.value) editorModel.setText(options.value);
        if (options && options.password) editorModel.setPasswordChar && editorModel.setPasswordChar('•');

        const accept = () => {
          panel.destroy();
          resolve(editorModel.getText());
        };
        const cancel = () => {
          panel.destroy();
          resolve(undefined);
        };

        editorEl.addEventListener('keydown', e => {
          if (e.key === 'Enter') accept();
          if (e.key === 'Escape') cancel();
        });
        editorEl.focus();
      } else {
        panel.destroy();
        resolve(undefined);
      }
    }, 50);
  });
}

// --- File dialogs ---
function showOpenDialog(options) {
  return new Promise(resolve => {
    try {
      const { dialog } = require('@electron/remote') || require('electron').remote;
      const opts = {
        properties: ['openFile'],
        filters: options && options.filters ? options.filters.map(f => ({ name: f.name, extensions: f.extensions })) : [],
        defaultPath: options && options.defaultUri ? options.defaultUri.fsPath : undefined,
        title: options && options.openLabel
      };
      if (options && options.canSelectMany) opts.properties.push('multiSelections');
      if (options && options.canSelectFolders) opts.properties = ['openDirectory'];
      if (options && options.canSelectFiles === false) opts.properties = ['openDirectory'];

      dialog.showOpenDialog(opts).then(result => {
        if (result.canceled || !result.filePaths || !result.filePaths.length) {
          resolve(undefined);
        } else {
          resolve(result.filePaths.map(p => Uri.file(p)));
        }
      });
    } catch (e) {
      resolve(undefined);
    }
  });
}

function showSaveDialog(options) {
  return new Promise(resolve => {
    try {
      const { dialog } = require('@electron/remote') || require('electron').remote;
      const opts = {
        filters: options && options.filters ? options.filters.map(f => ({ name: f.name, extensions: f.extensions })) : [],
        defaultPath: options && options.defaultUri ? options.defaultUri.fsPath : undefined,
        title: options && options.saveLabel
      };
      dialog.showSaveDialog(opts).then(result => {
        if (result.canceled || !result.filePath) resolve(undefined);
        else resolve(Uri.file(result.filePath));
      });
    } catch (e) {
      resolve(undefined);
    }
  });
}

function showWorkspaceFolderPick(options) {
  const folders = atom.project.getPaths().map(p => ({ uri: Uri.file(p), name: path.basename(p), index: 0 }));
  return showQuickPick(folders.map(f => ({ label: f.name, description: f.uri.fsPath, _folder: f })), options)
    .then(item => item ? item._folder : undefined);
}

// --- Progress ---
function withProgress(options, task) {
  const tokenSource = new CancellationTokenSource();
  const progress = { report(value) {} };

  const notif = atom.notifications.addInfo(options.title || 'Working...', {
    dismissable: false,
    description: 'In progress...'
  });

  const result = task(progress, tokenSource.token);
  Promise.resolve(result).then(() => notif.dismiss()).catch(() => notif.dismiss());
  return result;
}

// --- Output channels ---
const outputChannels = new Map();

function createOutputChannel(name, options) {
  if (outputChannels.has(name)) return outputChannels.get(name);
  const languageId = typeof options === 'string' ? options : (options && options.log ? null : null);
  const ch = options && options.log ? new LogOutputChannel(name, options) : new OutputChannel(name, languageId);
  outputChannels.set(name, ch);
  return ch;
}

// --- Decorations ---
let _styleCounter = 0;

function createTextEditorDecorationType(options) {
  const className = `vscode-decoration-${++_styleCounter}`;
  const styleEl = document.createElement('style');
  styleEl.dataset.decorationClass = className;

  const cssProps = [];
  if (options.backgroundColor) cssProps.push(`background-color:${cssColor(options.backgroundColor)}`);
  if (options.color) cssProps.push(`color:${cssColor(options.color)}`);
  if (options.border) cssProps.push(`border:${options.border}`);
  if (options.borderColor) cssProps.push(`border-color:${cssColor(options.borderColor)}`);
  if (options.borderStyle) cssProps.push(`border-style:${options.borderStyle}`);
  if (options.borderWidth) cssProps.push(`border-width:${options.borderWidth}`);
  if (options.borderRadius) cssProps.push(`border-radius:${options.borderRadius}`);
  if (options.fontStyle) cssProps.push(`font-style:${options.fontStyle}`);
  if (options.fontWeight) cssProps.push(`font-weight:${options.fontWeight}`);
  if (options.textDecoration) cssProps.push(`text-decoration:${options.textDecoration}`);
  if (options.cursor) cssProps.push(`cursor:${options.cursor}`);
  if (options.opacity) cssProps.push(`opacity:${options.opacity}`);
  if (options.letterSpacing) cssProps.push(`letter-spacing:${options.letterSpacing}`);
  if (options.outlineColor) cssProps.push(`outline-color:${cssColor(options.outlineColor)}`);

  let css = '';
  if (cssProps.length) css += `.${className} { ${cssProps.join(';')} }\n`;

  // Gutter icon
  if (options.gutterIconPath) {
    const iconPath = typeof options.gutterIconPath === 'string' ? options.gutterIconPath : options.gutterIconPath.fsPath || options.gutterIconPath.toString();
    const iconSize = options.gutterIconSize || 'contain';
    css += `.line-number.${className} { background-image:url('${iconPath}');background-size:${iconSize};background-repeat:no-repeat;background-position:center; }\n`;
  }

  // after/before pseudo-element content
  if (options.before && options.before.contentText) {
    css += `.${className}::before { content:'${options.before.contentText}';color:${options.before.color ? cssColor(options.before.color) : 'inherit'}; }\n`;
  }
  if (options.after && options.after.contentText) {
    css += `.${className}::after { content:'${options.after.contentText}';color:${options.after.color ? cssColor(options.after.color) : 'inherit'}; }\n`;
  }

  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  return new TextEditorDecorationType(options, styleEl);
}

function cssColor(c) {
  if (!c) return 'transparent';
  if (typeof c === 'string') return c;
  if (c.id) return `var(--${c.id.replace(/\./g, '-')})`;
  return 'transparent';
}

// --- Status bar ---
function createStatusBarItem(alignmentOrId, priority) {
  let alignment, id;
  if (typeof alignmentOrId === 'object' && alignmentOrId !== null) {
    alignment = alignmentOrId.alignment;
    id = alignmentOrId.id;
    priority = alignmentOrId.priority;
  } else {
    alignment = alignmentOrId;
  }
  const item = new StatusBarItem(alignment, priority, _statusBarService);
  if (id) item.id = id;
  return item;
}

// --- Terminal ---
function createTerminal(options) {
  ensureTerminalOpener();
  const terminal = new CompatTerminal(normalizeTerminalOptions(...arguments));
  _terminals.push(terminal);
  _terminalItemsByUri.set(terminal._uri, terminal._item);
  _activeTerminal = terminal;
  _onDidOpenTerminal.fire(terminal);

  // VSCode terminals are often shown explicitly later, but Calva's pseudo-terminal
  // is user-facing output. In Pulsar, creating the pane without opening it makes the
  // terminal effectively invisible, so reveal it immediately unless the extension
  // explicitly asked for a hidden terminal.
  if (!terminal.creationOptions.hideFromUser) {
    terminal.show(true);
  }

  return terminal;
}

function normalizeTerminalOptions(options, shellPath, shellArgs) {
  if (typeof options === 'string') {
    return { name: options, shellPath, shellArgs };
  }
  return options || {};
}

function ensureTerminalOpener() {
  if (_terminalOpenerDisposable) return;
  _terminalOpenerDisposable = atom.workspace.addOpener(uri => {
    const value = typeof uri === 'string' ? uri : uri && uri.toString ? uri.toString() : String(uri);
    if (!value.startsWith('pulsar://pulsar-vscode-compat/terminal/')) return;
    return _terminalItemsByUri.get(value);
  });
}

class CompatTerminal {
  constructor(options) {
    this.name = options.name || 'Terminal';
    this.processId = Promise.resolve(undefined);
    this.creationOptions = options;
    this.exitStatus = undefined;
    this.state = { isInteractedWith: false };
    this.shellIntegration = undefined;
    this._id = ++_terminalCounter;
    this._uri = `pulsar://pulsar-vscode-compat/terminal/${this._id}`;
    this._pty = options.pty;
    this._disposed = false;
    this._opened = false;
    this._content = '';
    this._element = createTerminalElement(this);
    this._item = createTerminalPaneItem(this);

    if (this._pty && typeof this._pty.onDidWrite === 'function') {
      this._writeDisposable = this._pty.onDidWrite(data => this._append(data));
    }
    if (this._pty && typeof this._pty.onDidClose === 'function') {
      this._closeDisposable = this._pty.onDidClose(() => this.dispose());
    }
    if (this._pty && typeof this._pty.onDidExit === 'function') {
      this._exitDisposable = this._pty.onDidExit(code => {
        this.exitStatus = { code, reason: 2 };
        _onDidChangeTerminalState.fire(this);
      });
    }
  }

  sendText(text, addNewLine = true) {
    this.state.isInteractedWith = true;
    const data = String(text) + (addNewLine === false ? '' : '\r');
    if (this._pty && typeof this._pty.handleInput === 'function') {
      this._pty.handleInput(data);
    } else {
      this._append(data.replace(/\r/g, '\n'));
    }
    _onDidChangeTerminalState.fire(this);
  }

  show(preserveFocus) {
    if (this._disposed) return;
    if (!this._opened && this._pty && typeof this._pty.open === 'function') {
      this._opened = true;
      try { this._pty.open(this._initialDimensions()); } catch (e) {}
    }
    _activeTerminal = this;

    const bottomDock = atom.workspace.getBottomDock && atom.workspace.getBottomDock();
    if (bottomDock && typeof bottomDock.show === 'function') {
      bottomDock.show();
    }

    const opened = atom.workspace.open(this._uri, {
      location: 'bottom',
      activatePane: !preserveFocus,
      activateItem: true,
      searchAllPanes: true,
      pending: false
    });

    Promise.resolve(opened).then(() => {
      const dock = atom.workspace.getBottomDock && atom.workspace.getBottomDock();
      if (dock && typeof dock.show === 'function') dock.show();
      if (!preserveFocus) {
        if (dock && typeof dock.activate === 'function') dock.activate();
        this.focus();
      }
    }).catch(() => {});
  }

  focus() {
    if (this._outputElement && typeof this._outputElement.focus === 'function') {
      this._outputElement.focus();
    }
  }

  clear() {
    this._content = '';
    if (this._outputElement) this._outputElement.innerHTML = '';
  }

  _initialDimensions() {
    return { columns: 80, rows: 24 };
  }

  hide() {
    const dock = atom.workspace.getBottomDock && atom.workspace.getBottomDock();
    if (dock && typeof dock.hide === 'function') {
      dock.hide();
    }
  }

  dispose() {
    this._dispose(true, true);
  }

  _dispose(closePty, destroyPane) {
    if (this._disposed) return;
    this._disposed = true;
    try { if (this._writeDisposable) this._writeDisposable.dispose(); } catch (e) {}
    try { if (this._closeDisposable) this._closeDisposable.dispose(); } catch (e) {}
    try { if (this._exitDisposable) this._exitDisposable.dispose(); } catch (e) {}
    try { if (closePty && this._pty && typeof this._pty.close === 'function') this._pty.close(); } catch (e) {}
    _terminalItemsByUri.delete(this._uri);
    const idx = _terminals.indexOf(this);
    if (idx >= 0) _terminals.splice(idx, 1);
    if (_activeTerminal === this) _activeTerminal = _terminals[_terminals.length - 1];
    if (destroyPane) {
      const pane = atom.workspace.paneForItem(this._item);
      if (pane) pane.destroyItem(this._item);
    }
    _onDidCloseTerminal.fire(this);
  }

  _append(data) {
    const raw = String(data);
    if (raw.includes('\x1b[2J')) this._content = '';
    const text = stripUnsupportedTerminalSequences(raw)
      .replace(/\x1b\[2J\x1b\[H/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
    this._content += text;
    this._outputElement.innerHTML = terminalAnsiToHtml(this._content);
    this._outputElement.scrollTop = this._outputElement.scrollHeight;
  }
}

function createTerminalElement(terminal) {
  const container = document.createElement('div');
  container.classList.add('pulsar-vscode-compat-terminal-container');
  container.dataset.terminalName = terminal.name;
  container.style.cssText = 'height:100%;min-height:180px;display:flex;flex-direction:column;background:var(--terminal-background-color,var(--base-background-color,#1e1e1e));color:var(--text-color,#d4d4d4);';

  const toolbar = document.createElement('div');
  toolbar.classList.add('pulsar-vscode-compat-terminal-toolbar');
  toolbar.style.cssText = 'display:flex;align-items:center;gap:4px;min-height:28px;padding:2px 6px;border-bottom:1px solid var(--base-border-color,#333);background:var(--tool-panel-background-color,var(--base-background-color,#252526));user-select:none;';

  const title = document.createElement('span');
  title.textContent = terminal.name;
  title.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;opacity:0.85;';
  toolbar.appendChild(title);

  toolbar.appendChild(createTerminalToolbarButton('↻', 'Clear Terminal', () => terminal.clear()));
  toolbar.appendChild(createTerminalToolbarButton('⌖', 'Focus Terminal', () => terminal.focus()));
  toolbar.appendChild(createTerminalToolbarButton('—', 'Hide Terminal', () => terminal.hide()));
  toolbar.appendChild(createTerminalToolbarButton('×', 'Close Terminal', () => terminal.dispose()));

  const output = document.createElement('pre');
  output.classList.add('pulsar-vscode-compat-terminal');
  output.tabIndex = 0;
  output.style.cssText = 'flex:1;height:100%;overflow:auto;margin:0;padding:8px;background:transparent;color:inherit;font-family:var(--editor-font-family,monospace);font-size:var(--editor-font-size,12px);white-space:pre-wrap;outline:none;';
  output.addEventListener('keydown', event => {
    if (!terminal._pty || typeof terminal._pty.handleInput !== 'function') return;
    if (event.key === 'Enter') terminal._pty.handleInput('\r');
    else if (event.key === 'Backspace') terminal._pty.handleInput('\x7f');
    else if (event.key === 'c' && event.ctrlKey) terminal._pty.handleInput('\x03');
    else if (event.key === 'l' && event.ctrlKey) terminal.clear();
    else if (event.key.length === 1) terminal._pty.handleInput(event.key);
    else return;
    event.preventDefault();
  });

  terminal._outputElement = output;
  container.appendChild(toolbar);
  container.appendChild(output);
  return container;
}

function createTerminalToolbarButton(label, title, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-label', title);
  button.style.cssText = 'min-width:24px;height:22px;padding:0 5px;border:1px solid transparent;border-radius:3px;background:transparent;color:inherit;opacity:0.8;cursor:pointer;font:inherit;line-height:1;';
  button.addEventListener('mouseenter', () => {
    button.style.background = 'var(--button-background-color,var(--background-color-highlight,#3a3d41))';
    button.style.borderColor = 'var(--button-border-color,var(--base-border-color,#555))';
    button.style.opacity = '1';
  });
  button.addEventListener('mouseleave', () => {
    button.style.background = 'transparent';
    button.style.borderColor = 'transparent';
    button.style.opacity = '0.8';
  });
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

function createTerminalPaneItem(terminal) {
  return {
    getTitle() { return terminal.name; },
    getURI() { return terminal._uri; },
    getElement() { return terminal._element; },
    getDefaultLocation() { return 'bottom'; },
    getAllowedLocations() { return ['bottom', 'center']; },
    isPermanentDockItem() { return false; },
    destroy() { terminal._dispose(true, false); }
  };
}

// --- Webview ---
function createWebviewPanel(viewType, title, showOptions, options) {
  const column = typeof showOptions === 'number' ? showOptions : (showOptions && showOptions.viewColumn) || ViewColumn.One;
  const preserveFocus = showOptions && showOptions.preserveFocus;

  const container = document.createElement('div');
  container.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;';

  const iframe = document.createElement('iframe');
  iframe.style.cssText = 'flex:1;width:100%;border:none;';
  iframe.sandbox = 'allow-scripts allow-same-origin';
  container.appendChild(iframe);

  const { EventEmitter: EE } = require('../types/event-emitter');
  const _onDidDispose = new EE();
  const _onDidChangeViewState = new EE();
  const _onDidReceiveMessage = new EE();

  let _html = '';
  const webview = {
    options: options && options.webviewOptions || {},
    html: '',
    cspSource: 'pulsar-webview:',
    onDidReceiveMessage: _onDidReceiveMessage.event,
    postMessage(message) {
      try { iframe.contentWindow.postMessage(message, '*'); } catch (e) {}
      return Promise.resolve();
    },
    asWebviewUri(uri) { return uri; }
  };

  Object.defineProperty(webview, 'html', {
    get() { return _html; },
    set(v) {
      _html = v;
      // Use blob URL to avoid CSP issues
      const blob = new Blob([v], { type: 'text/html' });
      iframe.src = URL.createObjectURL(blob);
    }
  });

  window.addEventListener('message', e => {
    if (e.source === iframe.contentWindow) _onDidReceiveMessage.fire(e.data);
  });

  const paneItem = {
    getTitle() { return title; },
    getElement() { return container; },
    getDefaultLocation() { return 'center'; },
    getAllowedLocations() { return ['center', 'left', 'right', 'bottom']; },
    isPermanentDockItem() { return false; },
    onDidDestroy(cb) { return _onDidDispose.event(cb); },
    destroy() { _onDidDispose.fire(); }
  };

  const panel = { destroy() { paneItem.destroy(); } };
  atom.workspace.open(paneItem, { activatePane: !preserveFocus });

  return {
    viewType,
    title,
    webview,
    options: options || {},
    get active() { return atom.workspace.getActivePaneItem() === paneItem; },
    get visible() { return true; },
    get viewColumn() { return ViewColumn.One; },
    iconPath: undefined,
    reveal(viewColumn, pf) { atom.workspace.paneForItem(paneItem) && atom.workspace.paneForItem(paneItem).activate(); },
    dispose() { paneItem.destroy(); },
    onDidDispose: _onDidDispose.event,
    onDidChangeViewState: _onDidChangeViewState.event
  };
}

// --- Tree view ---
const treeDataProviders = new Map();

function registerTreeDataProvider(viewId, dataProvider) {
  treeDataProviders.set(viewId, dataProvider);
  return new Disposable(() => treeDataProviders.delete(viewId));
}

function createTreeView(viewId, options) {
  const provider = options.treeDataProvider;
  treeDataProviders.set(viewId, provider);
  const dockItem = _createTreeDockItem(viewId, provider, options);

  const _onDidExpandElement = new EventEmitter();
  const _onDidCollapseElement = new EventEmitter();
  const _onDidChangeSelection = new EventEmitter();
  const _onDidChangeVisibility = new EventEmitter();
  const _onDidChangeCheckboxState = new EventEmitter();

  return {
    get selection() { return []; },
    get visible() { return true; },
    get message() { return dockItem._message; },
    set message(v) { dockItem._setMessage(v); },
    get title() { return viewId; },
    set title(v) { dockItem._setTitle(v); },
    get description() { return ''; },
    set description(v) {},
    get badge() { return undefined; },
    set badge(v) {},
    canSelectMany: options.canSelectMany || false,
    showCollapseAll: options.showCollapseAll || false,
    reveal(element, opts) { return Promise.resolve(); },
    dispose() {},
    onDidExpandElement: _onDidExpandElement.event,
    onDidCollapseElement: _onDidCollapseElement.event,
    onDidChangeSelection: _onDidChangeSelection.event,
    onDidChangeVisibility: _onDidChangeVisibility.event,
    onDidChangeCheckboxState: _onDidChangeCheckboxState.event
  };
}

function _createTreeDockItem(viewId, provider, options) {
  const container = document.createElement('div');
  container.style.cssText = 'overflow:auto;height:100%;padding:4px;';

  let _message = '';
  let _title = viewId;

  const item = {
    getTitle() { return _title; },
    getElement() { return container; },
    getDefaultLocation() { return 'left'; },
    getAllowedLocations() { return ['left', 'right', 'bottom']; },
    _message,
    _setMessage(v) { _message = v; },
    _setTitle(v) { _title = v; }
  };

  const refresh = async () => {
    container.innerHTML = '';
    try {
      const roots = await Promise.resolve(provider.getChildren());
      if (!roots || !roots.length) return;
      const ul = await _renderTreeNodes(roots, provider, 0);
      container.appendChild(ul);
    } catch (e) {}
  };

  if (provider.onDidChangeTreeData) {
    provider.onDidChangeTreeData(() => refresh());
  }

  refresh();
  atom.workspace.open(item, { location: 'left', activatePane: false, activateItem: false, searchAllPanes: true });
  return item;
}

async function _renderTreeNodes(elements, provider, depth) {
  const ul = document.createElement('ul');
  ul.style.cssText = 'list-style:none;padding:0;margin:0;';
  for (const el of elements) {
    const treeItem = await Promise.resolve(provider.getTreeItem(el));
    const li = document.createElement('li');
    const { TreeItemCollapsibleState } = require('../types/tree-item');

    const label = typeof treeItem.label === 'string' ? treeItem.label
      : (treeItem.label && treeItem.label.label) || (treeItem.resourceUri && treeItem.resourceUri.fsPath.split('/').pop()) || '';
    li.style.cssText = `padding-left:${depth * 12}px;cursor:pointer;line-height:22px;`;
    li.textContent = (treeItem.collapsibleState !== TreeItemCollapsibleState.None ? (treeItem.collapsibleState === TreeItemCollapsibleState.Expanded ? '▾ ' : '▸ ') : '  ') + label;

    if (treeItem.tooltip) li.title = typeof treeItem.tooltip === 'string' ? treeItem.tooltip : (treeItem.tooltip.value || '');

    if (treeItem.command) {
      li.addEventListener('click', () => {
        try { atom.commands.dispatch(atom.views.getView(atom.workspace), treeItem.command.command, treeItem.command.arguments); } catch(e) {}
      });
    }

    ul.appendChild(li);

    if (treeItem.collapsibleState === TreeItemCollapsibleState.Expanded) {
      const children = await Promise.resolve(provider.getChildren(el));
      if (children && children.length) {
        const childUl = await _renderTreeNodes(children, provider, depth + 1);
        ul.appendChild(childUl);
      }
    }
  }
  return ul;
}

// --- URI handler ---
function registerUriHandler(handler) {
  const opener = atom.workspace.addOpener(uri => {
    if (handler.handleUri) {
      try { handler.handleUri(Uri.parse(uri)); } catch (e) {}
    }
  });
  return new Disposable(() => opener.dispose());
}

// --- Status bar message ---
function setStatusBarMessage(text, hideAfterOrThenable) {
  if (!_statusBarService) return new Disposable(() => {});
  const el = document.createElement('span');
  el.textContent = text;
  const tile = _statusBarService.addLeftTile({ item: el, priority: -1 });
  const dispose = () => tile.destroy();

  if (typeof hideAfterOrThenable === 'number') {
    setTimeout(dispose, hideAfterOrThenable);
  } else if (hideAfterOrThenable && typeof hideAfterOrThenable.then === 'function') {
    hideAfterOrThenable.then(dispose, dispose);
  }
  return new Disposable(dispose);
}

// --- Misc stubs ---
function registerWebviewPanelSerializer(viewType, serializer) { return new Disposable(() => {}); }
function registerWebviewViewProvider(viewType, provider, options) { return new Disposable(() => {}); }
function registerCustomEditorProvider(viewType, provider, options) { return new Disposable(() => {}); }
function registerFileDecorationProvider(provider) { return new Disposable(() => {}); }

function workspaceTextEditors() {
  try {
    return atom.workspace.getTextEditors ? atom.workspace.getTextEditors() : [];
  } catch (e) {
    return [];
  }
}

function isUsableAtomTextEditor(editor) {
  if (!editor ||
    typeof editor.getBuffer !== 'function' ||
    typeof editor.isDestroyed !== 'function' ||
    editor.isDestroyed() ||
    !workspaceTextEditors().includes(editor)) {
    return false;
  }

  try {
    return !atom.workspace.paneForItem || !!atom.workspace.paneForItem(editor);
  } catch (e) {
    return false;
  }
}

function activePaneTextEditor() {
  const panes = atom.workspace.getPanes ? atom.workspace.getPanes() : [];
  for (const pane of panes) {
    const item = pane && pane.getActiveItem && pane.getActiveItem();
    if (isUsableAtomTextEditor(item)) return item;
  }
  return undefined;
}

function getActiveAtomTextEditor() {
  if (isUsableAtomTextEditor(_activeTextEditorOverride)) {
    return _activeTextEditorOverride;
  }

  const activeEditor = atom.workspace.getActiveTextEditor && atom.workspace.getActiveTextEditor();
  if (isUsableAtomTextEditor(activeEditor)) return activeEditor;

  const activePaneItem = atom.workspace.getActivePaneItem && atom.workspace.getActivePaneItem();
  if (isUsableAtomTextEditor(activePaneItem)) {
    _lastActiveTextEditor = activePaneItem;
    return activePaneItem;
  }

  if (isUsableAtomTextEditor(_lastActiveTextEditor)) {
    return _lastActiveTextEditor;
  }

  const paneEditor = activePaneTextEditor();
  if (paneEditor) return paneEditor;

  const editors = workspaceTextEditors();
  return editors.find(isUsableAtomTextEditor) || undefined;
}

function _withActiveTextEditorOverride(editor, callback) {
  const previous = _activeTextEditorOverride;
  if (isUsableAtomTextEditor(editor)) {
    _activeTextEditorOverride = editor;
    _lastActiveTextEditor = editor;
  }

  let result;
  try {
    result = callback();
  } catch (e) {
    _activeTextEditorOverride = previous;
    throw e;
  }

  if (result && typeof result.then === 'function') {
    return result.finally(() => {
      _activeTextEditorOverride = previous;
    });
  }

  _activeTextEditorOverride = previous;
  return result;
}

module.exports = {
  get activeTextEditor() { return wrapEditor(getActiveAtomTextEditor()); },
  get visibleTextEditors() { return atom.workspace.getTextEditors().map(wrapEditor); },
  get activeTerminal() { return _activeTerminal; },
  get terminals() { return _terminals.slice(); },
  get activeNotebookEditor() { return undefined; },
  get visibleNotebookEditors() { return []; },
  get tabGroups() {
    return { all: [], activeTabGroup: null, onDidChangeTabGroups: new EventEmitter().event, onDidChangeTabs: new EventEmitter().event };
  },
  get state() { return { focused: document.hasFocus() }; },
  get activeColorTheme() {
    const names = (atom.themes.getActiveThemeNames && atom.themes.getActiveThemeNames()) || [];
    const isDark = names.some(n => n.includes('dark'));
    return { kind: isDark ? 2 : 1, id: names[0] || 'default' };
  },

  showTextDocument,
  showInformationMessage,
  showWarningMessage,
  showErrorMessage,
  showQuickPick,
  showInputBox,
  showOpenDialog,
  showSaveDialog,
  showWorkspaceFolderPick,
  withProgress,
  createOutputChannel,
  createTextEditorDecorationType,
  createTerminal,
  createWebviewPanel,
  createStatusBarItem,
  registerTreeDataProvider,
  createTreeView,
  registerUriHandler,
  registerWebviewPanelSerializer,
  registerWebviewViewProvider,
  registerCustomEditorProvider,
  registerFileDecorationProvider,
  setStatusBarMessage,

  onDidChangeActiveTextEditor: _onDidChangeActiveTextEditor.event,
  onDidChangeVisibleTextEditors: _onDidChangeVisibleTextEditors.event,
  onDidChangeTextEditorSelection: _onDidChangeTextEditorSelection.event,
  onDidChangeTextEditorVisibleRanges: _onDidChangeTextEditorVisibleRanges.event,
  onDidChangeTextEditorOptions: _onDidChangeTextEditorOptions.event,
  onDidChangeTextEditorViewColumn: _onDidChangeTextEditorViewColumn.event,
  onDidChangeWindowState: _onDidChangeWindowState.event,
  onDidChangeActiveColorTheme: _onDidChangeActiveColorTheme.event,
  onDidOpenTerminal: _onDidOpenTerminal.event,
  onDidCloseTerminal: _onDidCloseTerminal.event,
  onDidChangeTerminalState: _onDidChangeTerminalState.event,
  onDidChangeActiveNotebookEditor: _onDidChangeActiveNotebookEditor.event,
  onDidChangeVisibleNotebookEditors: _onDidChangeVisibleNotebookEditors.event,
  onDidChangeNotebookEditorSelection: _onDidChangeNotebookEditorSelection.event,
  onDidChangeNotebookEditorVisibleRanges: _onDidChangeNotebookEditorVisibleRanges.event,

  consumeStatusBar,
  _init,
  _withActiveTextEditorOverride
};
