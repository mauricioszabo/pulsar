'use strict';

// Vanilla-JS rewrite of the SolidJS pulsar-text-editor component.
// Replaces Solid signals/memos/JSX with:
//   - plain JS state + version counters
//   - a single requestAnimationFrame render loop
//   - keyed-list DOM reconciliation in LinesView / GutterView / DecorationsView

const LinesView = require('./lines-view');
const GutterView = require('./gutter-view');
const DecorationsView = require('./decorations-view');
const { createMeasurement } = require('./measurements');
const {
  computeSortedBlocks,
  computeLineNumDecoClasses,
  computeHighlightDecos,
  BlockDecorations,
  OverlayDecorations
} = require('./decorations');
const electron = require('electron');
const clipboard = electron.clipboard;
const {
  computeFirstRenderedRow,
  computeLastRenderedRow,
  computeVisibleColumnRange,
  pixelTopForRow,
  pixelBottomForRow,
  computeTopSpacer,
  computeBottomSpacer,
  rowAtPixel,
  PLAIN_TEXT_THRESHOLD
} = require('./viewport');

let TextEditor = null;
let TextEditorElement = null;

const CURSOR_BLINK_PERIOD = 800;
const CURSOR_BLINK_RESUME_DELAY = 300;
const DEFAULT_VERTICAL_SCROLL_MARGIN = 2;
const DEFAULT_HORIZONTAL_SCROLL_MARGIN = 6;

// ---------------------------------------------------------------------------
// Gutter row cache (mirrors the Solid gutterCache logic)
// ---------------------------------------------------------------------------

const GUTTER_CACHE_SLACK = 200;

// ---------------------------------------------------------------------------
// PulsarTextEditorComponent
// ---------------------------------------------------------------------------

class PulsarTextEditorComponent {
  // --- Static API -----------------------------------------------------------

  static setScheduler(_scheduler) { }
  static getScheduler() { return null; }

  static didUpdateStyles() {
    if (this.attachedComponents) {
      this.attachedComponents.forEach((c) => c.didUpdateStyles());
    }
  }

  static didUpdateScrollbarStyles() {
    if (this.attachedComponents) {
      this.attachedComponents.forEach((c) => c.didUpdateScrollbarStyles());
    }
  }

  // --- Construction ---------------------------------------------------------

