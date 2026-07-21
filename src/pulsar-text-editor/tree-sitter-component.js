'use strict';

// Tree-sitter-optimized text-editor component (see ADR 006 and the
// "Tree-Sitter Optimized Text Editor" plan).
//
// MILESTONE STATUS (M3 — visible direct-tokenized rendering):
//
// This subclass reuses the entire base `PulsarTextEditorComponent` — viewport
// math, gutter, cursors, selections, decorations, scrolling — and swaps out
// only *where line tokens come from*. When the active grammar is a tree-sitter
// grammar and the display is linear (no folds, no soft-wrap, so screen row ==
// buffer row), lines are rendered directly from the language mode's
// viewport-windowed tokenizer (`getScreenLineTokens`, added in M2) instead of
// from display-layer screen lines. That bypasses the per-line-from-column-0
// tokenization that makes minified and single-root (YAML) files slow, and emits
// one <span> per token tagged with `data-ts-row`/`data-ts-col`.
//
// When the grammar is not tree-sitter, or folds / soft-wrap are active, or the
// syntax tree isn't ready yet, `_lineTokenSource` returns null and the base
// class renders exactly as the 'pulsar' implementation does.
//
// Not yet done (later milestones):
//   M4 – incremental repaint driven by tree-sitter changed ranges (today the
//        visible rows are re-tokenized on each render frame).
//   later – folds, soft-wrap, and dropping the display layer for geometry too.
const PulsarTextEditorComponent = require('./component');
const WASMTreeSitterGrammar = require('../wasm-tree-sitter-grammar');

class PulsarTreeSitterTextEditorComponent extends PulsarTextEditorComponent {
  // Returns the tree-sitter language mode to tokenize from, or null to fall
  // back to the base (display-layer) render path.
  _lineTokenSource(model) {
    if (!model) return null;

    const buffer = model.getBuffer ? model.getBuffer() : model.buffer;
    const languageMode = buffer && buffer.getLanguageMode && buffer.getLanguageMode();
    if (!languageMode) return null;

    // Only tree-sitter grammars expose the windowed tokenizer.
    if (!(languageMode.grammar instanceof WASMTreeSitterGrammar)) return null;
    if (typeof languageMode.getScreenLineTokens !== 'function') return null;

    // The direct path assumes screen row == buffer row. Folds and soft-wrap
    // break that mapping, so defer to the base component when either is active.
    if (model.isSoftWrapped && model.isSoftWrapped()) return null;
    if (this._displayHasFolds(model)) return null;

    // No syntax tree yet — let the base path render until the first parse lands.
    if (!languageMode.rootLanguageLayer || !languageMode.rootLanguageLayer.tree) {
      return null;
    }

    this._ensureHighlightSubscription(model, languageMode);
    return languageMode;
  }

  _displayHasFolds(model) {
    const displayLayer = model.displayLayer;
    const folds = displayLayer && displayLayer.foldsMarkerLayer;
    return !!(folds && folds.getMarkerCount && folds.getMarkerCount() > 0);
  }

  // Make sure a highlight change (which happens asynchronously after a
  // tree-sitter reparse) schedules a re-render so the swapped-in tokens refresh.
  // The base component already re-renders on buffer/display-layer changes; this
  // covers the trailing "tree became clean, re-highlight" notification.
  _ensureHighlightSubscription(model, languageMode) {
    if (this._highlightLanguageMode === languageMode) return;
    this._disposeHighlightSubscription();

    if (typeof languageMode.onDidChangeHighlighting === 'function') {
      this._highlightLanguageMode = languageMode;
      this._highlightSubscription = languageMode.onDidChangeHighlighting(() => {
        if (this._scheduleUpdate) this._scheduleUpdate();
      });
    }
  }

  _disposeHighlightSubscription() {
    if (this._highlightSubscription) {
      this._highlightSubscription.dispose();
      this._highlightSubscription = null;
    }
    this._highlightLanguageMode = null;
  }

  destroy() {
    this._disposeHighlightSubscription();
    super.destroy();
  }
}

module.exports = PulsarTreeSitterTextEditorComponent;
