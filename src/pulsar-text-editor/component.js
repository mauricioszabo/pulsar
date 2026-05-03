'use babel';

// SolidJS-based TextEditorComponent — Commit D (feature-complete MVP).
//
// Features in this commit:
//  - Line number gutter with buffer-row numbers and soft-wrap dots.
//  - Viewport virtualization: only the rows currently visible in the
//    scroll viewport (plus OVERSCAN rows of padding above/below) are
//    rendered. Top and bottom spacer divs fill the rest of the
//    content height so native scrollbars are correctly sized.
//  - Correct layout: the gutter sticks to the left via CSS
//    `position: sticky; left: 0` and lines use a block flow layout,
//    so the browser establishes the content width naturally from the
//    longest rendered line. No more `width: 1px` starvation.
//  - Correct syntax highlighting via the existing `walkScreenLineTags`
//    walker, same as the legacy editor.
//  - Selections rendered as `.selection > .region` rects so the
//    existing core CSS (`@syntax-selection-color`) applies.
//  - Blinking cursor via `.cursors.blink-off` toggle, controlled by
//    the existing core CSS rule.
//  - Mouse support: click to position cursor; shift-click extends
//    selection; double/triple-click selects word/line; drag selection.
//  - Autoscroll: `didRequestAutoscroll` drives vertical and horizontal
//    scroll to keep the cursor in view after any movement.
//  - Focus: `element.focus()` is overridden to always target the
//    hidden input, covering every upstream path (pane activation,
//    tab switches, `atom.workspace.open()`, etc.).
//  - Measurement: line height is taken from a block wrapper (not
//    just the inline character), so the full rendered line height
//    including leading is captured. Character width is averaged over
//    100 characters to eliminate per-character subpixel rounding.

const { render, For } = require('solid-js/web');
const {
  createSignal,
  createMemo,
  onMount,
  onCleanup
} = require('solid-js');

const { walkScreenLineTags } = require('../screen-line-tag-walker');

let TextEditor = null;
let TextEditorElement = null;

// How many extra rows to render beyond the visible viewport on each side.
const OVERSCAN = 10;
const CURSOR_BLINK_PERIOD = 800;
const CURSOR_BLINK_RESUME_DELAY = 300;
const DEFAULT_VERTICAL_SCROLL_MARGIN = 2;
const DEFAULT_HORIZONTAL_SCROLL_MARGIN = 6;
const NBSP = ' ';

// ---------------------------------------------------------------------------
// HTML building helpers
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Build the inner HTML for a `.line` div by walking the tag stream.
// Returns a plain HTML string suitable for `innerHTML`.
function buildLineHtml(screenLine, displayLayer) {
  if (!screenLine) return NBSP;
  if (!screenLine.tags || screenLine.tags.length === 0) {
    const text = screenLine.lineText || '';
    return text.length > 0 ? escapeHtml(text) : NBSP;
  }
  let html = '';
  let hasText = false;
  walkScreenLineTags({
    tags: screenLine.tags,
    lineText: screenLine.lineText || '',
    displayLayer,
    onOpenScope: (cls) => { html += '<span class="' + escapeHtml(cls) + '">'; },
    onCloseScope: () => { html += '</span>'; },
    onTextRun: (text) => {
      if (text.length > 0) hasText = true;
      html += escapeHtml(text);
    }
  });
  if (!hasText) html += NBSP;
  return html;
}

// ---------------------------------------------------------------------------
// Solid components
// ---------------------------------------------------------------------------

// One screen line. Uses innerHTML so the span nesting from the tag
// walker is applied as a single DOM mutation rather than a tree of
// Solid components.
function Line(props) {
  const html = createMemo(() =>
    buildLineHtml(props.screenLine, props.displayLayer)
  );
  // `props.cursorLine` is true when this row holds the primary cursor.
  const cls = () => 'line' + (props.cursorLine ? ' cursor-line' : '');
  return (
    <div
      class={cls()}
      data-screen-row={props.row}
      // eslint-disable-next-line solid/no-innerhtml
      innerHTML={html()}
    />
  );
}