  constructor(props) {
    this.props = props || {};

    if (!this.props.model) {
      if (!TextEditor) TextEditor = require('../text-editor');
      this.props.model = new TextEditor({
        mini: this.props.mini,
        readOnly: this.props.readOnly
      });
    }
    this.props.model.component = this;

    if (this.props.element) {
      this.element = this.props.element;
    } else {
      if (!TextEditorElement) TextEditorElement = require('../text-editor-element');
      this.element = TextEditorElement.createTextEditorElement();
    }
    this.element.initialize(this);

    this.updatedSynchronously = this.props.updatedSynchronously;
    this.focused = false;
    this.visible = false;
    this.attached = false;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.inputEnabled = true;

    // Font metrics.
    this._lineHeight = 0;
    this._charWidth = 0;

    // Scroll position mirrored here so we can read it without triggering
    // layout (avoids forced reflow on every render).
    this._scrollTopValue = 0;
    this._scrollLeftValue = 0;
    this._pendingScrollTopRow = this.props.initialScrollTopRow;
    this._pendingScrollLeftColumn = this.props.initialScrollLeftColumn;

    // Viewport size (updated by ResizeObserver).
    this._viewportHeight = 0;
    this._viewportWidth = 0;

    // Blink state.
    this._blinkOff = false;
    this._blinkInterval = null;
    this._blinkResume = null;

    // RAF handle for batched updates.
    this._rafHandle = null;
    this._mounted = false;

    // Block decorations.
    this._blockDecorations = new BlockDecorations({
      scheduleUpdate: () => this._scheduleUpdate(),
      replayAutoscroll: () => this._replayLastAutoscroll()
    });

    // Overlay decorations.
    this._overlays = new OverlayDecorations({
      scheduleUpdate: () => this._scheduleUpdate(),
      getLineHeight: () => this._lineHeight,
      getCharWidth: () => this._charWidth,
      getScroller: () => this._scroller,
      getContentElement: () => this._linesWrapper,
      getPixelPositionForScreenPosition: (screenPosition) => this.pixelPositionForScreenPosition(screenPosition),
      getPixelTopForRow: () => this._pixelTopForRow,
      getElement: () => this.element
    });

    // Gutter row cache (mirrors Solid gutterCache).
    this._gutterCache = new Map();

    // Last autoscroll request — replayed when block heights become known.
    this._lastAutoscroll = null;
    this._lastAutoscrollTimer = null;
    this._pendingAutoscroll = null;

    // Subscriptions.
    this._intersectionObserver = null;
    this._activeItemSub = null;
    this._tokenizeSub = null;
    this._placeholderSub = null;
    this._decorationsSub = null;
    this._destroySub = null;
    this._grammarSub = null;
    this._selectionClipboardImmediateId = null;
    this._pendingSelectionClipboardText = null;

    this.nextUpdatePromise = null;
    this.resolveNextUpdatePromise = null;

    // DOM setup.
    while (this.element.firstChild) this.element.removeChild(this.element.firstChild);

    this.element.classList.add('editor');

    // Hidden input: captures typed text as `input` events.
    this.hiddenInput = document.createElement('input');
    this.hiddenInput.classList.add('hidden-input');
    this.hiddenInput.setAttribute('tabindex', '-1');
    this.hiddenInput.style.cssText =
      'position: absolute; width: 1px; height: 1px; opacity: 0; ' +
      'padding: 0; border: 0; pointer-events: none; z-index: 5;';
    this.hiddenInput.addEventListener('input', this._onHiddenInputInput.bind(this));
    this.hiddenInput.addEventListener('paste', this._onHiddenInputPaste.bind(this));
    this.hiddenInput.addEventListener('focus', this._onHiddenInputFocus.bind(this));
    this.hiddenInput.addEventListener('blur', this._onHiddenInputBlur.bind(this));
    this.element.appendChild(this.hiddenInput);

    const isMini = this.props.model.isMini();

    // Root layout div: flex column, fills element.
    this._rootEl = document.createElement('div');
    this._rootEl.className = 'pulsar-editor-root';
    this._rootEl.style.cssText =
      'display: flex; flex-direction: column; width: 100%; ' +
      (isMini ? 'height: auto; ' : 'height: 100%; ') +
      'overflow: hidden; box-sizing: border-box;';
    this.element.appendChild(this._rootEl);

    // Measurement fixture (off-screen hidden div for font metrics).
    const { measure, appendFixtureToEl, measureRO } = createMeasurement({
      component: this,
      model: this.props.model,
      onMeasure: () => {
        this._flushPendingLogicalScrollPosition();
        this._flushPendingAutoscroll();
        this._scheduleUpdate();
      }
    });
    this._measure = measure;
    this._measureRO = measureRO;
    appendFixtureToEl(this._rootEl);

    // Editor body: flex row — gutter (sticky) + scroll-view.
    this._bodyEl = document.createElement('div');
    this._bodyEl.style.cssText =
      'display: flex; flex-direction: row; ' +
      (isMini ? 'flex: 0 0 auto; ' : 'flex: 1; ') +
      'overflow: hidden; min-height: 0;';
    this._rootEl.appendChild(this._bodyEl);

    // Gutter view.
    this._gutterView = new GutterView();
    this._bodyEl.appendChild(this._gutterView.getOuterEl());
    this._gutterInnerEl = this._gutterView.getInnerEl();

    // Scroll-view: this is the stable viewport layer exposed to editor
    // packages. The historical editor's `.scroll-view` did not itself scroll;
    // its content was translated underneath it. Keep that contract so packages
    // like wrap-guide can append absolute-positioned overlays here and have
    // them remain visible while the editor scrolls.
    this._scrollViewEl = document.createElement('div');
    this._scrollViewEl.className = 'scroll-view';
    this._scrollViewEl.style.cssText = 'flex: 1; overflow: hidden; position: relative;';
    this._bodyEl.appendChild(this._scrollViewEl);

    // Native scroll container for the rewritten editor internals. This stays
    // private; external packages should continue targeting `.scroll-view`.
    this._scroller = document.createElement('div');
    this._scroller.className = 'native-scroll-container';
    this._scroller.style.cssText = 'width: 100%; height: 100%; overflow: auto; position: relative;';
    this._scrollViewEl.appendChild(this._scroller);

    // Lines-wrapper: stacking context so `.region`'s z-index:-1 only escapes
    // as far as this element, landing behind the line text.
    this._linesWrapper = document.createElement('div');
    this._linesWrapper.className = 'lines-wrapper';
    this._linesWrapper.style.cssText =
      'position: relative; z-index: 0; white-space: pre;';
    this._scroller.appendChild(this._linesWrapper);

    // Lines view manages topSpacer + lines + bottomSpacer inside linesWrapper.
    this._linesView = new LinesView(this._linesWrapper, {
      onBlockDecorationResize: (info) => this._blockDecorations.invalidate(info ? info.decoration : null)
    });

    // Highlights layer (selections + highlight decorations). z-index:-1 so it
    // paints behind line text within the linesWrapper stacking context.
    this._highlightsEl = document.createElement('div');
    this._highlightsEl.className = 'highlights';
    this._highlightsEl.style.cssText =
      'position: absolute; top: 0; left: 0; right: 0; ' +
      'pointer-events: none; z-index: -1;';
    this._linesWrapper.appendChild(this._highlightsEl);

    // Cursors layer.
    this._cursorsEl = document.createElement('div');
    this._cursorsEl.className = 'cursors';
    this._cursorsEl.style.cssText =
      'position: absolute; top: 0; left: 0; right: 0; pointer-events: none;';
    this._linesWrapper.appendChild(this._cursorsEl);

    // Decorations view manages highlights + cursor elements.
    this._decorationsView = new DecorationsView(this._highlightsEl, this._cursorsEl);

    // Focus override: fire focus event on element first (autocomplete-plus
    // listens there), then forward to hiddenInput for keystroke capture.
    this.element.focus = (options) => {
      if (!this.focused) {
        this.element.dispatchEvent(
          new FocusEvent('focus', { bubbles: false, cancelable: false })
        );
      }
      if (this.hiddenInput) {
        this.hiddenInput.focus(options || { preventScroll: true });
      }
    };

    // Mouse handling.
    this.element.addEventListener('mousedown', this._onMouseDown.bind(this), true);

    // Scroll event: sync position + trigger viewport recompute.
    this._scroller.addEventListener(
      'scroll',
      this._onScroll.bind(this),
      { passive: true }
    );

    // ResizeObserver: keep viewport size current; also re-measure on zoom.
    this._resizeObserver = new ResizeObserver(() => {
      const wasVisible = this.visible;
      this._syncViewportDimensions();
      if (this.attached && this.isVisible()) {
        if (!wasVisible) this.didShow();
        this._flushPendingLogicalScrollPosition();
        this._flushPendingAutoscroll();
        this._scheduleUpdate();
      } else if (this.attached) {
        this.didHide();
      }
    });
    this._resizeObserver.observe(this._scroller);
    this._syncViewportDimensions();

    // Workspace subscription: focus editor when its pane tab becomes active.
    this._activeItemSub = global.atom.workspace.onDidChangeActivePaneItem( (item) => {
      if ( item === this.attached && document.activeElement !== this.hiddenInput ) {
        this.element.focus({ preventScroll: true });
      }
    });

    // TextMate tokenizes asynchronously. Display-layer highlighting changes
    // invalidate affected screen-line objects; this final event only needs a
    // scheduled frame for any pending observers.
    this._tokenizeSub = this.props.model.onDidTokenize(() => {
      this._scheduleUpdate();
    });

    // Placeholder text subscription.
    this._placeholderSub = this.props.model.onDidChangePlaceholderText(() => {
      this._scheduleUpdate();
    });

    // Decoration updates.
    this._decorationsSub = this.props.model.onDidUpdateDecorations(() => {
      this._scheduleUpdate();
      this._overlays.syncFromModel(this.props.model);
      this._blockDecorations.syncFromModel(this.props.model);
    });

    // Initial decoration sync.
    this._blockDecorations.syncFromModel(this.props.model);
    this._overlays.syncFromModel(this.props.model);

    this._destroySub = this.props.model.onDidDestroy(() => this.destroy());

    // Grammar dataset.
    this._updateGrammarDataset();
    this._grammarSub = this.props.model.onDidChangeGrammar(() => {
      this._updateGrammarDataset();
    });

    // Mini attribute.
    if (this.props.model.isMini()) {
      this.element.setAttribute('mini', '');
      this.element.classList.add('mini');
    } else {
      this.element.style.contain = 'size';
    }

    this._mounted = true;

    // Initial measurement attempt.
    const afterMeasure = () => {
      this._flushPendingLogicalScrollPosition();
      this._flushPendingAutoscroll();
    };
    if (!this._measure()) {
      document.fonts.ready.then(() => { this._measure(); afterMeasure(); });
      requestAnimationFrame(() => {
        if (!this._lineHeight) this._measure();
        afterMeasure();
      });
    } else {
      afterMeasure();
    }

    this._scheduleUpdate();

    // Start blink if already focused.
    if (this.focused) this._restartBlink();
  }

