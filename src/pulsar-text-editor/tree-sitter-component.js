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

// A dirtied row range wider than this escalates to a full (structural) cache
// invalidation instead of bumping each row's version — cheaper than touching
// thousands of Map entries for a whole-file re-highlight, and only visible rows
// re-tokenize anyway.
const DIRTY_RANGE_ESCALATION = 500;

class PulsarTreeSitterTextEditorComponent extends PulsarTextEditorComponent {
  constructor(props) {
    super(props);
    this._maxLineLengthSeen = 0;

    // M4 incremental repaint. Between renders we accumulate which rows changed;
    // LinesView re-tokenizes only those rows and repaints only the token spans
    // that actually differ. A row is dirty when:
    //   - `_dirtyRows` contains it (a same-line edit or a bounded highlight
    //     change touched it), or
    //   - it is at/after `_dirtyFromRow` (an edit changed the line count, so
    //     every row below it shifted), or
    //   - `_fullDirty` is set (initial parse — the whole file gained tokens).
    // Renders caused only by cursor/selection movement dirty nothing, so no row
    // re-tokenizes.
    this._dirtyRows = new Set();
    this._dirtyFromRow = Infinity;
    this._fullDirty = false;
    this._lastLineCount = null;
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

    // NOTE: the token source is returned even before the first parse finishes.
    // `getScreenLineTokens` returns null while the tree is missing and the line
    // view renders plain windowed buffer text — we must NOT fall back to the
    // display-layer render path for tree-sitter files, because building its
    // screen-line index for a huge unwrapped file is exactly the open-time cost
    // this component exists to avoid.
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
      tokenSource, tokenDirty: this._consumeTokenDirty(),
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

  // --- M4 incremental invalidation ------------------------------------------

  // Dirty specific rows: a same-line edit or a bounded highlight change. A range
  // wide enough that tracking each row isn't worthwhile escalates to "dirty from
  // this row down" (only the visible portion re-tokenizes anyway).
  _markRowsDirty(startRow, endRow) {
    if (endRow - startRow > DIRTY_RANGE_ESCALATION) {
      this._dirtyFromRow = Math.min(this._dirtyFromRow, startRow);
      return;
    }
    for (let r = startRow; r <= endRow; r++) this._dirtyRows.add(r);
  }

  // Snapshot the accumulated dirty state for one render, then reset it.
  _consumeTokenDirty() {
    const dirty = {
      full: this._fullDirty,
      fromRow: this._dirtyFromRow,
      rows: this._dirtyRows
    };
    this._fullDirty = false;
    this._dirtyFromRow = Infinity;
    this._dirtyRows = new Set();
    return dirty;
  }

  _onBufferChange(event) {
    const buffer = this._languageModeFor(this.props.model)?.buffer ||
      (this.props.model.getBuffer && this.props.model.getBuffer());
    const lineCount = buffer ? buffer.getLineCount() : null;

    // A change in line count shifts every row below the edit: the DOM element
    // keyed by a given row number now maps to different content, so those rows
    // must re-tokenize.
    const structural = lineCount !== this._lastLineCount;
    this._lastLineCount = lineCount;

    const changes = event && event.changes
      ? event.changes
      : (event && event.newRange ? [event] : []);
    if (changes.length === 0 && structural) {
      this._dirtyFromRow = 0;
    }
    for (const change of changes) {
      const range = change.newRange || change.range;
      if (!range || !range.start) {
        this._fullDirty = true;
      } else if (structural) {
        this._dirtyFromRow = Math.min(this._dirtyFromRow, range.start.row);
      } else {
        this._markRowsDirty(range.start.row, range.end.row);
      }
    }
    if (this._scheduleUpdate) this._scheduleUpdate();
  }

  // Invalidate token caches and re-render when the buffer changes, when the
  // initial parse lands, or when highlighting is recomputed after a reparse
  // (the last happens asynchronously).
  _ensureHighlightSubscription(languageMode) {
    if (this._highlightLanguageMode === languageMode) return;
    this._disposeHighlightSubscription();
    this._highlightLanguageMode = languageMode;

    const disposables = [];

    if (typeof languageMode.onDidChangeHighlighting === 'function') {
      disposables.push(languageMode.onDidChangeHighlighting((range) => {
        if (range && range.start) {
          this._markRowsDirty(range.start.row, range.end.row);
        } else {
          this._fullDirty = true;
        }
        if (this._scheduleUpdate) this._scheduleUpdate();
      }));
    }

    // Fires when the initial parse lands — switches lines from the plain-text
    // placeholder to real tokens across the whole file.
    if (typeof languageMode.onDidTokenize === 'function') {
      disposables.push(languageMode.onDidTokenize(() => {
        this._fullDirty = true;
        if (this._scheduleUpdate) this._scheduleUpdate();
      }));
    }

    const buffer = languageMode.buffer;
    if (buffer && typeof buffer.onDidChange === 'function') {
      if (this._lastLineCount == null) this._lastLineCount = buffer.getLineCount();
      disposables.push(buffer.onDidChange((event) => this._onBufferChange(event)));
    }

    this._highlightSubscription = {
      dispose() { for (const d of disposables) d.dispose(); }
    };
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
