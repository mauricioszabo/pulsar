'use strict';

// Tree-sitter-optimized text-editor component (see ADR 006 and the
// "Tree-Sitter Optimized Text Editor" plan).
//
// The slowness / wrapping / mis-highlighting that the display-layer path
// suffers on minified and single-root (YAML) files comes from text-buffer's
// display layer: with `maxScreenLineLength` defaulting to 500, it chops a long
// line into ~200 "screen rows" (that's the wrapping, even with soft-wrap off),
// which is O(whole-line) work on open and makes screen row != buffer row.
//
// This component:
//
//   1. Disables that wrapping entirely (soft-wrap off AND no
//      `maxScreenLineLength` cap), forced as early as construction. The display
//      layer then collapses to a trivial 1:1 map — screen row == buffer row —
//      so it stops being the bottleneck and long lines scroll horizontally
//      instead of wrapping (a hard requirement from the plan).
//   2. Renders each visible line's CONTENT directly from the language mode's
//      viewport-windowed tokenizer (`getScreenLineTokens`, M2) — reading only
//      the visible column window from the buffer, never a whole line, and never
//      through display-layer screen lines. One <span> per token, tagged with
//      `data-ts-row`/`data-ts-col`.
//
// For non-tree-sitter grammars the token path is inactive and the base 'pulsar'
// render path is used (this component still keeps such editors unwrapped).
//
// A `data-tree-sitter-tokens` attribute on the editor element reads "true"
// whenever the direct-tokenized path is active, so it's easy to confirm in
// devtools whether the fast path engaged.
//
// Not yet done (later milestones):
//   M4 – incremental repaint driven by tree-sitter changed ranges (today the
//        visible rows are re-tokenized on each render frame).
//   later – folds support.
const PulsarTextEditorComponent = require('./component');
const WASMTreeSitterGrammar = require('../wasm-tree-sitter-grammar');

// Effectively "never wrap": a wrap column no real single line reaches. We use a
// large *finite integer* rather than Infinity on purpose — `maxScreenLineLength`
// is an integer setting, and a non-finite value risks collapsing to 0 under any
// bitwise/`| 0` handling inside the display layer (which would wrap at column 0).
// 2^30 (~1.07e9) is comfortably larger than any realistic line and stays within
// 32-bit signed range.
const NO_WRAP_COLUMN = 0x40000000;

class PulsarTreeSitterTextEditorComponent extends PulsarTextEditorComponent {
  constructor(props) {
    super(props);
    // Force no-wrap before the first render so the display layer never chunks
    // the file at 500 columns (the source of the open-time stall).
    this._forceNoWrap();
  }

  // Disable both wrap sources so the display layer maps screen row == buffer row
  // for arbitrarily long lines. Guarded on value change, so it's a cheap no-op
  // once applied; called again each render in case config re-asserts a cap.
  _forceNoWrap() {
    const model = this.props.model;
    if (!model || (model.isMini && model.isMini())) return;
    try {
      if (model.isSoftWrapped && model.isSoftWrapped()) {
        model.setSoftWrapped(false);
      }
      if (
        model.maxScreenLineLength !== NO_WRAP_COLUMN &&
        typeof model.update === 'function'
      ) {
        model.update({ maxScreenLineLength: NO_WRAP_COLUMN });
      }
    } catch (e) {
      // Non-fatal: if the model rejects these, we simply fall back to whatever
      // wrapping it had — rendering still works via the base path.
    }
  }

  updateModelSoftWrapColumn() {
    this._forceNoWrap();
    // We never wrap, so the base's editor-width-in-chars bookkeeping is moot.
    return false;
  }

  _languageModeFor(model) {
    const buffer = model && (model.getBuffer ? model.getBuffer() : model.buffer);
    return buffer && buffer.getLanguageMode && buffer.getLanguageMode();
  }

  _isTreeSitterGrammar(languageMode) {
    return !!(
      languageMode &&
      languageMode.grammar instanceof WASMTreeSitterGrammar &&
      typeof languageMode.getScreenLineTokens === 'function'
    );
  }

  // Returns the tree-sitter language mode to tokenize from, or null to fall
  // back to the base render path. Also flags the active state on the element.
  _lineTokenSource(model) {
    const source = this._computeTokenSource(model);
    if (this.element) {
      this.element.dataset.treeSitterTokens = source ? 'true' : 'false';
    }
    return source;
  }

  _computeTokenSource(model) {
    if (!model || model.isMini()) return null;

    const languageMode = this._languageModeFor(model);
    if (!this._isTreeSitterGrammar(languageMode)) return null;

    // The direct path assumes screen row == buffer row. Wrapping is forced off
    // above; folds still break the mapping, so defer to the base path for now.
    if (this._displayHasFolds(model)) return null;

    // No syntax tree yet — let the base path render until the first parse lands.
    if (!languageMode.rootLanguageLayer || !languageMode.rootLanguageLayer.tree) {
      return null;
    }

    this._ensureHighlightSubscription(languageMode);
    return languageMode;
  }

  _displayHasFolds(model) {
    const displayLayer = model.displayLayer;
    const folds = displayLayer && displayLayer.foldsMarkerLayer;
    return !!(folds && folds.getMarkerCount && folds.getMarkerCount() > 0);
  }

  // A highlight change happens asynchronously after a tree-sitter reparse; make
  // sure it schedules a re-render so the swapped-in tokens refresh.
  _ensureHighlightSubscription(languageMode) {
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
