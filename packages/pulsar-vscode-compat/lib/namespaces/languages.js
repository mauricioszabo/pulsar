'use strict';

const { Disposable } = require('../types/disposable');
const { EventEmitter } = require('../types/event-emitter');
const { DiagnosticCollection, DiagnosticSeverity } = require('../types/diagnostic');
const { TextDocument, grammarToLanguageId } = require('../types/text-document');
const { Position } = require('../types/position');
const { Range } = require('../types/range');
const { CancellationTokenSource } = require('../types/cancellation');
const { matchesSelector } = require('../utils/selector');
const { makeAutocompleteProvider } = require('../adapters/completion-adapter');
const { registerHoverProvider: _registerHover } = require('../adapters/hover-adapter');
const { registerCodeLensProvider: _registerCodeLens } = require('../adapters/codelens-adapter');
const { registerDocumentHighlightProvider: _registerHighlight } = require('../adapters/highlight-adapter');
const { registerInlayHintsProvider: _registerInlayHints } = require('../adapters/inlay-hint-adapter');
const {
  registerDocumentFormattingEditProvider: _registerFormatting,
  registerDocumentRangeFormattingEditProvider: _registerRangeFormatting,
  registerOnTypeFormattingEditProvider: _registerOnTypeFormatting
} = require('../adapters/formatting-adapter');
const {
  makeSymbolProvider,
  makeReferenceProvider,
  makeFileSymbolProvider,
  makeProjectSymbolProvider
} = require('../adapters/definition-adapter');

let _linterIndie = null;

// Central registries shared with main.js for service provision
const completionProviders = [];
const symbolProviders = [];
const diagnosticCollections = [];

// Rename providers
const renameProviders = [];
// Code action providers
const codeActionProviders = [];
// Folding providers
const foldingProviders = [];
// Signature help providers
const signatureHelpProviders = [];
// Link providers
const linkProviders = [];

// ---- Public API ----

const languageStatusItems = [];

class LanguageStatusItem {
  constructor(id, selector) {
    this.id = id;
    this.selector = selector;
    this.name = id;
    this.text = '';
    this.detail = '';
    this.severity = 0;
    this.busy = false;
    this.command = undefined;
    this.accessibilityInformation = undefined;
    this._disposed = false;
  }

  dispose() {
    this._disposed = true;
    const idx = languageStatusItems.indexOf(this);
    if (idx >= 0) languageStatusItems.splice(idx, 1);
  }
}

function createLanguageStatusItem(id, selector) {
  const item = new LanguageStatusItem(id, selector);
  languageStatusItems.push(item);
  return item;
}

function createDiagnosticCollection(name) {
  const collection = new DiagnosticCollection(name || 'vscode-compat', _linterIndie);
  diagnosticCollections.push(collection);
  return collection;
}

function getDiagnostics(uri) {
  if (!uri) {
    const allDiags = [];
    for (const coll of diagnosticCollections) {
      coll.forEach((u, diags) => allDiags.push([u, diags]));
    }
    return allDiags;
  }
  const all = [];
  for (const coll of diagnosticCollections) {
    const diags = coll.get(uri);
    if (diags && diags.length) all.push(...diags);
  }
  return all;
}

function getLanguages() {
  return Promise.resolve(atom.grammars.getGrammars().map(g => grammarToLanguageId(g)));
}

function match(selector, document) {
  const scopeName = document._editor ? document._editor.getGrammar().scopeName : '';
  return matchesSelector(scopeName, selector);
}

function setLanguageConfiguration(language, configuration) {
  // Apply auto-closing pairs, word pattern, etc. to Atom grammar settings
  // This is best-effort: Atom grammars define these per-grammar natively
  return new Disposable(() => {});
}

function registerCompletionItemProvider(documentSelector, provider, ...triggerCharacters) {
  const atomProvider = makeAutocompleteProvider(documentSelector, provider, triggerCharacters);
  completionProviders.push(atomProvider);
  return new Disposable(() => {
    const idx = completionProviders.indexOf(atomProvider);
    if (idx >= 0) completionProviders.splice(idx, 1);
  });
}

function registerHoverProvider(documentSelector, provider) {
  return _registerHover(documentSelector, provider) || new Disposable(() => {});
}

function registerDefinitionProvider(documentSelector, provider) {
  const symProvider = makeSymbolProvider(`vscode-definition-${Date.now()}`, 'pulsar-vscode-compat', documentSelector, provider);
  symbolProviders.push(symProvider);
  return new Disposable(() => {
    const idx = symbolProviders.indexOf(symProvider);
    if (idx >= 0) symbolProviders.splice(idx, 1);
  });
}

