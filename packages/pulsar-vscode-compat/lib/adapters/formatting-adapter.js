'use strict';

const { Position } = require('../types/position');
const { TextDocument } = require('../types/text-document');
const { CancellationTokenSource } = require('../types/cancellation');
const { matchesSelector } = require('../utils/selector');
const { Disposable } = require('../types/disposable');

const formattingProviders = [];
const rangeFormattingProviders = [];
const onTypeFormattingProviders = [];

function registerDocumentFormattingEditProvider(documentSelector, provider) {
  formattingProviders.push({ documentSelector, provider });

  // Hook into Atom's buffer willSave if the grammar matches
  const disposables = [];
  const setupForEditor = (editor) => {
    const grammar = editor.getGrammar();
    if (!matchesSelector(grammar.scopeName, documentSelector)) return;

    const d = editor.getBuffer().onWillSave(async () => {
      const doc = new TextDocument(editor);
      const token = new CancellationTokenSource().token;
      const opts = { tabSize: editor.getTabLength(), insertSpaces: editor.getSoftTabs() };
      try {
        const edits = await provider.provideDocumentFormattingEdits(doc, opts, token);
        if (edits && edits.length) applyEdits(editor, edits);
      } catch (e) {}
    });
    disposables.push(d);
    editor.onDidDestroy(() => {
      const idx = disposables.indexOf(d);
      if (idx >= 0) { disposables.splice(idx, 1); try { d.dispose(); } catch(e) {} }
    });
  };

  atom.workspace.observeTextEditors(setupForEditor);

  return new Disposable(() => {
    const idx = formattingProviders.findIndex(p => p.provider === provider);
    if (idx >= 0) formattingProviders.splice(idx, 1);
    disposables.forEach(d => { try { d.dispose(); } catch(e) {} });
  });
}

function registerDocumentRangeFormattingEditProvider(documentSelector, provider) {
  rangeFormattingProviders.push({ documentSelector, provider });

  const commandId = `vscode-compat:format-selection`;
  if (!atom.commands._registry || !atom.commands._registry[commandId]) {
    atom.commands.add('atom-text-editor', commandId, async () => {
      const editor = atom.workspace.getActiveTextEditor();
      if (!editor) return;
      const grammar = editor.getGrammar();
      const matching = rangeFormattingProviders.find(p => matchesSelector(grammar.scopeName, p.documentSelector));
      if (!matching) return;
      const doc = new TextDocument(editor);
      const sel = editor.getSelectedBufferRange();
      const { Range } = require('../types/range');
      const range = Range.fromAtomRange(sel);
      const opts = { tabSize: editor.getTabLength(), insertSpaces: editor.getSoftTabs() };
      const token = new CancellationTokenSource().token;
      try {
        const edits = await matching.provider.provideDocumentRangeFormattingEdits(doc, range, opts, token);
        if (edits && edits.length) applyEdits(editor, edits);
      } catch (e) {}
    });
  }

  return new Disposable(() => {
    const idx = rangeFormattingProviders.findIndex(p => p.provider === provider);
    if (idx >= 0) rangeFormattingProviders.splice(idx, 1);
  });
}

function registerOnTypeFormattingEditProvider(documentSelector, provider, firstTriggerCharacter, ...moreTriggerCharacters) {
  const triggerChars = [firstTriggerCharacter, ...moreTriggerCharacters];
  const entry = { documentSelector, provider, triggerChars };
  onTypeFormattingProviders.push(entry);

  const disposables = [];
  const setupForEditor = (editor) => {
    const grammar = editor.getGrammar();
    if (!matchesSelector(grammar.scopeName, documentSelector)) return;

    const d = editor.onDidInsertText(async ({ text, range }) => {
      if (!triggerChars.includes(text)) return;
      const doc = new TextDocument(editor);
      const pos = new Position(range.end.row, range.end.column);
      const opts = { tabSize: editor.getTabLength(), insertSpaces: editor.getSoftTabs() };
      const token = new CancellationTokenSource().token;
      try {
        const edits = await provider.provideOnTypeFormattingEdits(doc, pos, text, opts, token);
        if (edits && edits.length) applyEdits(editor, edits);
      } catch (e) {}
    });
    disposables.push(d);
    editor.onDidDestroy(() => { try { d.dispose(); } catch(e) {} });
  };

  atom.workspace.observeTextEditors(setupForEditor);

  return new Disposable(() => {
    const idx = onTypeFormattingProviders.indexOf(entry);
    if (idx >= 0) onTypeFormattingProviders.splice(idx, 1);
    disposables.forEach(d => { try { d.dispose(); } catch(e) {} });
  });
}

function applyEdits(editor, edits) {
  // Sort edits in reverse order so positions don't shift
  const sorted = [...edits].sort((a, b) => {
    const aStart = a.range.start;
    const bStart = b.range.start;
    if (bStart.line !== aStart.line) return bStart.line - aStart.line;
    return bStart.character - aStart.character;
  });

  editor.transact(() => {
    for (const edit of sorted) {
      editor.setTextInBufferRange(edit.range.toAtomRange(), edit.newText);
    }
  });
}

module.exports = { registerDocumentFormattingEditProvider, registerDocumentRangeFormattingEditProvider, registerOnTypeFormattingEditProvider, applyEdits };
