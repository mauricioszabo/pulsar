'use strict';

// Types
const { Position } = require('./types/position');
const { Range } = require('./types/range');
const { Selection } = require('./types/selection');
const { Uri } = require('./types/uri');
const { CancellationToken, CancellationTokenSource } = require('./types/cancellation');
const { Disposable } = require('./types/disposable');
const { EventEmitter } = require('./types/event-emitter');
const { MarkdownString } = require('./types/markdown-string');
const { ThemeColor, ThemeIcon } = require('./types/theme-color');
const { TextEdit, SnippetString } = require('./types/text-edit');
const { WorkspaceEdit } = require('./types/workspace-edit');
const { Diagnostic, DiagnosticSeverity, DiagnosticTag, DiagnosticRelatedInformation, DiagnosticCollection } = require('./types/diagnostic');
const { CompletionItem, CompletionItemKind, CompletionItemTag, CompletionList, CompletionTriggerKind, CompletionItemInsertTextRule } = require('./types/completion');
const { Hover } = require('./types/hover');
const { Location, LocationLink, SymbolInformation, DocumentSymbol, SymbolKind, SymbolTag } = require('./types/location');
const { CodeAction, CodeActionKind, CodeActionTriggerKind } = require('./types/code-action');
const { CodeLens } = require('./types/code-lens');
const { FoldingRange, FoldingRangeKind } = require('./types/folding-range');
const { DocumentLink } = require('./types/document-link');
const { Color, ColorInformation, ColorPresentation } = require('./types/color');
const { SignatureHelp, SignatureInformation, ParameterInformation, SignatureHelpTriggerKind } = require('./types/signature-help');
const { SemanticTokens, SemanticTokensBuilder, SemanticTokensLegend, SemanticTokensEdit, SemanticTokensEdits } = require('./types/semantic-tokens');
const { InlayHint, InlayHintKind, InlayHintLabelPart } = require('./types/inlay-hint');
const { TreeItem, TreeItemCollapsibleState, TreeItemCheckboxState } = require('./types/tree-item');
const { TextDocument, TextLine, TextDocumentSaveReason, EndOfLine } = require('./types/text-document');
const { TextEditor, TextEditorDecorationType, TextEditorEdit, ViewColumn, TextEditorRevealType, TextEditorLineNumbersStyle, TextEditorSelectionChangeKind, OverviewRulerLane, DecorationRangeBehavior } = require('./types/text-editor');
const { OutputChannel, LogOutputChannel, LogLevel } = require('./types/output-channel');
const { StatusBarItem, StatusBarAlignment } = require('./types/status-bar-item');
const { FileSystemWatcher, FileChangeType } = require('./types/file-system-watcher');

// Namespaces
const commands = require('./namespaces/commands');
const env = require('./namespaces/env');
const extensions = require('./namespaces/extensions');
const window = require('./namespaces/window');
const workspace = require('./namespaces/workspace');
const languages = require('./namespaces/languages');
const l10n = require('./namespaces/l10n');
const scm = require('./namespaces/scm');
const debug = require('./namespaces/debug');
const tasks = require('./namespaces/tasks');
const tests = require('./namespaces/tests');
const authentication = require('./namespaces/authentication');
const comments = require('./namespaces/comments');
const notebooks = require('./namespaces/notebooks');
const lm = require('./namespaces/lm');
const chat = require('./namespaces/chat');