function registerDeclarationProvider(documentSelector, provider) {
  const symProvider = makeSymbolProvider(`vscode-declaration-${Date.now()}`, 'pulsar-vscode-compat', documentSelector, {
    provideDefinition: provider.provideDeclaration ? provider.provideDeclaration.bind(provider) : () => null
  });
  symbolProviders.push(symProvider);
  return new Disposable(() => {
    const idx = symbolProviders.indexOf(symProvider);
    if (idx >= 0) symbolProviders.splice(idx, 1);
  });
}

function registerImplementationProvider(documentSelector, provider) {
  const symProvider = makeSymbolProvider(`vscode-implementation-${Date.now()}`, 'pulsar-vscode-compat', documentSelector, {
    provideDefinition: provider.provideImplementation ? provider.provideImplementation.bind(provider) : () => null
  });
  symbolProviders.push(symProvider);
  return new Disposable(() => {
    const idx = symbolProviders.indexOf(symProvider);
    if (idx >= 0) symbolProviders.splice(idx, 1);
  });
}

function registerTypeDefinitionProvider(documentSelector, provider) {
  const symProvider = makeSymbolProvider(`vscode-typedef-${Date.now()}`, 'pulsar-vscode-compat', documentSelector, {
    provideDefinition: provider.provideTypeDefinition ? provider.provideTypeDefinition.bind(provider) : () => null
  });
  symbolProviders.push(symProvider);
  return new Disposable(() => {
    const idx = symbolProviders.indexOf(symProvider);
    if (idx >= 0) symbolProviders.splice(idx, 1);
  });
}

function registerReferenceProvider(documentSelector, provider) {
  return registerReferencesProvider(documentSelector, provider);
}

function registerReferencesProvider(documentSelector, provider) {
  const symProvider = makeReferenceProvider(`vscode-references-${Date.now()}`, 'pulsar-vscode-compat', documentSelector, provider);
  symbolProviders.push(symProvider);
  return new Disposable(() => {
    const idx = symbolProviders.indexOf(symProvider);
    if (idx >= 0) symbolProviders.splice(idx, 1);
  });
}

function registerDocumentSymbolProvider(documentSelector, provider) {
  const symProvider = makeFileSymbolProvider(`vscode-doc-symbols-${Date.now()}`, 'pulsar-vscode-compat', documentSelector, provider);
  symbolProviders.push(symProvider);
  return new Disposable(() => {
    const idx = symbolProviders.indexOf(symProvider);
    if (idx >= 0) symbolProviders.splice(idx, 1);
  });
}

function registerWorkspaceSymbolProvider(provider) {
  const symProvider = makeProjectSymbolProvider(`vscode-workspace-symbols-${Date.now()}`, 'pulsar-vscode-compat', provider);
  symbolProviders.push(symProvider);
  return new Disposable(() => {
    const idx = symbolProviders.indexOf(symProvider);
    if (idx >= 0) symbolProviders.splice(idx, 1);
  });
}

function registerSignatureHelpProvider(documentSelector, provider, metaOrFirstChar, ...moreChars) {
  const triggerChars = typeof metaOrFirstChar === 'string'
    ? [metaOrFirstChar, ...moreChars]
    : (metaOrFirstChar && metaOrFirstChar.triggerCharacters) || [];

  const entry = { documentSelector, provider, triggerChars };
  signatureHelpProviders.push(entry);

  // Show signature help on trigger chars via autocomplete-plus mechanism
  const disposables = [];
  const setupForEditor = (editor) => {
    const grammar = editor.getGrammar();
    if (!matchesSelector(grammar.scopeName, documentSelector)) return;
    const d = editor.onDidInsertText(async ({ text }) => {
      if (!triggerChars.includes(text)) return;
      const doc = new TextDocument(editor);
      const cursor = editor.getCursorBufferPosition();
      const pos = new Position(cursor.row, cursor.column);
      const token = new CancellationTokenSource().token;
      try {
        const help = await provider.provideSignatureHelp(doc, pos, token, { triggerKind: 2, triggerCharacter: text, isRetrigger: false, activeSignatureHelp: undefined });
        if (help && help.signatures && help.signatures.length) _showSignatureHelp(editor, help);
      } catch (e) {}
    });
    disposables.push(d);
    editor.onDidDestroy(() => { try { d.dispose(); } catch(e) {} });
  };
  atom.workspace.observeTextEditors(setupForEditor);

  return new Disposable(() => {
    const idx = signatureHelpProviders.indexOf(entry);
    if (idx >= 0) signatureHelpProviders.splice(idx, 1);
    disposables.forEach(d => { try { d.dispose(); } catch(e) {} });
  });
}

let _sigHelpMarker = null;
let _sigHelpDecoration = null;