  // --- Scroll handler -------------------------------------------------------

  _onScroll() {
    if (!this.visible || !this.isVisible()) return;

    const st = this._scroller.scrollTop;
    const sl = this._scroller.scrollLeft;
    this._scrollTopValue = st;
    this._scrollLeftValue = sl;
    this.scrollTop = st;
    this.scrollLeft = sl;

    // Sync gutter translateY same-frame (prevents one-frame lag / shaking).
    this._gutterInnerEl.style.transform = 'translateY(' + (-st) + 'px)';

    // Reposition floating overlays.
    this._overlays.repositionAll();

    this._scheduleUpdate();
  }

  // --- Render loop ----------------------------------------------------------

  _scheduleUpdate() {
    if (!this.visible || !this.isVisible()) return;
    if (this._rafHandle !== null) return;
    this._rafHandle = requestAnimationFrame(() => {
      this._rafHandle = null;
      this._render();
    });
  }

  _render() {
    const model = this.props.model
    if (!this._mounted || !this.isVisible() || model.isDestroyed()) return;

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

    const totalRows = model.getScreenLineCount();
    const displayLayer = model.displayLayer;

    // Sorted block decorations (needed by viewport math + views).
    const sortedBlocks = computeSortedBlocks(this._blockDecorations.map);

    // Expose imperative helpers used by autoscroll, mouse handling, overlays.
    const topForRow = (row) => pixelTopForRow(row, lineHeight, sortedBlocks);
    const bottomForRow = (row) => pixelBottomForRow(row, lineHeight, sortedBlocks);
    this._pixelTopForRow = topForRow;
    this._pixelBottomForRow = bottomForRow;
    this._rowAtPixel = (px) => rowAtPixel(px, lineHeight, totalRows, sortedBlocks);

    // Viewport.
    const firstRow = computeFirstRenderedRow(scrollTop, lineHeight, totalRows, sortedBlocks);
    const lastRow = computeLastRenderedRow(scrollTop, viewportHeight, lineHeight, totalRows, sortedBlocks);
    const visColRange = computeVisibleColumnRange(scrollLeft, viewportWidth, charWidth);
    const topSpacer = computeTopSpacer(firstRow, lineHeight, sortedBlocks);
    let bottomSpacer = computeBottomSpacer(lastRow, totalRows, lineHeight, sortedBlocks);

    // Total content height (for overlay layer heights).
    let blocksTotal = 0;
    for (const b of sortedBlocks) blocksTotal += b.height;
    let totalHeight = totalRows * (lineHeight || 0) + blocksTotal;

    // Longest line width for horizontal scroll range.
    const longestLineWidth = model.isSoftWrapped()
      ? viewportWidth
      : this._computeLongestLineWidth(model, charWidth);

    // Gutter state.
    const showGutter = model.isMini()
      ? false
      : model.anyLineNumberGutterVisible();
    const showLineNumbers = model.doesShowLineNumbers();
    const maxDigits = Math.max(2, String(model.getLineCount()).length);

    // Decoration maps.
    const lineNumDecoClasses = computeLineNumDecoClasses(model);

    // Visible gutter rows (with cache).
    const visibleGutterRows = this._computeVisibleGutterRows(firstRow, lastRow, model, totalRows);

    // Selection ranges.
    const selections = model.getSelections();
    const hasSelection = selections.some((s) => !s.isEmpty());
    this.element.classList.toggle('has-selection', hasSelection);
    const selectionRanges = selections.map((s) => s.getScreenRange());

    // Cursor descriptors (position + merged cursor-decoration class/style).
    const cursorDescriptors = this._computeCursorDescriptors(model);

    // Set of screen rows that have a cursor (for cursor-line class on lines).
    const showCursorLine = !model.isMini() && !hasSelection;
    const cursorRows = showCursorLine
      ? this._computeCursorRows(cursorDescriptors, lineHeight)
      : new Set();

    // Highlight decorations (find-results, bracket-matcher, linter, etc.).
    const highlightDecos = computeHighlightDecos(model, firstRow, lastRow);

    // Placeholder text (mini editors).
    const placeholderText = this._computePlaceholderText(model);

    // Update DOM via views.
    this._linesView.update({
      firstRow, lastRow, model, displayLayer,
      sortedBlocks, topSpacer, bottomSpacer,
      charWidth, lineHeight, visColRange,
      cursorRows, placeholderText, longestLineWidth,
    });

    if (this._blockDecorations.syncRenderedHeights()) {
      blocksTotal = 0;
      for (const b of sortedBlocks) blocksTotal += b.height;
      totalHeight = totalRows * (lineHeight || 0) + blocksTotal;
      bottomSpacer = computeBottomSpacer(lastRow, totalRows, lineHeight, sortedBlocks);
    }

    this._gutterView.update({
      showGutter, showLineNumbers, maxDigits,
      visibleGutterRows, sortedBlocks,
      topSpacer, bottomSpacer,
      lineNumDecoClasses, scrollTop
    });

    this._decorationsView.update({
      selectionRanges, highlightDecos,
      cursorDescriptors,
      blinkOff: this._blinkOff,
      lineHeight, charWidth,
      topForRow, totalHeight
    });

    this._applyScrollPositionToDOM();

    let needsFollowupRender = false;
    if (model.isSoftWrapped()) {
      needsFollowupRender = this._syncViewportDimensions();
      if (this.updateModelSoftWrapColumn()) needsFollowupRender = true;
      if (needsFollowupRender) this._scheduleUpdate();
    }

    // Resolve pending update promise so callers to getNextUpdatePromise() unblock.
    if (this.resolveNextUpdatePromise && !needsFollowupRender) {
      this.resolveNextUpdatePromise();
      this.nextUpdatePromise = null;
      this.resolveNextUpdatePromise = null;
    }
  }