// Additional enums and types not covered above
const ConfigurationTarget = Object.freeze({ Global: 1, Workspace: 2, WorkspaceFolder: 3 });
const ExtensionKind = Object.freeze({ UI: 1, Workspace: 2 });
const ExtensionMode = Object.freeze({ Production: 1, Development: 2, Test: 3 });
const ProgressLocation = Object.freeze({ SourceControl: 1, Window: 10, Notification: 15 });
const TextEditorCursorStyle = Object.freeze({ Line: 1, Block: 2, Underline: 3, LineThin: 4, BlockOutline: 5, UnderlineThin: 6 });
const IndentAction = Object.freeze({ None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 });
const CompletionItemKindNames = CompletionItemKind;
const DocumentHighlightKind = Object.freeze({ Text: 0, Read: 1, Write: 2 });
const ColorThemeKind = Object.freeze({ Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 });
const NotebookCellKind = Object.freeze({ Markup: 1, Code: 2 });
const NotebookEditorRevealType = Object.freeze({ Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 });
const NotebookControllerAffinity = Object.freeze({ Default: 1, Preferred: 2 });
const DebugConfigurationType = Object.freeze({ Single: 'single', Multiple: 'multiple' });
const TestRunProfileKind = Object.freeze({ Run: 1, Debug: 2, Coverage: 3 });
const LanguageStatusSeverity = Object.freeze({ Information: 0, Warning: 1, Error: 2 });
const QuickPickItemKind = Object.freeze({ Separator: -1, Default: 0 });
const UIKind = Object.freeze({ Desktop: 1, Web: 2 });
const FileType = Object.freeze({ Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 });
const FilePermission = Object.freeze({ Readonly: 1 });
const TaskRevealKind = Object.freeze({ Always: 1, Silent: 2, Never: 3 });
const TaskPanelKind = Object.freeze({ Shared: 1, Dedicated: 2, New: 3 });
const TaskScope = Object.freeze({ Global: 1, Workspace: 2 });
const ShellQuoting = Object.freeze({ Escape: 1, Strong: 2, Weak: 3 });
const TerminalLocation = Object.freeze({ Panel: 1, Editor: 2 });
const TerminalExitReason = Object.freeze({ Unknown: 0, Shutdown: 1, Process: 2, User: 3, Extension: 4 });
const InlayHintKindValues = InlayHintKind;
const SignatureHelpTriggerKindValues = SignatureHelpTriggerKind;
const SymbolKindValues = SymbolKind;
const TextDocumentSaveReasonValues = TextDocumentSaveReason;
const InlineCompletionTriggerKind = Object.freeze({ Invoke: 0, Automatic: 1 });
const LinkedEditingRanges = class { constructor(ranges, wordPattern) { this.ranges = ranges; this.wordPattern = wordPattern; } };
const SelectionRange = class { constructor(range, parent) { this.range = range; this.parent = parent; } };
const CallHierarchyItem = class { constructor(kind, name, detail, uri, range, selectionRange) { Object.assign(this, {kind, name, detail, uri, range, selectionRange}); } };
const CallHierarchyIncomingCall = class { constructor(from, fromRanges) { this.from = from; this.fromRanges = fromRanges; } };
const CallHierarchyOutgoingCall = class { constructor(to, fromRanges) { this.to = to; this.fromRanges = fromRanges; } };
const TypeHierarchyItem = class { constructor(kind, name, detail, uri, range, selectionRange) { Object.assign(this, {kind, name, detail, uri, range, selectionRange}); } };
const DocumentDropEdit = class { constructor(insertText, label) { this.insertText = insertText; this.label = label; this.additionalEdit = undefined; } };
const InlineCompletionItem = class { constructor(insertText, range, command) { this.insertText = insertText; this.range = range; this.command = command; } };
const InlineCompletionList = class { constructor(items) { this.items = items; } };
const InlineValueText = class { constructor(range, text) { this.range = range; this.text = text; } };
const InlineValueVariableLookup = class { constructor(range, variableName, caseSensitiveLookup) { Object.assign(this, {range, variableName, caseSensitiveLookup}); } };
const InlineValueEvaluatableExpression = class { constructor(range, expression) { this.range = range; this.expression = expression; } };
const InlineValueContext = class { constructor(frameId, stoppedLocation) { Object.assign(this, {frameId, stoppedLocation}); } };
const EvaluatableExpression = class { constructor(range, expression) { this.range = range; this.expression = expression; } };
const DocumentHighlight = class { constructor(range, kind) { this.range = range; this.kind = kind; } };
const WorkspaceSymbol = class { constructor(name, kind, containerName, locationOrUri) { Object.assign(this, {name, kind, containerName}); if (locationOrUri) this.location = locationOrUri; } };
const DiagnosticChangeEvent = class {};
const FileRenameEvent = class { constructor(files) { this.files = files; } };
const FileCreateEvent = class { constructor(files) { this.files = files; } };
const FileDeleteEvent = class { constructor(files) { this.files = files; } };
const FileWillCreateEvent = class {};
const FileWillDeleteEvent = class {};
const FileWillRenameEvent = class {};
const WindowState = class { constructor(focused) { this.focused = focused; } };
const RelativePattern = class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } };
const GlobPattern = RelativePattern;
const TabInputText = class { constructor(uri) { this.uri = uri; } };
const TabInputNotebook = class { constructor(uri, notebookType) { this.uri = uri; this.notebookType = notebookType; } };
const TabInputCustom = class { constructor(uri, viewType) { this.uri = uri; this.viewType = viewType; } };
const TabInputWebview = class { constructor(viewType) { this.viewType = viewType; } };
const TabInputTerminal = class {};
const DataTransferItem = class { constructor(value) { this.value = value; } asString() { return Promise.resolve(String(this.value)); } };
const DataTransfer = class {
  constructor() { this._map = new Map(); }
  get(mimeType) { return this._map.get(mimeType); }
  set(mimeType, value) { this._map.set(mimeType, value); }
  forEach(fn) { this._map.forEach(fn); }
  [Symbol.iterator]() { return this._map.entries(); }
};
const DocumentPasteEdit = class { constructor(label, insertText) { this.label = label; this.insertText = insertText; this.additionalEdit = undefined; } };
const NotebookEdit = class {
  static replaceCells(range, newCells) { return { range, newCells, type: 'replace' }; }
  static insertCells(index, newCells) { return { index, newCells, type: 'insert' }; }
  static deleteCells(range) { return { range, type: 'delete' }; }
  static updateCellMetadata(index, newCellMetadata) { return { index, newCellMetadata, type: 'updateMetadata' }; }
};