// One line-number cell in the gutter.
function LineNumber(props) {
  const cls = () => {
    let c = 'line-number';
    if (props.foldable) c += ' foldable';
    return c;
  };
  // Number string: right-padded with NBSP to maxDigits width; soft-wrapped
  // rows show a bullet instead.
  const label = () => {
    if (!props.showLineNumbers) return '';
    const raw = props.softWrapped ? '•' : String(props.bufferRow + 1);
    return NBSP.repeat(Math.max(0, props.maxDigits - raw.length)) + raw;
  };
  return (
    <div class={cls()} data-screen-row={props.row}>
      <span class="line-number-text">{label()}</span>
      <div class="icon-right" />
    </div>
  );
}

// The left gutter containing line numbers. Lives OUTSIDE the scroll-view
// so it doesn't scroll horizontally. Vertical sync is achieved by applying
// translateY(-scrollTop) to the inner content, exactly as the legacy editor
// does.  The container clips content with `overflow: hidden`.
function GutterContainer(props) {
  // `props.scrollTop`, `props.topSpacer`, `props.bottomSpacer`,
  // `props.visibleRows`, `props.showLineNumbers`, `props.maxDigits`
  // are all accessor functions (memos / signals from Editor).
  return (
    <div
      class="gutter-container"
      style={
        'position: relative; z-index: 1; flex-shrink: 0; ' +
        'background-color: inherit; overflow: hidden; user-select: none;'
      }
    >
      <div
        class="gutter line-numbers"
        style={
          'will-change: transform; ' +
          'transform: translateY(' + (-props.scrollTop()) + 'px);'
        }
      >
        <div style={`height: ${props.topSpacer()}px; display: block;`} />
        <For each={props.visibleRows()}>
          {(item) => (
            <LineNumber
              row={item.screenRow}
              bufferRow={item.bufferRow}
              softWrapped={item.softWrapped}
              foldable={item.foldable}
              showLineNumbers={props.showLineNumbers()}
              maxDigits={props.maxDigits()}
            />
          )}
        </For>
        <div style={`height: ${props.bottomSpacer()}px; display: block;`} />
      </div>
    </div>
  );
}

// Converts a screen-range into a list of absolutely-positioned rect
// descriptors. Callers map these to `.region` divs inside a `.selection`
// wrapper so the core CSS `@syntax-selection-color` rule applies.
function rangeToRects(range, lh, cw) {
  if (!range || range.isEmpty()) return [];
  const { start, end } = range;
  if (start.row === end.row) {
    const w = (end.column - start.column) * cw;
    if (w <= 0) return [];
    return [{
      top: start.row * lh,
      left: start.column * cw,
      width: w,
      right: null,
      height: lh
    }];
  }
  const rects = [];
  // Top partial line (start.col → end of line).
  rects.push({ top: start.row * lh, left: start.column * cw, right: 0, width: null, height: lh });
  // Full middle lines (if any).
  if (end.row - start.row > 1) {
    rects.push({
      top: (start.row + 1) * lh,
      left: 0, right: 0, width: null,
      height: (end.row - start.row - 1) * lh
    });
  }
  // Bottom partial line (0 → end.col).
  if (end.column > 0) {
    rects.push({ top: end.row * lh, left: 0, width: end.column * cw, right: null, height: lh });
  }
  return rects;
}

// Render one selection range as `.region` divs inside a `.selection`.
function SelectionHighlight(props) {
  const rects = createMemo(() => {
    const lh = props.lineHeight();
    const cw = props.charWidth();
    if (!lh || !cw) return [];
    return rangeToRects(props.range, lh, cw);
  });
  return (
    <div class="highlight selection">
      <For each={rects()}>
        {(r) => (
          <div
            class="region"
            style={
              'position: absolute; box-sizing: border-box; ' +
              'top: ' + r.top + 'px; ' +
              'left: ' + r.left + 'px; ' +
              'height: ' + r.height + 'px; ' +
              (r.right != null ? 'right: 0; ' : 'width: ' + r.width + 'px; ')
            }
          />
        )}
      </For>
    </div>
  );
}

// Absolute-positioned cursor bar. Uses CSS `border-left` for the
// visible caret; opacity is controlled by `.is-focused .cursor` and
// `.cursors.blink-off .cursor` in core-ui/text-editor.less.
function CursorBar(props) {
  const style = () => {
    const lh = props.lineHeight();
    const cw = props.charWidth();
    if (!lh || !cw) return 'display: none;';
    const pos = props.position;
    if (!pos) return 'display: none;';
    return (
      'position: absolute; ' +
      'left: ' + (pos.column * cw) + 'px; ' +
      'top: ' + (pos.row * lh) + 'px; ' +
      'width: ' + cw + 'px; ' +
      'height: ' + lh + 'px;'
    );
  };
  return <div class="cursor" style={style()} />;
}