function _showSignatureHelp(editor, help) {
  if (_sigHelpMarker) { _sigHelpMarker.destroy(); _sigHelpMarker = null; }

  const sig = help.signatures[help.activeSignature || 0];
  if (!sig) return;

  const el = document.createElement('div');
  el.style.cssText = 'background:var(--base-background-color,#2d2d2d);border:1px solid #555;border-radius:3px;padding:4px 8px;font-size:12px;max-width:600px;';

  const label = sig.label || '';
  const activeParam = help.activeParameter !== undefined ? help.activeParameter : 0;
  const params = sig.parameters || [];

  if (params.length && activeParam < params.length) {
    const param = params[activeParam];
    const paramLabel = Array.isArray(param.label)
      ? label.slice(param.label[0], param.label[1])
      : (param.label || '');
    const before = label.indexOf(paramLabel);
    const labelEl = document.createElement('span');
    if (before >= 0) {
      labelEl.innerHTML = escHtml(label.slice(0, before)) + `<strong>${escHtml(paramLabel)}</strong>` + escHtml(label.slice(before + paramLabel.length));
    } else {
      labelEl.textContent = label;
    }
    el.appendChild(labelEl);
  } else {
    el.textContent = label;
  }

  const cursor = editor.getCursorBufferPosition();
  _sigHelpMarker = editor.markBufferPosition(cursor, { invalidate: 'touch' });
  editor.decorateMarker(_sigHelpMarker, { type: 'overlay', position: 'tail', item: el });

  const dismiss = editor.onDidChangeCursorPosition(() => {
    if (_sigHelpMarker) _sigHelpMarker.destroy();
    dismiss.dispose();
  });
}

function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function registerCodeActionsProvider(documentSelector, provider, metadata) {
  const entry = { documentSelector, provider, metadata };
  codeActionProviders.push(entry);

  const commandId = `vscode-compat:code-action`;
  if (!atom.commands._registered_code_action) {
    atom.commands._registered_code_action = true;
    atom.commands.add('atom-text-editor', commandId, async () => {
      const editor = atom.workspace.getActiveTextEditor();
      if (!editor) return;
      const grammar = editor.getGrammar();
      const matching = codeActionProviders.filter(p => matchesSelector(grammar.scopeName, p.documentSelector));
      if (!matching.length) return;

      const doc = new TextDocument(editor);
      const sel = Range.fromAtomRange(editor.getSelectedBufferRange());
      const context = { diagnostics: [], only: undefined, triggerKind: 1 };
      const token = new CancellationTokenSource().token;

      let allActions = [];
      for (const { provider: p } of matching) {
        try {
          const actions = await p.provideCodeActions(doc, sel, context, token);
          if (actions) allActions.push(...actions);
        } catch (e) {}
      }

      if (!allActions.length) return;

      const { showQuickPick } = require('./window');
      const chosen = await showQuickPick(allActions.map(a => ({
        label: a.title || a.command && a.command.title || '',
        _action: a
      })));

      if (!chosen || !chosen._action) return;
      const action = chosen._action;
      if (action.edit) {
        const workspaceNs = require('./workspace');
        await workspaceNs.applyEdit(action.edit);
      }
      if (action.command) {
        const { executeCommand } = require('./commands');
        await executeCommand(action.command.command, ...(action.command.arguments || []));
      }
    });

    // Add context menu entry
    atom.contextMenu.add({ 'atom-text-editor': [{ label: 'Code Actions', command: commandId }] });
  }

  return new Disposable(() => {
    const idx = codeActionProviders.indexOf(entry);
    if (idx >= 0) codeActionProviders.splice(idx, 1);
  });
}

function registerFoldingRangeProvider(documentSelector, provider) {
  const entry = { documentSelector, provider };
  foldingProviders.push(entry);

  const setupForEditor = (editor) => {
    const grammar = editor.getGrammar();
    if (!matchesSelector(grammar.scopeName, documentSelector)) return;

    const applyFolds = async () => {
      const doc = new TextDocument(editor);
      const token = new CancellationTokenSource().token;
      try {
        const ranges = await provider.provideFoldingRanges(doc, {}, token);
        if (!ranges) return;
        // Atom uses its own fold logic; we just pre-fold what's explicitly Collapsed
        // We can't override Atom's fold detection here — this is decorative
      } catch (e) {}
    };

    applyFolds();
  };

  atom.workspace.observeTextEditors(setupForEditor);
  return new Disposable(() => {
    const idx = foldingProviders.indexOf(entry);
    if (idx >= 0) foldingProviders.splice(idx, 1);
  });
}

function registerDocumentLinkProvider(documentSelector, provider) {
  // Best-effort: use Atom's hyperlink mechanism if available
  return new Disposable(() => {});
}