  // --- Computed values ------------------------------------------------------

  _computeLongestLineWidth(model, charWidth) {
    if (!charWidth) return 0;
    const longestRow = model.getApproximateLongestScreenRow();
    const length = model.lineLengthForScreenRow(longestRow);
    return (length + 1) * charWidth;
  }

  _computeVisibleGutterRows(firstRow, lastRow, model, totalRows) {
    if (model.isDestroyed()) return [];
    const count = lastRow - firstRow + 1;
    if (count <= 0) return [];

    const rows = [];
    let prevBufRow = firstRow > 0 ? model.bufferRowForScreenRow(firstRow - 1) : -1;
    for (let i = 0; i < count; i++) {
      const screenRow = firstRow + i;
      const bufRow = model.bufferRowForScreenRow(screenRow);
      const softWrapped = bufRow === prevBufRow;
      const nextBufRow = (i + 1 < count)
        ? model.bufferRowForScreenRow(screenRow + 1)
        : bufRow + 1;
      const length = model.lineLengthForScreenRow(screenRow);
      const foldable = !softWrapped &&
        bufRow !== nextBufRow &&
        length <= PLAIN_TEXT_THRESHOLD &&
        model.isFoldableAtBufferRow(bufRow);

      const cached = this._gutterCache.get(screenRow);
      if (cached &&
          cached.bufferRow === bufRow &&
          cached.softWrapped === softWrapped &&
          cached.foldable === foldable) {
        rows.push(cached);
      } else {
        const wrapper = { screenRow, bufferRow: bufRow, softWrapped, foldable };
        this._gutterCache.set(screenRow, wrapper);
        rows.push(wrapper);
      }
      prevBufRow = bufRow;
    }

    if (this._gutterCache.size > count + GUTTER_CACHE_SLACK) {
      const keepFrom = firstRow - GUTTER_CACHE_SLACK / 2;
      const keepTo = lastRow + GUTTER_CACHE_SLACK / 2;
      for (const k of this._gutterCache.keys()) {
        if (k < keepFrom || k > keepTo) this._gutterCache.delete(k);
      }
    }

    return rows;
  }

  _computeCursorDescriptors(model) {
    if (model.isDestroyed()) return [];
    const cursors = model.getCursors();
    if (cursors.length === 0) return [];

    let propsByMarker = null;
    if (model.decorationManager.decorationPropertiesByMarkerForScreenRowRange) {
      const total = model.getScreenLineCount();
      propsByMarker = model.decorationManager.decorationPropertiesByMarkerForScreenRowRange(0, total);
    }

    return cursors.map((c) => {
      const position = c.getScreenPosition();
      let extraClass = null;
      let extraStyle = null;
      if (propsByMarker) {
        const decos = propsByMarker.get(c.getMarker());
        if (decos) {
          for (const d of decos) {
            if (!d) continue;
            const type = d.type;
            const isCursor = Array.isArray(type)
              ? type.indexOf('cursor') !== -1
              : type === 'cursor';
            if (!isCursor) continue;
            if (d.class) extraClass = extraClass ? extraClass + ' ' + d.class : d.class;
            if (d.style) extraStyle = Object.assign(extraStyle || {}, d.style);
          }
        }
      }
      return { position, extraClass, extraStyle };
    });
  }

  _computeCursorRows(cursorDescriptors, lineHeight) {
    const s = new Set();
    for (const { position, extraStyle } of cursorDescriptors) {
      if (!position) continue;
      let displayRow = position.row;
      if (extraStyle && extraStyle.top != null && lineHeight > 0) {
        const v = extraStyle.top;
        if (typeof v === 'string' && v.endsWith('px')) {
          displayRow += Math.round(parseFloat(v) / lineHeight);
        } else if (typeof v === 'number') {
          displayRow += Math.round(v / lineHeight);
        }
      }
      s.add(displayRow);
    }
    return s;
  }

  _computePlaceholderText(model) {
    if (!model.isEmpty || !model.isEmpty()) return null;
    return (model.getPlaceholderText ? model.getPlaceholderText() : null);
  }

  // --- Hidden input handlers ------------------------------------------------

  _onHiddenInputInput(event) {
    try {
      if (!this._isInputEnabled()) return;
      const text = event.data;
      if (text != null && text.length > 0) this.props.model.insertText(text);
    } finally {
      this.hiddenInput.value = '';
    }
  }

  _onHiddenInputPaste(event) {
    // Chromium converts Linux middle-click paste into a paste/input event.
    // The editor handles primary-selection paste from mousedown instead.
    if (this.getPlatform() === 'linux') event.preventDefault();
  }

  _onHiddenInputFocus() {
    if (!this.focused) {
      this.focused = true;
      this.element.classList.add('is-focused');
      this._restartBlink();
    }
  }

  _onHiddenInputBlur(event) {
    if (event.relatedTarget && this.element.contains(event.relatedTarget)) return;
    if (this.focused) {
      this.focused = false;
      this.element.classList.remove('is-focused');
      this.element.dispatchEvent(new FocusEvent('blur', { bubbles: false, cancelable: false }));
    }
  }

  // --- Mouse handling -------------------------------------------------------

