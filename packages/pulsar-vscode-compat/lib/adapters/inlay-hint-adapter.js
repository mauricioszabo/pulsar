'use strict';

const { TextDocument } = require('../types/text-document');
const { Range } = require('../types/range');
const { Position } = require('../types/position');
const { CancellationTokenSource } = require('../types/cancellation');
const { matchesSelector } = require('../utils/selector');
const { Disposable } = require('../types/disposable');

const inlayHintProviders = [];
const editorHintState = new WeakMap();

function registerInlayHintsProvider(documentSelector, provider) {
  inlayHintProviders.push({ documentSelector, provider });
  setupForEditors();
  return new Disposable(() => {
    const idx = inlayHintProviders.findIndex(p => p.provider === provider);
    if (idx >= 0) inlayHintProviders.splice(idx, 1);
  });
}

function setupForEditors() {
  atom.workspace.observeTextEditors(editor => {
    if (editorHintState.has(editor)) return;
    const grammar = editor.getGrammar();
    const matching = inlayHintProviders.filter(p => matchesSelector(grammar.scopeName, p.documentSelector));
    if (!matching.length) return;

    editorHintState.set(editor, []);
    let debounce = null;

    const refresh = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => renderInlayHints(editor, matching), 600);
    };

    const d1 = editor.onDidStopChanging(refresh);
    const d2 = editor.onDidChangeCursorPosition(refresh);
    editor.onDidDestroy(() => { clearHints(editor); d1.dispose(); d2.dispose(); });
    refresh();
  });
}

async function renderInlayHints(editor, providers) {
  clearHints(editor);
  const doc = new TextDocument(editor);
  const visibleRanges = editor.getVisibleRowRange ? editor.getVisibleRowRange() : [0, editor.getLineCount()];
  const viewRange = new Range(
    new Position(visibleRanges[0] || 0, 0),
    new Position(visibleRanges[1] || editor.getLineCount(), 0)
  );
  const decorations = [];

  for (const { provider } of providers) {
    try {
      const token = new CancellationTokenSource().token;
      let hints = await provider.provideInlayHints(doc, viewRange, token);
      if (!hints) continue;

      if (provider.resolveInlayHint) {
        hints = await Promise.all(hints.map(async h => {
          try {
            return await provider.resolveInlayHint(h, new CancellationTokenSource().token) || h;
          } catch (e) { return h; }
        }));
      }

      for (const hint of hints) {
        const labelText = Array.isArray(hint.label)
          ? hint.label.map(p => p.value || '').join('')
          : hint.label || '';
        if (!labelText) continue;

        const el = document.createElement('span');
        el.classList.add('vscode-inlay-hint');
        el.textContent = labelText;
        el.style.cssText = 'color:#888;font-size:11px;opacity:0.8;pointer-events:none;font-style:italic;padding:0 2px;';

        const row = hint.position.line;
        const col = hint.position.character;
        const marker = editor.markBufferRange([[row, col], [row, col]], { invalidate: 'touch' });
        editor.decorateMarker(marker, { type: 'overlay', position: 'tail', item: el, avoidOverflow: false });
        decorations.push({ destroy() { marker.destroy(); } });
      }
    } catch (e) {}
  }

  editorHintState.set(editor, decorations);
}

function clearHints(editor) {
  const existing = editorHintState.get(editor) || [];
  for (const d of existing) { try { d.destroy(); } catch (e) {} }
  editorHintState.set(editor, []);
}

module.exports = { registerInlayHintsProvider };