function registerRenameProvider(documentSelector, provider) {
  const entry = { documentSelector, provider };
  renameProviders.push(entry);

  if (!atom.commands._registered_rename) {
    atom.commands._registered_rename = true;
    atom.commands.add('atom-text-editor', 'vscode-compat:rename-symbol', async () => {
      const editor = atom.workspace.getActiveTextEditor();
      if (!editor) return;
      const grammar = editor.getGrammar();
      const matching = renameProviders.filter(p => matchesSelector(grammar.scopeName, p.documentSelector));
      if (!matching.length) return;

      const { showInputBox } = require('./window');
      const newName = await showInputBox({ prompt: 'New name:', value: editor.getWordUnderCursor() });
      if (!newName) return;

      const doc = new TextDocument(editor);
      const cursor = editor.getCursorBufferPosition();
      const pos = new Position(cursor.row, cursor.column);
      const token = new CancellationTokenSource().token;

      for (const { provider: p } of matching) {
        try {
          const edit = await p.provideRenameEdits(doc, pos, newName, token);
          if (edit) { await require('./workspace').applyEdit(edit); return; }
        } catch (e) {}
      }
    });

    atom.contextMenu.add({ 'atom-text-editor': [{ label: 'Rename Symbol', command: 'vscode-compat:rename-symbol' }] });
  }

  return new Disposable(() => {
    const idx = renameProviders.indexOf(entry);
    if (idx >= 0) renameProviders.splice(idx, 1);
  });
}

function registerColorProvider(documentSelector, provider) {
  // Too complex to implement without inline color picker UI
  return new Disposable(() => {});
}

function registerDocumentFormattingEditProvider(sel, prov) { return _registerFormatting(sel, prov); }
function registerDocumentRangeFormattingEditProvider(sel, prov) { return _registerRangeFormatting(sel, prov); }
function registerOnTypeFormattingEditProvider(sel, prov, ...chars) { return _registerOnTypeFormatting(sel, prov, ...chars); }
function registerCodeLensProvider(sel, prov) { return _registerCodeLens(sel, prov); }
function registerDocumentHighlightProvider(sel, prov) { return _registerHighlight(sel, prov); }
function registerInlayHintsProvider(sel, prov) { return _registerInlayHints(sel, prov); }

// Stubs
function registerSelectionRangeProvider() { return new Disposable(() => {}); }
function registerLinkedEditingRangeProvider() { return new Disposable(() => {}); }
function registerDocumentDropEditProvider() { return new Disposable(() => {}); }
function registerEvaluatableExpressionProvider() { return new Disposable(() => {}); }
function registerInlineCompletionItemProvider() { return new Disposable(() => {}); }
function registerCallHierarchyProvider() { return new Disposable(() => {}); }
function registerTypeHierarchyProvider() { return new Disposable(() => {}); }
function registerDocumentSemanticTokensProvider() { return new Disposable(() => {}); }
function registerDocumentRangeSemanticTokensProvider() { return new Disposable(() => {}); }
function registerDocumentOnDropEditProvider() { return new Disposable(() => {}); }
function registerInlineValuesProvider() { return new Disposable(() => {}); }

module.exports = {
  createDiagnosticCollection,
  createLanguageStatusItem,
  getDiagnostics,
  getLanguages,
  match,
  setLanguageConfiguration,
  registerCompletionItemProvider,
  registerHoverProvider,
  registerDefinitionProvider,
  registerDeclarationProvider,
  registerImplementationProvider,
  registerTypeDefinitionProvider,
  registerReferenceProvider,
  registerReferencesProvider,
  registerDocumentSymbolProvider,
  registerWorkspaceSymbolProvider,
  registerSignatureHelpProvider,
  registerCodeActionsProvider,
  registerFoldingRangeProvider,
  registerDocumentLinkProvider,
  registerRenameProvider,
  registerColorProvider,
  registerDocumentFormattingEditProvider,
  registerDocumentRangeFormattingEditProvider,
  registerOnTypeFormattingEditProvider,
  registerCodeLensProvider,
  registerDocumentHighlightProvider,
  registerInlayHintsProvider,
  registerSelectionRangeProvider,
  registerLinkedEditingRangeProvider,
  registerDocumentDropEditProvider,
  registerEvaluatableExpressionProvider,
  registerInlineCompletionItemProvider,
  registerCallHierarchyProvider,
  registerTypeHierarchyProvider,
  registerDocumentSemanticTokensProvider,
  registerDocumentRangeSemanticTokensProvider,
  registerDocumentOnDropEditProvider,
  registerInlineValuesProvider,

  // Internal accessors for service provision
  _completionProviders: completionProviders,
  _symbolProviders: symbolProviders,
  _setLinterIndie(indie) {
    _linterIndie = indie;
    for (const coll of diagnosticCollections) coll._linterIndie = indie;
  }
};