class FileDecoration {
  constructor(badge, tooltip, color) {
    this.badge = badge;
    this.tooltip = tooltip;
    this.color = color;
    this.propagate = false;
  }
}

class LanguageStatusItem {
  constructor(id, selector) { this.id = id; this.selector = selector; this.name = id; this.severity = 0; this.text = ''; this.detail = ''; this.busy = false; this.command = undefined; this.accessibilityInformation = undefined; }
  dispose() {}
}

function createLanguageStatusItem(id, selector) { return new LanguageStatusItem(id, selector); }
function createQuickPick() {
  const { EventEmitter: EE } = require('./types/event-emitter');
  const _onDidChangeValue = new EE();
  const _onDidChangeSelection = new EE();
  const _onDidAccept = new EE();
  const _onDidHide = new EE();
  const _onDidTriggerButton = new EE();

  let _panel = null;
  const qp = {
    items: [], canSelectMany: false, matchOnDescription: false, matchOnDetail: false,
    activeItems: [], selectedItems: [], value: '', placeholder: '', title: '',
    step: undefined, totalSteps: undefined, buttons: [], busy: false, enabled: true,
    ignoreFocusOut: false, keepScrollPosition: false,
    onDidChangeValue: _onDidChangeValue.event,
    onDidChangeSelection: _onDidChangeSelection.event,
    onDidAccept: _onDidAccept.event,
    onDidHide: _onDidHide.event,
    onDidTriggerButton: _onDidTriggerButton.event,
    onDidTriggerItemButton: new EE().event,
    show() {
      window.showQuickPick(qp.items, { placeHolder: qp.placeholder }).then(item => {
        if (item) { qp.selectedItems = [item]; _onDidAccept.fire(); }
        else _onDidHide.fire();
      });
    },
    hide() { _onDidHide.fire(); },
    dispose() {}
  };
  return qp;
}

function createInputBox() {
  const { EventEmitter: EE } = require('./types/event-emitter');
  const _onDidChangeValue = new EE();
  const _onDidAccept = new EE();
  const _onDidHide = new EE();
  const _onDidTriggerButton = new EE();

  const ib = {
    value: '', placeholder: '', password: false, title: '', step: undefined, totalSteps: undefined,
    prompt: '', validationMessage: undefined, buttons: [], busy: false, enabled: true, ignoreFocusOut: false,
    onDidChangeValue: _onDidChangeValue.event,
    onDidAccept: _onDidAccept.event,
    onDidHide: _onDidHide.event,
    onDidTriggerButton: _onDidTriggerButton.event,
    show() {
      window.showInputBox({ prompt: ib.prompt, value: ib.value, placeHolder: ib.placeholder }).then(v => {
        if (v !== undefined) { ib.value = v; _onDidAccept.fire(); }
        else _onDidHide.fire();
      });
    },
    hide() { _onDidHide.fire(); },
    dispose() {}
  };
  return ib;
}

