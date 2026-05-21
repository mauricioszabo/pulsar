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

function _init() {
  if (_initialized) return;
  _initialized = true;

  atom.workspace.onDidChangeActiveTextEditor(editor => {
    _onDidChangeActiveTextEditor.fire(editor ? new TextEditor(editor) : undefined);
  });

  atom.workspace.observeTextEditors(editor => {
    _onDidChangeVisibleTextEditors.fire(atom.workspace.getTextEditors().map(e => new TextEditor(e)));
    editor.onDidDestroy(() => {
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

// --- Notifications (Promise-based with button items) ---
function _showMessage(type, message, ...rest) {
  let items, options;
  if (rest.length && typeof rest[0] === 'object' && !Array.isArray(rest[0])) {
    options = rest[0];
    items = rest.slice(1);
  } else {
    items = rest;
    options = {};
  }
  const buttons = items.map(item => {
    const label = typeof item === 'string' ? item : item.title || String(item);
    return { text: label };
  });

  return new Promise(resolve => {
    const notifOpts = { dismissable: true };
    if (buttons.length) {
      notifOpts.buttons = buttons.map(b => ({
        text: b.text,
        onDidClick: () => { notif.dismiss(); resolve(b.text); }
      }));
    }
    if (options.detail) notifOpts.detail = options.detail;
    if (options.modal) notifOpts.dismissable = true;

    const notif = atom.notifications[`add${type}`](message, notifOpts);
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
      const { SelectListView } = (() => { try { return require('atom-select-list'); } catch(e) { return {}; } })();
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
  // Stub — returns a fake terminal object
  return {
    name: (options && options.name) || 'Terminal',
    processId: Promise.resolve(undefined),
    creationOptions: options || {},
    exitStatus: undefined,
    state: { isInteractedWith: false },
    shellIntegration: undefined,
    sendText(text, addNewLine) {},
    show(preserveFocus) {},
    hide() {},
    dispose() {}
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
  _createTreeDockItem(viewId, dataProvider, {});
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
  atom.workspace.addLeftPanel({ item, priority: 200, visible: true });
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

module.exports = {
  get activeTextEditor() { return wrapEditor(atom.workspace.getActiveTextEditor()); },
  get visibleTextEditors() { return atom.workspace.getTextEditors().map(wrapEditor); },
  get activeTerminal() { return undefined; },
  get terminals() { return []; },
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
  _init
};