// Top-level editor component.
function Editor(props) {
  const model = props.model;
  const component = props.component;
  const displayLayer = model.displayLayer;

  // --- reactive signals ---

  const [displayVersion, bumpDisplay] = createSignal(0);
  component._notifyDisplayChange = () => bumpDisplay((v) => v + 1);

  const [selectionsVersion, bumpSelections] = createSignal(0);
  component._notifySelectionChange = () => bumpSelections((v) => v + 1);

  // scrollTop and scrollLeft are kept in sync with the scroller DOM
  // element via a scroll event listener installed in onMount.
  const [scrollTop, setScrollTop] = createSignal(0);
  const [scrollLeft, setScrollLeft] = createSignal(0);
  component._setScrollTopSignal = setScrollTop;
  component._setScrollLeftSignal = setScrollLeft;

  // Viewport height in px, updated on resize.
  const [viewportHeight, setViewportHeight] = createSignal(0);

  // Font metrics, filled by the measurement pass in onMount.
  const [lineHeight, setLineHeight] = createSignal(0);
  const [charWidth, setCharWidth] = createSignal(0);

  // Blinking control.
  const [blinkOff, setBlinkOff] = createSignal(false);

  // --- refs ---
  let measureRef;
  let scrollerRef;
  let linesWrapperRef;

  // --- derived data ---

  const totalScreenRows = createMemo(() => {
    displayVersion();
    return model.getScreenLineCount();
  });

  const firstRenderedRow = createMemo(() => {
    const lh = lineHeight();
    if (!lh) return 0;
    return Math.max(0, Math.floor(scrollTop() / lh) - OVERSCAN);
  });

  const lastRenderedRow = createMemo(() => {
    const lh = lineHeight();
    const total = totalScreenRows();
    if (!lh) return Math.min(total - 1, OVERSCAN * 2);
    const viewH = viewportHeight() || (scrollerRef ? scrollerRef.clientHeight : 0);
    return Math.min(total - 1, Math.ceil((scrollTop() + viewH) / lh) + OVERSCAN);
  });

  const topSpacer = createMemo(() => firstRenderedRow() * (lineHeight() || 0));

  const bottomSpacer = createMemo(() => {
    const lh = lineHeight();
    if (!lh) return 0;
    const last = lastRenderedRow();
    const total = totalScreenRows();
    return Math.max(0, (total - 1 - last) * lh);
  });

  // Array of { row, screenLine } objects for visible rows.
  const visibleScreenLines = createMemo(() => {
    displayVersion();
    const first = firstRenderedRow();
    const last = lastRenderedRow();
    const arr = [];
    for (let r = first; r <= last; r++) {
      arr.push({ row: r, screenLine: model.screenLineForScreenRow(r) });
    }
    return arr;
  });

  // Gutter data: same row range with buffer-row metadata.
  const visibleRows = createMemo(() => {
    displayVersion();
    const first = firstRenderedRow();
    const last = lastRenderedRow();
    const count = last - first + 1;
    if (count <= 0) return [];

    const rows = [];
    let prevBufRow = first > 0 ? model.bufferRowForScreenRow(first - 1) : -1;
    for (let i = 0; i < count; i++) {
      const screenRow = first + i;
      const bufRow = model.bufferRowForScreenRow(screenRow);
      const softWrapped = bufRow === prevBufRow;
      const nextBufRow = i + 1 < count
        ? model.bufferRowForScreenRow(screenRow + 1)
        : bufRow + 1;
      const foldable = !softWrapped &&
        bufRow !== nextBufRow &&
        model.isFoldableAtBufferRow(bufRow);
      rows.push({ screenRow, bufferRow: bufRow, softWrapped, foldable });
      prevBufRow = bufRow;
    }
    return rows;
  });

  const maxDigits = createMemo(() => {
    displayVersion();
    return Math.max(2, String(model.getLineCount()).length);
  });

  const showLineNumbers = createMemo(() => {
    displayVersion();
    return model.doesShowLineNumbers ? model.doesShowLineNumbers() : true;
  });

  const cursorPositions = createMemo(() => {
    selectionsVersion();
    return model.getCursors().map((c) => c.getScreenPosition());
  });

  const selectionRanges = createMemo(() => {
    selectionsVersion();
    return model.getSelections().map((s) => s.getScreenRange());
  });

  // Set of screen rows that have a cursor on them, for cursor-line class.
  const cursorRows = createMemo(() => {
    selectionsVersion();
    const s = new Set();
    model.getCursors().forEach((c) => s.add(c.getScreenPosition().row));
    return s;
  });

  // --- measurement ---

  const measure = () => {
    if (!measureRef) return false;
    const lineEl = measureRef.querySelector('.measure-line');
    const spanEl = measureRef.querySelector('.measure-chars');
    if (!lineEl || !spanEl) return false;
    const lineRect = lineEl.getBoundingClientRect();
    const spanRect = spanEl.getBoundingClientRect();
    if (!lineRect.height || !spanRect.width) return false;
    const lh = lineRect.height;
    const cw = spanRect.width / 100;
    setLineHeight(lh);
    setCharWidth(cw);
    component._lineHeight = lh;
    component._charWidth = cw;
    return true;
  };

  onMount(() => {
    component._scroller = scrollerRef;
    component._linesWrapper = linesWrapperRef;

    if (!measure()) {
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => measure());
      }
      requestAnimationFrame(() => { if (!component._lineHeight) measure(); });
    }

    // Sync scroll position signals with the DOM.
    const onScroll = () => {
      const st = scrollerRef.scrollTop;
      const sl = scrollerRef.scrollLeft;
      setScrollTop(st);
      setScrollLeft(sl);
      component.scrollTop = st;
      component.scrollLeft = sl;
    };
    scrollerRef.addEventListener('scroll', onScroll, { passive: true });

    // Resize observer to update viewport height.
    const ro = new ResizeObserver(() => {
      setViewportHeight(scrollerRef.clientHeight);
    });
    ro.observe(scrollerRef);

    onCleanup(() => {
      scrollerRef.removeEventListener('scroll', onScroll);
      ro.disconnect();
    });
  });

  // --- blinking ---

  component._restartBlink = () => {
    if (component._blinkInterval) clearInterval(component._blinkInterval);
    if (component._blinkResume) clearTimeout(component._blinkResume);
    setBlinkOff(false);
    component._blinkResume = setTimeout(() => {
      component._blinkInterval = setInterval(() => {
        if (!component.focused || !component.attached) return;
        setBlinkOff((v) => !v);
      }, CURSOR_BLINK_PERIOD / 2);
    }, CURSOR_BLINK_RESUME_DELAY);
  };

  onMount(() => { if (component.focused) component._restartBlink(); });

  onCleanup(() => {
    if (component._blinkInterval) clearInterval(component._blinkInterval);
    if (component._blinkResume) clearTimeout(component._blinkResume);
  });

  // --- render ---

  return (
    <div
      class="pulsar-editor-root"
      style={
        'display: flex; flex-direction: column; ' +
        'width: 100%; height: 100%; ' +
        'overflow: hidden; box-sizing: border-box;'
      }
    >
      {/* Hidden measurement fixture. The `.measure-line` block gives us
          the full rendered line height (including leading); the inner
          `.measure-chars` span gives us the average character width. */}
      <div
        ref={(el) => (measureRef = el)}
        aria-hidden="true"
        style={
          'position: absolute; left: -9999px; top: 0; ' +
          'visibility: hidden; pointer-events: none;'
        }
      >
        <div class="measure-line" style="display: block; white-space: pre;">
          <span class="measure-chars">{'x'.repeat(100)}</span>
        </div>
      </div>

      {/* Main editor body: gutter (fixed-width, no horizontal scroll) +
          scroll-view (takes the rest, scrolls both axes). The gutter lives
          OUTSIDE the scroll container so it is never scrolled horizontally;
          it syncs vertically through a CSS translateY in GutterContainer. */}
      <div style="display: flex; flex-direction: row; flex: 1; overflow: hidden; min-height: 0;">

        <GutterContainer
          scrollTop={scrollTop}
          visibleRows={visibleRows}
          topSpacer={topSpacer}
          bottomSpacer={bottomSpacer}
          showLineNumbers={showLineNumbers}
          maxDigits={maxDigits}
        />

        {/* Scroll-view: native overflow:auto handles both scrollbars.
            The lines-wrapper inside uses flow layout so each `.line`
            block naturally expands the content width to accommodate
            the longest line — no explicit `width` calculation needed. */}
        <div
          ref={(el) => (scrollerRef = el)}
          class="scroll-view"
          style="flex: 1; overflow: auto; position: relative;"
        >
          <div
            ref={(el) => (linesWrapperRef = el)}
            class="lines-wrapper"
            style="position: relative; white-space: pre; min-width: 100%;"
          >
            {/* Top spacer pushes the first rendered row to its correct
                vertical position. */}
            <div style={`height: ${topSpacer()}px; display: block;`} />

            {/* Rendered lines in flow layout. Each `.line` is `display:
                block` so its content width drives the scroll container
                width. Syntax-highlighted spans nest inside. */}
            <For each={visibleScreenLines()}>
              {(item) => (
                <Line
                  screenLine={item.screenLine}
                  displayLayer={displayLayer}
                  row={item.row}
                  cursorLine={cursorRows().has(item.row)}
                />
              )}
            </For>

            {/* Bottom spacer fills the remaining virtual height. */}
            <div style={`height: ${bottomSpacer()}px; display: block;`} />

            {/* Overlay layers: selections + cursors. Both are absolutely
                positioned with top:0 and cover the full content height
                (all rows, not just the rendered window) so a cursor or
                selection at any row is visible when scrolled there. */}
            <div
              class="highlights"
              style={
                'position: absolute; top: 0; left: 0; right: 0; ' +
                'height: ' + (totalScreenRows() * (lineHeight() || 0)) + 'px; ' +
                'pointer-events: none; overflow: hidden;'
              }
            >
              <For each={selectionRanges()}>
                {(range) => (
                  <SelectionHighlight
                    range={range}
                    lineHeight={lineHeight}
                    charWidth={charWidth}
                  />
                )}
              </For>
            </div>
            <div
              class={'cursors' + (blinkOff() ? ' blink-off' : '')}
              style={
                'position: absolute; top: 0; left: 0; right: 0; ' +
                'height: ' + (totalScreenRows() * (lineHeight() || 0)) + 'px; ' +
                'pointer-events: none; overflow: hidden;'
              }
            >
              <For each={cursorPositions()}>
                {(pos) => (
                  <CursorBar
                    position={pos}
                    lineHeight={lineHeight}
                    charWidth={charWidth}
                  />
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component class — public API called by text-editor-element.js,
// text-editor.js, and various packages.
// ---------------------------------------------------------------------------

class PulsarTextEditorComponent {
  // --- Static API -------------------------------------------------------

  static setScheduler(_scheduler) {}
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

  // --- Construction -----------------------------------------------------

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

    this._lineHeight = 0;
    this._charWidth = 0;

    // Set by the Editor Solid component after it mounts.
    this._notifyDisplayChange = null;
    this._notifySelectionChange = null;
    this._setScrollTopSignal = null;
    this._setScrollLeftSignal = null;
    this._restartBlink = null;
    this._scroller = null;
    this._linesWrapper = null;
    this._blinkInterval = null;
    this._blinkResume = null;
    this._activeItemSub = null;

    // Clear any pre-existing children (e.g. initialText node).
    while (this.element.firstChild) {
      this.element.removeChild(this.element.firstChild);
    }

    // Hidden input: captures typed text as `input` events. All editing
    // key commands (Backspace, arrow keys, etc.) are handled by
    // atom.keymaps and never arrive here as raw key events.
    this.hiddenInput = document.createElement('input');
    this.hiddenInput.classList.add('hidden-input');
    this.hiddenInput.setAttribute('tabindex', '-1');
    this.hiddenInput.style.cssText =
      'position: absolute; width: 1px; height: 1px; opacity: 0; ' +
      'padding: 0; border: 0; pointer-events: none; z-index: 5;';
    this.hiddenInput.addEventListener('input', this._onHiddenInputInput.bind(this));
    this.hiddenInput.addEventListener('focus', this._onHiddenInputFocus.bind(this));
    this.hiddenInput.addEventListener('blur', this._onHiddenInputBlur.bind(this));
    this.element.appendChild(this.hiddenInput);

    // Solid host div.
    this.solidHost = document.createElement('div');
    this.solidHost.classList.add('pulsar-text-editor-solid-host');
    this.solidHost.style.cssText = 'display: block; width: 100%; height: 100%;';
    this.element.appendChild(this.solidHost);

    this.disposeRender = render(
      () => <Editor model={this.props.model} component={this} />,
      this.solidHost
    );

    // Override `element.focus()` to redirect to the hidden input. This
    // handles every upstream call path: `paneElement.activated()`,
    // `activeItemChanged()` after a tab switch,
    // `atom.workspace.open()` post-open focus, etc.
    const originalFocus = this.element.focus.bind(this.element);
    this.element.focus = (options) => {
      if (this.hiddenInput) {
        this.hiddenInput.focus(options);
      } else {
        originalFocus(options);
      }
    };

    // Mousedown: position cursor and start selection drag.
    this.element.addEventListener('mousedown', this._onMouseDown.bind(this), true);

    // Workspace subscription: when a tab switch makes this editor
    // active, focus the hidden input.
    if (global.atom && global.atom.workspace) {
      this._activeItemSub = global.atom.workspace.onDidChangeActivePaneItem(
        (item) => {
          if (
            item === this.props.model &&
            this.attached &&
            document.activeElement !== this.hiddenInput
          ) {
            this.hiddenInput.focus();
          }
        }
      );
    }

    this.nextUpdatePromise = null;
    this.resolveNextUpdatePromise = null;
  }

  // --- Hidden input handlers --------------------------------------------

  _onHiddenInputInput(event) {
    if (!this.inputEnabled) return;
    const text = event.data;
    if (text != null && text.length > 0) {
      this.props.model.insertText(text);
    }
    this.hiddenInput.value = '';
  }

  _onHiddenInputFocus() {
    if (!this.focused) {
      this.focused = true;
      this.element.classList.add('is-focused');
      if (this._restartBlink) this._restartBlink();
    }
  }

  _onHiddenInputBlur(event) {
    if (event.relatedTarget && this.element.contains(event.relatedTarget)) {
      return;
    }
    if (this.focused) {
      this.focused = false;
      this.element.classList.remove('is-focused');
    }
  }

  // --- Mouse handling ---------------------------------------------------

  _onMouseDown(event) {
    if (event.button !== 0) return;

    // Always focus the hidden input on any click inside the editor.
    if (document.activeElement !== this.hiddenInput) {
      this.hiddenInput.focus({ preventScroll: true });
    }

    if (!this._linesWrapper || !this._lineHeight) return;

    const linesRect = this._linesWrapper.getBoundingClientRect();
    // Only treat clicks inside the lines area as cursor-positioning
    // gestures; clicks in the gutter fall through.
    if (
      event.clientX < linesRect.left ||
      event.clientY < linesRect.top ||
      event.clientX > linesRect.right ||
      event.clientY > linesRect.bottom
    ) {
      return;
    }

    event.preventDefault();
    const model = this.props.model;
    const screenPosition = this._screenPositionForMouse(event);

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

    // Track drag to extend the selection.
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
    // getBoundingClientRect().top is the VISUAL top of the element on
    // screen. Subtracting it from clientY gives the distance from the
    // logical top of the lines content, which already accounts for
    // any scroll offset — no need to add scrollTop again.
    const y = event.clientY - linesRect.top;
    const x = event.clientX - linesRect.left;
    const row = Math.max(0, Math.floor(y / lh));
    const clampedRow = Math.min(row, this.props.model.getScreenLineCount() - 1);
    const col = Math.max(0, Math.round(x / cw));
    return this.props.model.clipScreenPosition([clampedRow, col]);
  }

  // --- Update / lifecycle -----------------------------------------------

  update(props) {
    this.props = Object.assign({}, this.props, props);
    return Promise.resolve();
  }

  scheduleUpdate() {}
  updateSync() {}

  getNextUpdatePromise() {
    if (!this.nextUpdatePromise) {
      this.nextUpdatePromise = new Promise((resolve) => {
        this.resolveNextUpdatePromise = resolve;
      });
    }
    return this.nextUpdatePromise;
  }

  didAttach() {
    this.attached = true;
    if (!PulsarTextEditorComponent.attachedComponents) {
      PulsarTextEditorComponent.attachedComponents = new Set();
    }
    PulsarTextEditorComponent.attachedComponents.add(this);
  }

  didDetach() {
    this.attached = false;
    if (PulsarTextEditorComponent.attachedComponents) {
      PulsarTextEditorComponent.attachedComponents.delete(this);
    }
    if (this._activeItemSub) {
      this._activeItemSub.dispose();
      this._activeItemSub = null;
    }
    if (this.disposeRender) {
      this.disposeRender();
      this.disposeRender = null;
    }
  }

  didShow() { this.visible = true; }
  didHide() { this.visible = false; }

  didFocus() {
    if (!this.focused) {
      this.focused = true;
      this.element.classList.add('is-focused');
    }
    if (document.activeElement !== this.hiddenInput) {
      this.hiddenInput.focus();
    }
  }

  didBlur() {
    if (this.focused) {
      this.focused = false;
      this.element.classList.remove('is-focused');
    }
  }

  didUpdateStyles() {}
  didUpdateScrollbarStyles() {}

  // --- Model callbacks --------------------------------------------------

  didChangeDisplayLayer(_changes) {
    if (this._notifyDisplayChange) this._notifyDisplayChange();
    if (this._notifySelectionChange) this._notifySelectionChange();
  }

  didResetDisplayLayer() {
    if (this._notifyDisplayChange) this._notifyDisplayChange();
    if (this._notifySelectionChange) this._notifySelectionChange();
  }

  didChangeSelectionRange() {
    if (this._notifySelectionChange) this._notifySelectionChange();
    if (this._restartBlink) this._restartBlink();
  }

  didUpdateSelections() {
    if (this._notifySelectionChange) this._notifySelectionChange();
    if (this._restartBlink) this._restartBlink();
  }

  didRequestAutoscroll(autoscroll) {
    if (!autoscroll || !this._scroller || !this._lineHeight) return;
    const { screenRange, options } = autoscroll;
    if (!screenRange) return;
    this._autoscrollVertically(screenRange, options);
    this._autoscrollHorizontally(screenRange, options);
  }

  _autoscrollVertically(screenRange, options) {
    const lh = this._lineHeight;
    const startPx = screenRange.start.row * lh;
    const endPx = (screenRange.end.row + 1) * lh;
    const viewH = this._scroller.clientHeight;
    const marginLines = Math.min(
      this.props.model && this.props.model.verticalScrollMargin != null
        ? this.props.model.verticalScrollMargin
        : DEFAULT_VERTICAL_SCROLL_MARGIN,
      Math.max(0, Math.floor((viewH / lh - 1) / 2))
    );
    const margin = marginLines * lh;

    if (options && options.center) {
      const center = (startPx + endPx) / 2;
      this._scroller.scrollTop = center - viewH / 2;
      return;
    }

    if (!options || options.reversed !== false) {
      if (endPx + margin > this._scroller.scrollTop + viewH) {
        this._scroller.scrollTop = endPx + margin - viewH;
      }
      if (startPx - margin < this._scroller.scrollTop) {
        this._scroller.scrollTop = Math.max(0, startPx - margin);
      }
    } else {
      if (startPx - margin < this._scroller.scrollTop) {
        this._scroller.scrollTop = Math.max(0, startPx - margin);
      }
      if (endPx + margin > this._scroller.scrollTop + viewH) {
        this._scroller.scrollTop = endPx + margin - viewH;
      }
    }
  }

  _autoscrollHorizontally(screenRange, options) {
    const cw = this._charWidth;
    if (!cw || !this._scroller) return;
    const startPx = screenRange.start.column * cw;
    const endPx = screenRange.end.column * cw;
    const viewW = this._scroller.clientWidth;
    const marginCols = Math.min(
      this.props.model && this.props.model.horizontalScrollMargin != null
        ? this.props.model.horizontalScrollMargin
        : DEFAULT_HORIZONTAL_SCROLL_MARGIN,
      Math.max(0, Math.floor((viewW / cw - 1) / 2))
    );
    const margin = marginCols * cw;

    if (!options || options.reversed !== false) {
      if (endPx + margin > this._scroller.scrollLeft + viewW) {
        this._scroller.scrollLeft = endPx + margin - viewW;
      }
      if (startPx - margin < this._scroller.scrollLeft) {
        this._scroller.scrollLeft = Math.max(0, startPx - margin);
      }
    } else {
      if (startPx - margin < this._scroller.scrollLeft) {
        this._scroller.scrollLeft = Math.max(0, startPx - margin);
      }
      if (endPx + margin > this._scroller.scrollLeft + viewW) {
        this._scroller.scrollLeft = endPx + margin - viewW;
      }
    }
  }

  addBlockDecoration(_decoration) {}
  invalidateBlockDecorationDimensions() {}

  // --- Position / measurement queries -----------------------------------

  pixelPositionForScreenPosition(screenPosition) {
    if (!screenPosition) return { top: 0, left: 0 };
    return {
      top: (screenPosition.row || 0) * this._lineHeight,
      left: (screenPosition.column || 0) * this._charWidth
    };
  }

  screenPositionForPixelPosition({ top, left }) {
    const lh = this._lineHeight;
    const cw = this._charWidth;
    if (!lh) return this.props.model.clipScreenPosition([0, 0]);
    const row = Math.max(0, Math.floor(top / lh));
    const col = Math.max(0, Math.round(left / (cw || 1)));
    return this.props.model.clipScreenPosition([row, col]);
  }

  pixelRangeForScreenRange(range) {
    return {
      start: this.pixelPositionForScreenPosition(range && range.start),
      end: this.pixelPositionForScreenPosition(range && range.end)
    };
  }

  renderedScreenLineForRow(_row) { return null; }
  measureDimensions() {}

  // --- Dimensions -------------------------------------------------------

  getLineHeight() { return this._lineHeight || 0; }
  getBaseCharacterWidth() { return this._charWidth || 0; }

  getContentHeight() {
    return this.props.model.getScreenLineCount() * (this._lineHeight || 0);
  }

  getContentWidth() {
    return (
      (this.props.model.getMaxScreenLineLength
        ? this.props.model.getMaxScreenLineLength()
        : 0) * (this._charWidth || 0)
    );
  }

  getClientContainerHeight() {
    return this._scroller ? this._scroller.clientHeight : (this.element ? this.element.clientHeight : 0);
  }

  getClientContainerWidth() {
    return this._scroller ? this._scroller.clientWidth : (this.element ? this.element.clientWidth : 0);
  }

  getScrollContainerHeight() { return this.getClientContainerHeight(); }
  getScrollContainerWidth() { return this.getClientContainerWidth(); }
  getScrollContainerClientHeight() { return this.getClientContainerHeight(); }

  getVerticalScrollbarWidth() { return 0; }
  getHorizontalScrollbarHeight() { return 0; }
  getGutterContainerWidth() { return 0; }

  // --- Scroll -----------------------------------------------------------

  getScrollTop() { return this._scroller ? this._scroller.scrollTop : this.scrollTop; }
  setScrollTop(top) {
    const v = Math.max(0, top || 0);
    this.scrollTop = v;
    if (this._scroller) this._scroller.scrollTop = v;
    return v;
  }

  getScrollLeft() { return this._scroller ? this._scroller.scrollLeft : this.scrollLeft; }
  setScrollLeft(left) {
    const v = Math.max(0, left || 0);
    this.scrollLeft = v;
    if (this._scroller) this._scroller.scrollLeft = v;
    return v;
  }

  getScrollBottom() { return this.getScrollTop() + this.getClientContainerHeight(); }
  setScrollBottom(bottom) { return this.setScrollTop(bottom - this.getClientContainerHeight()); }

  getScrollRight() { return this.getScrollLeft() + this.getClientContainerWidth(); }
  setScrollRight(right) { return this.setScrollLeft(right - this.getClientContainerWidth()); }

  getScrollHeight() { return this.getContentHeight(); }
  getScrollWidth() { return this.getContentWidth(); }

  getMaxScrollTop() {
    return Math.max(0, this.getScrollHeight() - this.getClientContainerHeight());
  }
  getMaxScrollLeft() {
    return Math.max(0, this.getScrollWidth() - this.getClientContainerWidth());
  }

  getScrollTopRow() {
    return this._lineHeight ? Math.floor(this.getScrollTop() / this._lineHeight) : 0;
  }
  setScrollTopRow(row) {
    if (this._lineHeight) this.setScrollTop(row * this._lineHeight);
  }
  getScrollLeftColumn() {
    return this._charWidth ? Math.floor(this.getScrollLeft() / this._charWidth) : 0;
  }
  setScrollLeftColumn(column) {
    if (this._charWidth) this.setScrollLeft(column * this._charWidth);
  }

  // --- Viewport ---------------------------------------------------------

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

  // --- Input ------------------------------------------------------------

  setInputEnabled(enabled) { this.inputEnabled = enabled !== false; }
  getHiddenInput() { return this.hiddenInput; }

  // --- Decoration / gutter queries -------------------------------------

  queryGuttersToRender() {
    return this.props.model ? [this.props.model.getLineNumberGutter()] : [];
  }

  queryDecorationsToRender() {}
}

PulsarTextEditorComponent.attachedComponents = null;

module.exports = PulsarTextEditorComponent;