const vscode = {
  // Namespaces
  commands,
  env,
  extensions,
  window: {
    ...window,
    createQuickPick,
    createInputBox
  },
  workspace,
  languages,
  l10n,
  scm,
  debug,
  tasks,
  tests,
  authentication,
  comments,
  notebooks,
  lm,
  chat,

  // Core types
  Position,
  Range,
  Selection,
  Uri,
  CancellationToken,
  CancellationTokenSource,
  Disposable,
  EventEmitter,
  MarkdownString,
  ThemeColor,
  ThemeIcon,
  TextEdit,
  SnippetString,
  WorkspaceEdit,
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticTag,
  DiagnosticRelatedInformation,
  CompletionItem,
  CompletionItemKind,
  CompletionItemTag,
  CompletionList,
  CompletionTriggerKind,
  CompletionItemInsertTextRule,
  Hover,
  Location,
  LocationLink,
  SymbolInformation,
  DocumentSymbol,
  SymbolKind,
  SymbolTag,
  CodeAction,
  CodeActionKind,
  CodeActionTriggerKind,
  CodeLens,
  FoldingRange,
  FoldingRangeKind,
  DocumentLink,
  Color,
  ColorInformation,
  ColorPresentation,
  SignatureHelp,
  SignatureInformation,
  ParameterInformation,
  SignatureHelpTriggerKind,
  SemanticTokens,
  SemanticTokensBuilder,
  SemanticTokensLegend,
  SemanticTokensEdit,
  SemanticTokensEdits,
  InlayHint,
  InlayHintKind,
  InlayHintLabelPart,
  TreeItem,
  TreeItemCollapsibleState,
  TreeItemCheckboxState,
  TextDocumentSaveReason,
  EndOfLine,
  ViewColumn,
  TextEditorRevealType,
  TextEditorLineNumbersStyle,
  TextEditorSelectionChangeKind,
  OverviewRulerLane,
  DecorationRangeBehavior,
  StatusBarAlignment,
  FileChangeType,
  LogLevel,
  DocumentHighlight,
  DocumentHighlightKind,

  // Enums
  ConfigurationTarget,
  ExtensionKind,
  ExtensionMode,
  ProgressLocation,
  TextEditorCursorStyle,
  IndentAction,
  ColorThemeKind,
  NotebookCellKind,
  NotebookEditorRevealType,
  NotebookControllerAffinity,
  TestRunProfileKind,
  LanguageStatusSeverity,
  QuickPickItemKind,
  UIKind,
  FileType,
  FilePermission,
  TaskRevealKind,
  TaskPanelKind,
  TaskScope,
  ShellQuoting,
  TerminalLocation,
  TerminalExitReason,
  InlineCompletionTriggerKind,

  // Additional classes
  LinkedEditingRanges,
  SelectionRange,
  CallHierarchyItem,
  CallHierarchyIncomingCall,
  CallHierarchyOutgoingCall,
  TypeHierarchyItem,
  DocumentDropEdit,
  InlineCompletionItem,
  InlineCompletionList,
  InlineValueText,
  InlineValueVariableLookup,
  InlineValueEvaluatableExpression,
  InlineValueContext,
  EvaluatableExpression,
  WorkspaceSymbol,
  RelativePattern,
  FileDecoration,
  DataTransfer,
  DataTransferItem,
  DocumentPasteEdit,
  NotebookEdit,
  TabInputText,
  TabInputNotebook,
  TabInputCustom,
  TabInputWebview,
  TabInputTerminal,

  // window extras
  createLanguageStatusItem,

  version: atom.getVersion ? atom.getVersion() : '0.0.0'
};

module.exports = vscode;
