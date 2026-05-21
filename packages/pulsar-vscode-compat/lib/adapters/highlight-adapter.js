'use strict';

const { Position } = require('../types/position');
const { TextDocument } = require('../types/text-document');
const { CancellationTokenSource } = require('../types/cancellation');
const { matchesSelector } = require('../utils/selector');
const { Disposable } = require('../types/disposable');

const highlightProviders = [];
const editorHighlightState = new WeakMap();

function registerDocumentHighlightProvider(documentSelector, provider) {
  highlightProviders.push({ documentSelector, provider });

  atom.workspace.observeTextEditors(editor => {
    const grammar = editor.getGrammar();
    if (!matchesSelector(grammar.scopeName, documentSelector)) return;

    let debounce = null;
    const refresh = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => updateHighlights(editor), 300);
    };

    const d1 = editor.onDidChangeCursorPosition(refresh);
    editor.onDidDestroy(() => { clearHighlights(editor); d1.dispose(); });
  });

  return new Disposable(() => {
    const idx = highlightProviders.findIndex(p => p.provider === provider);
    if (idx >= 0) highlightProviders.splice(idx, 1);
  });
}

async function updateHighlights(editor) {
  const grammar = editor.getGrammar();
  const matching = highlightProviders.filter(p => matchesSelector(grammar.scopeName, p.documentSelector));
  if (!matching.length) { clearHighlights(editor); return; }

  clearHighlights(editor);
  const doc = new TextDocument(editor);
  const cursor = editor.getCursorBufferPosition();
  const pos = new Position(cursor.row, cursor.column);
  const decorations = [];

  for (const { provider } of matching) {
    try {
      const token = new CancellationTokenSource().token;
      const highlights = await provider.provideDocumentHighlights(doc, pos, token);
      if (!highlights) continue;
      for (const hl of highlights) {
        const marker = editor.markBufferRange(hl.range.toAtomRange(), { invalidate: 'never' });
        const decoration = editor.decorateMarker(marker, { type: 'highlight', class: 'vscode-document-highlight' });
        decorations.push({ destroy() { marker.destroy(); } });
      }
    } catch (e) {}
  }

  editorHighlightState.set(editor, decorations);
}

function clearHighlights(editor) {
  const existing = editorHighlightState.get(editor) || [];
  for (const d of existing) { try { d.destroy(); } catch (e) {} }
  editorHighlightState.set(editor, []);
}

module.exports = { registerDocumentHighlightProvider };
