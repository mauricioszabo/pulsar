'use strict';

// Tree-sitter-optimized text-editor component (see ADR 006 and the
// "Tree-Sitter Optimized Text Editor" plan).
//
// For a tree-sitter grammar this component renders DIRECTLY from the buffer and
// the syntax tree — it does not use text-buffer's display layer for the render
// path at all:
//
//   * The row model is `buffer.getLineCount()` (screen row == buffer row); there
//     is no `getScreenLineCount`, no screen-line materialization, no soft-wrap
//     chunking. Long lines scroll horizontally instead of wrapping.
//   * Each visible line's content comes from the language mode's
//     viewport-windowed tokenizer (`getScreenLineTokens`, M2), reading only the
//     visible column window from the buffer. One <span> per token, tagged with
//     `data-ts-row`/`data-ts-col`.
//   * Gutter line numbers, cursors, and selections are computed from buffer
//     coordinates.
//
// The base `PulsarTextEditorComponent` is still used for infrastructure (DOM
// scaffold, measurement, scroll, input, blink) and for the fallback render path
// when the grammar is not tree-sitter, or the syntax tree isn't ready yet, or
// folds are present (folds still break the screen==buffer assumption).
//
// A `data-tree-sitter-tokens` attribute on the editor element reads "true"
// whenever the buffer-driven path is active.
//
// Not yet done (later milestones): M4 incremental repaint from tree-sitter
// changed ranges (visible rows are re-tokenized each render frame today); folds;
// block decorations; overlay/highlight decorations.
const PulsarTextEditorComponent = require('./component');
const WASMTreeSitterGrammar = require('../wasm-tree-sitter-grammar');
const { OVERSCAN, computeVisibleColumnRange } = require('./viewport');

// Effectively "never wrap": a wrap column no real single line reaches. A large
// *finite integer* rather than Infinity on purpose — `maxScreenLineLength` is an
// integer setting, and a non-finite value risks collapsing to 0 under any
// bitwise/`| 0` handling in the display layer (which would wrap at column 0).
const NO_WRAP_COLUMN = 0x40000000;

class PulsarTreeSitterTextEditorComponent extends PulsarTextEditorComponent {
  constructor(props) {
    super(props);
    this._maxLineLengthSeen = 0;
    // Force no-wrap before the first render for tree-sitter files so the model's
    // display layer (used by cursor/editing) never chunks the file at 500 cols.
    if (this._isTreeSitterGrammar(this._languageModeFor(this.props.model))) {
      this._forceNoWrap();
    }
  }