  _onMouseDown(event) {
    if (event.button !== 0 && event.button !== 1) return;

    // Overlay decorations are siblings of the editor content in the legacy
    // editor, so content mouse handling never sees clicks inside them. The new
    // editor listens on the root element in capture phase; preserve the old
    // contract by leaving overlay clicks to the overlay item itself.
    const overlay = event.target && event.target.closest('atom-overlay');
    if (overlay) {
      // Autocomplete suggestions are not independently focusable UI. Prevent
      // the mousedown from stealing focus from the editor so that, after the
      // suggestion is accepted on mouseup, typing can continue immediately.
      event.preventDefault();
      if (document.activeElement !== this.hiddenInput) {
        this.element.focus({ preventScroll: true });
      }
      return;
    }

    if (document.activeElement !== this.hiddenInput) {
      this.element.focus({ preventScroll: true });
    }

    if (!this._linesWrapper || !this._lineHeight) return;

    const target = event.target;
    const model = this.props.model;

    // Gutter fold toggle: clicking the chevron on a foldable row.
    if (
      event.button === 0 &&
      target &&
      target.matches('.icon-right') &&
      target.parentElement &&
      (target.parentElement.matches('.foldable') || target.parentElement.matches('.folded'))
    ) {
      const lineNumberEl = target.parentElement;
      const screenRow = parseInt(lineNumberEl.dataset.screenRow, 10);
      if (!isNaN(screenRow)) {
        const bufferRow = model.bufferPositionForScreenPosition([screenRow, 0]).row;
        model.toggleFoldAtBufferRow(bufferRow);
      }
      event.preventDefault();
      return;
    }

    const linesRect = this._linesWrapper.getBoundingClientRect();
    if (
      event.clientX < linesRect.left ||
      event.clientY < linesRect.top ||
      event.clientX > linesRect.right ||
      event.clientY > linesRect.bottom
    ) {
      return;
    }

    // If the click landed inside a block decoration, let it propagate
    // normally so links and interactive elements inside blocks work.
    if (target && target.closest('.block-decoration')) return;

    if (event.preventDefault) event.preventDefault();
    const screenPosition = this._screenPositionForMouse(event);

    if (event.button === 1) {
      model.setCursorScreenPosition(screenPosition, { autoscroll: false });
      if (
        this.getPlatform() === 'linux' &&
        this._isInputEnabled() &&
        global.atom.config.get('editor.selectionClipboard')
      ) {
        model.insertText(clipboard.readText('selection'));
      }
      return;
    }

    if (target && target.matches('.fold-marker')) {
      const bufferPosition = model.bufferPositionForScreenPosition(screenPosition);
      model.destroyFoldsContainingBufferPositions([bufferPosition], false);
      return;
    }

    if (event.shiftKey) {
      model.selectToScreenPosition(screenPosition, { autoscroll: false });
    } else if (event.detail === 2) {
      model.setCursorScreenPosition(screenPosition, { autoscroll: false });
      model.getLastSelection().selectWord({ autoscroll: false });
    } else if (event.detail === 3) {
      model.setCursorScreenPosition(screenPosition, { autoscroll: false });
      model.getLastSelection().selectLine(null, { autoscroll: false });
    } else {
      model.setCursorScreenPosition(screenPosition, { autoscroll: false });
    }

    let dragging = false;
    const onMove = (e) => {
      dragging = true;
      model.selectToScreenPosition(
        this._screenPositionForMouse(e),
        { suppressSelectionMerge: true, autoscroll: false }
      );
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp, true);
      if (dragging) {
        model.finalizeSelections();
        model.mergeIntersectingSelections();
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp, true);
  }

  _screenPositionForMouse(event) {
    const linesRect = this._linesWrapper.getBoundingClientRect();
    const lh = this._lineHeight;
    const cw = this._charWidth;
    const y = event.clientY - linesRect.top;
    const x = event.clientX - linesRect.left;
    const row = this._rowAtPixel(y);
    const clampedRow = Math.min(row, this.props.model.getScreenLineCount() - 1);
    const col = Math.max(0, Math.round(x / cw));
    return this.props.model.clipScreenPosition([clampedRow, col]);
  }

  // --- Update / lifecycle ---------------------------------------------------

  update(props) {
    this.props = Object.assign({}, this.props, props);
    return Promise.resolve();
  }

  scheduleUpdate() { this._scheduleUpdate(); }
  updateSync() { this._render(); }

  _syncMiniEditorDimensions() {
    if (!this.props.model.isMini()) return false;

    let lineHeight = this._lineHeight;
    if (!lineHeight && this.element) {
      const computedStyle = window.getComputedStyle(this.element);
      lineHeight = parseFloat(computedStyle.lineHeight) || parseFloat(computedStyle.fontSize) || 0;
    }
    if (!lineHeight) return false;

    const height = Math.ceil(lineHeight) + 'px';
    let changed = false;
    for (const element of [this._rootEl, this._bodyEl, this._scrollViewEl, this._scroller]) {
      if (element && element.style.height !== height) {
        element.style.height = height;
        changed = true;
      }
    }
    return changed;
  }

  _syncViewportDimensions() {
    if (!this._scroller) return false;

    const height = this._scroller.clientHeight;
    const width = this._scroller.clientWidth;
    const changed = height !== this._viewportHeight || width !== this._viewportWidth;
    this._viewportHeight = height;
    this._viewportWidth = width;
    return changed;
  }

  updateModelSoftWrapColumn() {
    const model = this.props.model;
    if (!this._charWidth) return false;
    if (model.width != null) return false;

    const editorWidthInChars = this.getScrollContainerClientWidthInBaseCharacters();
    if (editorWidthInChars > 0 && editorWidthInChars !== model.getEditorWidthInChars()) {
      model.setEditorWidthInChars(editorWidthInChars);
      return true;
    }

    return false;
  }

  isVisible() {
    if (this.props.model.isMini()) {
      return this.element.isConnected;
    }
    return this.element.offsetWidth > 0 || this.element.offsetHeight > 0;
  }

  _applyScrollPositionToDOM() {
    if (!this._scroller) return;

    if (this._scroller.scrollTop !== this.scrollTop) {
      this._scroller.scrollTop = this.scrollTop || 0;
    }
    if (this._scroller.scrollLeft !== this.scrollLeft) {
      this._scroller.scrollLeft = this.scrollLeft || 0;
    }
    if (this._gutterInnerEl) {
      this._gutterInnerEl.style.transform =
        'translateY(' + (-(this.scrollTop || 0)) + 'px)';
    }
  }

  _flushPendingLogicalScrollPosition() {
    let changed = false;

    if (this._pendingScrollTopRow != null && this._lineHeight) {
      changed = this.setScrollTopRow(this._pendingScrollTopRow, false) || changed;
      this._pendingScrollTopRow = null;
    }

    if (this._pendingScrollLeftColumn != null && this._charWidth) {
      changed = this.setScrollLeftColumn(this._pendingScrollLeftColumn, false) || changed;
      this._pendingScrollLeftColumn = null;
    }

    return changed;
  }

  _flushPendingAutoscroll() {
    if (!this._pendingAutoscroll) return false;
    if (
      !this.visible ||
      !this._lineHeight ||
      this._viewportHeight <= 0 ||
      this._viewportWidth <= 0
    ) {
      return false;
    }

    const pending = this._pendingAutoscroll;
    this._pendingAutoscroll = null;
    return this._applyAutoscroll(pending);
  }

  getNextUpdatePromise() {
    if (!this.nextUpdatePromise) {
      this.nextUpdatePromise = new Promise((resolve) => {
        this.resolveNextUpdatePromise = resolve;
      });
    }
    return this.nextUpdatePromise;
  }

  didAttach() {
    if (this.attached) return;

    this.attached = true;
    if (!PulsarTextEditorComponent.attachedComponents) {
      PulsarTextEditorComponent.attachedComponents = new Set();
    }
    PulsarTextEditorComponent.attachedComponents.add(this);

    if (typeof IntersectionObserver !== 'undefined') {
      this._intersectionObserver = new IntersectionObserver((entries) => {
        const { intersectionRect } = entries[entries.length - 1];
        if (intersectionRect.width > 0 || intersectionRect.height > 0) {
          this.didShow();
        } else {
          this.didHide();
        }
      });
      this._intersectionObserver.observe(this.element);
    }

    if (this.isVisible()) {
      this.didShow();
    } else {
      this.didHide();
    }
  }

  didDetach() {
    if (!this.attached) return;

    if (this._intersectionObserver) {
      this._intersectionObserver.disconnect();
      this._intersectionObserver = null;
    }

    this.didHide();
    this.attached = false;
    if (PulsarTextEditorComponent.attachedComponents) {
      PulsarTextEditorComponent.attachedComponents.delete(this);
    }
  }

  destroy() {
    this.didDetach();
    this._mounted = false;
    if (this._rafHandle !== null) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
    }
    if (this._blinkInterval) { clearInterval(this._blinkInterval); this._blinkInterval = null; }
    if (this._blinkResume) { clearTimeout(this._blinkResume); this._blinkResume = null; }
    if (this._activeItemSub) { this._activeItemSub.dispose(); this._activeItemSub = null; }
    if (this._tokenizeSub) { this._tokenizeSub.dispose(); this._tokenizeSub = null; }
    if (this._placeholderSub) { this._placeholderSub.dispose(); this._placeholderSub = null; }
    if (this._decorationsSub) { this._decorationsSub.dispose(); this._decorationsSub = null; }
    if (this._destroySub) { this._destroySub.dispose(); this._destroySub = null; }
    if (this._grammarSub) { this._grammarSub.dispose(); this._grammarSub = null; }
    if (this._intersectionObserver) { this._intersectionObserver.disconnect(); this._intersectionObserver = null; }
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
    if (this._measureRO) { this._measureRO.disconnect(); }
    if (this._selectionClipboardImmediateId) {
      clearImmediate(this._selectionClipboardImmediateId);
      this._selectionClipboardImmediateId = null;
    }
    this._pendingSelectionClipboardText = null;
    this._blockDecorations.destroyAll();
    this._overlays.destroyAll();
  }

  didShow() {
    if (!this.isVisible()) return;

    this._syncViewportDimensions();
    this.visible = true;
    this.props.model.setVisible(true);
    if (!this._lineHeight) this._measure();

    // Re-apply the logical scroll position that we preserved while hidden.
    this._scrollTopValue = this.scrollTop || 0;
    this._scrollLeftValue = this.scrollLeft || 0;
    this._applyScrollPositionToDOM();

    this._flushPendingLogicalScrollPosition();
    this._flushPendingAutoscroll();
    this._scheduleUpdate();
  }

  didHide() {
    if (!this.visible) return;
    this.visible = false;
    this.props.model.setVisible(false);
  }

  didFocus() {
    if (!this.visible) this.didShow();

    if (!this.focused) {
      this.focused = true;
      this.element.classList.add('is-focused');
      this._restartBlink();
    }

    this._scheduleUpdate();
  }

  didBlur(event) {
    if (event && event.relatedTarget === this.hiddenInput) {
      event.stopImmediatePropagation();
      return;
    }
    if (this.focused) {
      this.focused = false;
      this.element.classList.remove('is-focused');
    }
  }

  _updateGrammarDataset() {
    const grammar = this.props.model.getGrammar();
    if (grammar && grammar.scopeName) {
      this.element.dataset.grammar = grammar.scopeName.replace(/\./g, ' ');
    } else {
      delete this.element.dataset.grammar;
    }
  }

  didUpdateStyles() {
    this._measure();
    this._scheduleUpdate();
  }

  didUpdateScrollbarStyles() {}

  // --- Model callbacks ------------------------------------------------------

  didChangeDisplayLayer(_changes) {
    this._scheduleUpdate();
  }

  didResetDisplayLayer() {
    this._scheduleUpdate();
  }

  didChangeSelectionRange() {
    this._scheduleUpdate();
    this._restartBlink();
    this._writeSelectionClipboard();
  }

  didUpdateSelections() {
    this._scheduleUpdate();
    this._restartBlink();
    this._writeSelectionClipboard();
  }

  _writeSelectionClipboard() {
    if (this.getPlatform() !== 'linux') return;

    const model = this.props.model;
    if (model.isDestroyed()) return;

    const selectedText = model.getSelectedText();
    if (!selectedText) return;
    if (selectedText === this._pendingSelectionClipboardText) return;

    if (this._selectionClipboardImmediateId) {
      clearImmediate(this._selectionClipboardImmediateId);
    }

    this._pendingSelectionClipboardText = selectedText;
    this._selectionClipboardImmediateId = setImmediate(() => {
      this._selectionClipboardImmediateId = null;
      this._pendingSelectionClipboardText = null;

      const model = this.props.model;
      if (model.isDestroyed()) return;

      const selectedText = model.getSelectedText();
      if (!selectedText) return;

      electron.ipcRenderer.send(
        'write-text-to-selection-clipboard',
        selectedText
      );
    });
  }

  // --- Blinking -------------------------------------------------------------

  _restartBlink() {
    if (this._blinkInterval) clearInterval(this._blinkInterval);
    if (this._blinkResume) clearTimeout(this._blinkResume);
    this._blinkOff = false;
    if (this._decorationsView) this._decorationsView.setBlink(false);
    this._blinkResume = setTimeout(() => {
      this._blinkInterval = setInterval(() => {
        if (!this.focused || !this.attached) return;
        this._blinkOff = !this._blinkOff;
        this._decorationsView.setBlink(this._blinkOff);
      }, CURSOR_BLINK_PERIOD / 2);
    }, CURSOR_BLINK_RESUME_DELAY);
  }

  // --- Autoscroll -----------------------------------------------------------

  didRequestAutoscroll(autoscroll) {
    if (!autoscroll) return;
    this._pendingAutoscroll = autoscroll;
    this._scheduleUpdate();
  }

  _applyAutoscroll(autoscroll) {
    if (!autoscroll) return false;
    const { screenRange, options } = autoscroll;
    if (!screenRange) return false;
    if (
      !this._scroller ||
      !this._lineHeight ||
      !this.visible ||
      this._viewportHeight <= 0 ||
      this._viewportWidth <= 0
    ) {
      this._pendingAutoscroll = autoscroll;
      return false;
    }

    this._lastAutoscroll = { screenRange, options };
    if (this._lastAutoscrollTimer) clearTimeout(this._lastAutoscrollTimer);
    this._lastAutoscrollTimer = setTimeout(() => { this._lastAutoscroll = null; }, 500);
    this._autoscrollVertically(screenRange, options);
    this._autoscrollHorizontally(screenRange, options);
    return true;
  }

  _autoscrollVertically(screenRange, options) {
    const lh = this._lineHeight;
    if (!this.visible || !lh || this._viewportHeight <= 0) {
      this._pendingAutoscroll = { screenRange, options };
      return;
    }

    const sortedBlocks = computeSortedBlocks(this._blockDecorations.map);
    const startPx = this._pixelTopForRow
      ? this._pixelTopForRow(screenRange.start.row)
      : screenRange.start.row * lh;
    const endPx = this._pixelBottomForRow
      ? this._pixelBottomForRow(screenRange.end.row)
      : screenRange.end.row * lh + lh;

    const viewH = this._viewportHeight;
    const marginLines = Math.min(
      this.props.model.verticalScrollMargin != null
        ? this.props.model.verticalScrollMargin
        : DEFAULT_VERTICAL_SCROLL_MARGIN,
      Math.max(0, Math.floor((viewH / lh - 1) / 2))
    );
    const margin = marginLines * lh;

    const currentScrollTop = this.scrollTop;
    let targetScrollTop = currentScrollTop;
    if (options && options.center) {
      targetScrollTop = (startPx + endPx) / 2 - viewH / 2;
    } else if (!options || options.reversed !== false) {
      if (endPx + margin > targetScrollTop + viewH) targetScrollTop = endPx + margin - viewH;
      if (startPx - margin < targetScrollTop) targetScrollTop = Math.max(0, startPx - margin);
    } else {
      if (startPx - margin < targetScrollTop) targetScrollTop = Math.max(0, startPx - margin);
      if (endPx + margin > targetScrollTop + viewH) targetScrollTop = endPx + margin - viewH;
    }
    targetScrollTop = Math.max(0, targetScrollTop);
    if (targetScrollTop === currentScrollTop) return;

    this.scrollTop = targetScrollTop;
    this._scrollTopValue = targetScrollTop;
    this._scheduleUpdate();

    let blocksTotal = 0;
    for (const b of sortedBlocks) blocksTotal += b.height;
    const maxScrollTop = Math.max(0, this.getScrollHeight() + blocksTotal - viewH);
    const clamped = Math.min(targetScrollTop, maxScrollTop);
    this.scrollTop = clamped;
    this._scrollTopValue = clamped;
    this._scroller.scrollTop = clamped;
    this._gutterInnerEl.style.transform = 'translateY(' + (-clamped) + 'px)';
  }

  _autoscrollHorizontally(screenRange, options) {
    const cw = this._charWidth;
    if (!cw || !this._scroller || !this.visible || this._viewportWidth <= 0) {
      this._pendingAutoscroll = { screenRange, options };
      return;
    }
    const startPx = screenRange.start.column * cw;
    const endPx = screenRange.end.column * cw;
    const viewW = this._viewportWidth;
    const marginCols = Math.min(
      this.props.model.horizontalScrollMargin != null
        ? this.props.model.horizontalScrollMargin
        : DEFAULT_HORIZONTAL_SCROLL_MARGIN,
      Math.max(0, Math.floor((viewW / cw - 1) / 2))
    );
    const margin = marginCols * cw;

    const currentScrollLeft = this.scrollLeft;
    let targetScrollLeft = currentScrollLeft;
    if (!options || options.reversed !== false) {
      if (endPx + margin > targetScrollLeft + viewW)
        targetScrollLeft = endPx + margin - viewW;
      if (startPx - margin < targetScrollLeft)
        targetScrollLeft = Math.max(0, startPx - margin);
    } else {
      if (startPx - margin < targetScrollLeft)
        targetScrollLeft = Math.max(0, startPx - margin);
      if (endPx + margin > targetScrollLeft + viewW)
        targetScrollLeft = endPx + margin - viewW;
    }

    const clamped = Math.max(0, Math.min(targetScrollLeft, this.getMaxScrollLeft()));
    if (clamped === currentScrollLeft) return;

    this.scrollLeft = clamped;
    this._scrollLeftValue = clamped;
    this._scroller.scrollLeft = clamped;
    this._scheduleUpdate();
  }

  // --- Block decorations ----------------------------------------------------

  addBlockDecoration(decoration) {
    this._blockDecorations.add(decoration);
  }

  invalidateBlockDecorationDimensions(decoration) {
    this._blockDecorations.invalidate(decoration);
  }

  _replayLastAutoscroll() {
    if (!this._lastAutoscroll) return;
    const { screenRange, options } = this._lastAutoscroll;
    this._autoscrollVertically(screenRange, options);
    this._autoscrollHorizontally(screenRange, options);
  }

  // --- Position / measurement queries ---------------------------------------

  pixelPositionForScreenPosition(screenPosition) {
    if (!screenPosition) return { top: 0, left: 0 };
    const row = screenPosition.row || 0;
    const top = this._pixelTopForRow
      ? this._pixelTopForRow(row)
      : row * this._lineHeight;
    return { top, left: (screenPosition.column || 0) * this._charWidth };
  }

  screenPositionForPixelPosition({ top, left }) {
    const lh = this._lineHeight;
    const cw = this._charWidth;
    if (!lh) return this.props.model.clipScreenPosition([0, 0]);
    const row = this._rowAtPixel(top);
    const col = Math.max(0, Math.round(left / (cw || 1)));
    return this.props.model.clipScreenPosition([row, col]);
  }

  pixelRangeForScreenRange(range) {
    return {
      start: this.pixelPositionForScreenPosition(range.start),
      end: this.pixelPositionForScreenPosition(range.end)
    };
  }

  renderedScreenLineForRow(_row) { return null; }
  measureDimensions() {
    const measured = this._measure();
    this._syncViewportDimensions();
    const wrapColumnChanged = this.updateModelSoftWrapColumn();
    return measured || wrapColumnChanged;
  }

  // --- Dimensions -----------------------------------------------------------

  getLineHeight() { return this._lineHeight || 0; }
  getBaseCharacterWidth() { return this._charWidth || 0; }

  getContentHeight() {
    return this.props.model.getScreenLineCount() * (this._lineHeight || 0);
  }

  getContentWidth() {
    return (this.props.model.getMaxScreenLineLength
      ? this.props.model.getMaxScreenLineLength()
      : 0) * (this._charWidth || 0);
  }

  getClientContainerHeight() {
    return this._scroller
      ? this._scroller.clientHeight
      : (this.element ? this.element.clientHeight : 0);
  }

  getClientContainerWidth() {
    return this._scroller
      ? this._scroller.clientWidth
      : (this.element ? this.element.clientWidth : 0);
  }

  getScrollContainerHeight() { return this.getClientContainerHeight(); }
  getScrollContainerWidth() { return this.getClientContainerWidth(); }
  getScrollContainerClientWidth() { return this.getClientContainerWidth(); }
  getScrollContainerClientHeight() { return this.getClientContainerHeight(); }

  getScrollContainerClientWidthInBaseCharacters() {
    const charWidth = this.getBaseCharacterWidth();
    if (!charWidth) return 0;
    return Math.floor(this.getScrollContainerClientWidth() / charWidth);
  }

  getVerticalScrollbarWidth() { return 0; }
  getHorizontalScrollbarHeight() { return 0; }
  getGutterContainerWidth() { return 0; }

  // --- Scroll ---------------------------------------------------------------

  getScrollTop() { return this.scrollTop; }
  setScrollTop(top, scheduleUpdate = true) {
    if (Number.isNaN(top) || top == null) return false;

    const v = Math.max(0, Math.min(this.getMaxScrollTop(), top || 0));
    const changed = v !== this.scrollTop;
    this.scrollTop = v;
    this._scrollTopValue = v;
    if (this._scroller) this._scroller.scrollTop = v;
    if (this._gutterInnerEl) {
      this._gutterInnerEl.style.transform = 'translateY(' + (-v) + 'px)';
    }
    if (changed) this.element.emitter.emit('did-change-scroll-top', v);
    if (changed && scheduleUpdate) this._scheduleUpdate();
    return changed;
  }

  getScrollLeft() { return this.scrollLeft; }
  setScrollLeft(left, scheduleUpdate = true) {
    if (Number.isNaN(left) || left == null) return false;

    const v = Math.max(0, Math.min(this.getMaxScrollLeft(), left || 0));
    const changed = v !== this.scrollLeft;
    this.scrollLeft = v;
    this._scrollLeftValue = v;
    if (this._scroller) this._scroller.scrollLeft = v;
    if (changed) this.element.emitter.emit('did-change-scroll-left', v);
    if (changed && scheduleUpdate) this._scheduleUpdate();
    return changed;
  }

  getScrollBottom() { return this.getScrollTop() + this.getClientContainerHeight(); }
  setScrollBottom(bottom) { return this.setScrollTop(bottom - this.getClientContainerHeight()); }

  getScrollRight() { return this.getScrollLeft() + this.getClientContainerWidth(); }
  setScrollRight(right) { return this.setScrollLeft(right - this.getClientContainerWidth()); }

  getScrollHeight() { return this.getContentHeight(); }
  getScrollWidth() {
    const model = this.props.model;
    const clientWidth = this.getScrollContainerClientWidth();
    if (model.isSoftWrapped()) return clientWidth;
    if (model.getAutoWidth()) return this.getContentWidth();
    return Math.max(this.getContentWidth(), clientWidth);
  }

  getMaxScrollTop() {
    return Math.max(0, this.getScrollHeight() - this.getClientContainerHeight());
  }

  getMaxScrollLeft() {
    return Math.max(0, this.getScrollWidth() - this.getClientContainerWidth());
  }

  getScrollTopRow() {
    if (this._lineHeight) return Math.floor(this.getScrollTop() / this._lineHeight);
    return this._pendingScrollTopRow || 0;
  }

  setScrollTopRow(row, scheduleUpdate = true) {
    if (!this._lineHeight) {
      this._pendingScrollTopRow = row;
      return false;
    }

    return this.setScrollTop(
      pixelTopForRow(row, this._lineHeight, computeSortedBlocks(this._blockDecorations.map)),
      scheduleUpdate
    );
  }

  getScrollLeftColumn() {
    if (this._charWidth) return Math.floor(this.getScrollLeft() / this._charWidth);
    return this._pendingScrollLeftColumn || 0;
  }

  setScrollLeftColumn(column, scheduleUpdate = true) {
    if (!this._charWidth) {
      this._pendingScrollLeftColumn = column;
      return false;
    }

    return this.setScrollLeft(column * this._charWidth, scheduleUpdate);
  }

  // --- Viewport -------------------------------------------------------------

  getFirstVisibleRow() { return this.getScrollTopRow(); }

  getLastVisibleRow() {
    const lh = this._lineHeight;
    if (!lh) return 0;
    return Math.min(
      this.props.model.getScreenLineCount() - 1,
      Math.floor((this.getScrollTop() + this.getClientContainerHeight()) / lh)
    );
  }

  getFirstVisibleColumn() { return this.getScrollLeftColumn(); }

  getRenderedStartRow() { return 0; }
  getRenderedEndRow() { return this.props.model.getScreenLineCount(); }

  // --- Input ----------------------------------------------------------------

  setInputEnabled(enabled) {
    this.inputEnabled = enabled !== false;
    if (this.hiddenInput) this.hiddenInput.value = '';
    this.props.model.update({ keyboardInputEnabled: this.inputEnabled });
  }
  getHiddenInput() { return this.hiddenInput; }

  _isInputEnabled() {
    const model = this.props.model;
    return ( this.inputEnabled && !model.isReadOnly() && model.isKeyboardInputEnabled() );
  }

  getPlatform() {
    return this.props.platform || process.platform;
  }

  // --- Decoration / gutter queries ------------------------------------------

  queryGuttersToRender() {
    return [this.props.model.getLineNumberGutter()];
  }

  queryDecorationsToRender() {}
}

PulsarTextEditorComponent.attachedComponents = null;

module.exports = PulsarTextEditorComponent;