  // --- no-wrap enforcement --------------------------------------------------

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
      // Non-fatal: fall back to whatever wrapping the model had.
    }
  }

  updateModelSoftWrapColumn() {
    if (this._treeSitterActive()) {
      this._forceNoWrap();
      return false;
    }
    return super.updateModelSoftWrapColumn();
  }

  // --- tree-sitter detection ------------------------------------------------

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

  _treeSitterActive() {
    const model = this.props.model;
    return !!model && !model.isMini() &&
      this._isTreeSitterGrammar(this._languageModeFor(model));
  }

  // Returns the language mode to tokenize from (buffer-driven path), or null to
  // fall back to the base display-layer render path. Flags the element.
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

    // The direct path assumes screen row == buffer row. Wrapping is forced off;
    // folds still break the mapping, so defer to the base path when present.
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

  // --- buffer-driven render -------------------------------------------------

  _render() {
    const model = this.props.model;
    if (!this._mounted || !this.isVisible() || model.isDestroyed()) return;

    const tokenSource = this._lineTokenSource(model);
    if (!tokenSource) {
      // Non-tree-sitter / tree not ready / folds: use the base render path.
      return super._render();
    }

    this._syncMiniEditorDimensions();
    this._syncViewportDimensions();
    this.updateModelSoftWrapColumn();
    this._flushPendingAutoscroll();

    const lineHeight = this._lineHeight;
    const charWidth = this._charWidth;
    const scrollTop = this._scrollTopValue;
    const scrollLeft = this._scrollLeftValue;
    const viewportHeight = this._viewportHeight;
    const viewportWidth = this._viewportWidth;

    const buffer = model.getBuffer();
    const totalRows = buffer.getLineCount();

    // Buffer-row geometry — no block decorations in this path yet.
    const topForRow = (row) => row * lineHeight;
    this._pixelTopForRow = topForRow;
    this._pixelBottomForRow = (row) => (row + 1) * lineHeight;
    this._rowAtPixel = (px) =>
      lineHeight ? Math.max(0, Math.min(totalRows - 1, Math.floor(px / lineHeight))) : 0;

    // Viewport (buffer rows + visible column window).
    const firstRow = lineHeight
      ? Math.max(0, Math.floor(scrollTop / lineHeight) - OVERSCAN)
      : 0;
    const lastRow = lineHeight
      ? Math.min(totalRows - 1, Math.floor((scrollTop + viewportHeight) / lineHeight) + OVERSCAN)
      : Math.min(totalRows - 1, OVERSCAN * 2);
    const visColRange = computeVisibleColumnRange(scrollLeft, viewportWidth, charWidth);
    const topSpacer = firstRow * lineHeight;
    const bottomSpacer = Math.max(0, (totalRows - 1 - lastRow) * lineHeight);
    const totalHeight = totalRows * (lineHeight || 0);

    // Horizontal scroll extent: a running max of line lengths we've seen (so a
    // long line encountered while scrolling sets the width without an O(N) scan
    // of the whole file).
    let visibleLongest = 0;
    for (let r = firstRow; r <= lastRow; r++) {
      const len = buffer.lineLengthForRow(r) || 0;
      if (len > visibleLongest) visibleLongest = len;
    }
    this._maxLineLengthSeen = Math.max(this._maxLineLengthSeen || 0, visibleLongest);
    const longestLineWidth = (this._maxLineLengthSeen + 1) * charWidth;

    // Gutter.
    const showGutter = !model.isMini() && model.anyLineNumberGutterVisible();
    const showLineNumbers = model.doesShowLineNumbers();
    const maxDigits = Math.max(2, String(totalRows).length);
    // Line-number decorations are deferred (they'd need a display-layer query);
    // the gutter view treats a null map as "no decorations".
    const lineNumDecoClasses = null;
    const visibleGutterRows = this._computeBufferGutterRows(firstRow, lastRow);

    // Selections / cursors from buffer coordinates (screen == buffer).
    const selections = model.getSelections();
    const hasSelection = selections.some((s) => !s.isEmpty());
    this.element.classList.toggle('has-selection', hasSelection);
    const selectionRanges = selections.map((s) => s.getBufferRange());

    const cursorDescriptors = this._computeBufferCursorDescriptors(model);
    const showCursorLine = !model.isMini() && !hasSelection;
    const cursorRows = showCursorLine
      ? this._computeCursorRows(cursorDescriptors, lineHeight)
      : new Set();

    const placeholderText = this._computePlaceholderText(model);

    this._linesView.update({
      firstRow, lastRow, model, displayLayer: null,
      sortedBlocks: [], topSpacer, bottomSpacer,
      charWidth, lineHeight, visColRange,
      cursorRows, placeholderText, longestLineWidth,
      tokenSource,
    });

    this._gutterView.update({
      showGutter, showLineNumbers, maxDigits,
      visibleGutterRows, sortedBlocks: [],
      topSpacer, bottomSpacer,
      lineNumDecoClasses, scrollTop
    });

    this._decorationsView.update({
      selectionRanges, highlightDecos: [],
      cursorDescriptors,
      blinkOff: this._blinkOff,
      lineHeight, charWidth,
      topForRow, totalHeight
    });

    this._applyScrollPositionToDOM();

    if (this.resolveNextUpdatePromise) {
      this.resolveNextUpdatePromise();
      this.nextUpdatePromise = null;
      this.resolveNextUpdatePromise = null;
    }
  }

  _computeBufferGutterRows(firstRow, lastRow) {
    const rows = [];
    for (let r = firstRow; r <= lastRow; r++) {
      rows.push({ screenRow: r, bufferRow: r, softWrapped: false, foldable: false });
    }
    return rows;
  }

  _computeBufferCursorDescriptors(model) {
    if (model.isDestroyed()) return [];
    return model.getCursors().map((c) => ({
      position: c.getBufferPosition(),
      extraClass: null,
      extraStyle: null
    }));
  }

  // --- highlight refresh ----------------------------------------------------

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
