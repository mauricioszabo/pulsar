'use babel';

// New SolidJS-based TextEditorComponent — Commit C.
//
// IMPORTANT: this file is loaded indirectly via `./index.js`, which
// runs `./solid-loader-shim` first. Do not require this file directly
// from outside the directory — `babel-preset-solid` hoists its
// runtime imports above any source-level `require()`, so without the
// shim being installed before this module is read, Solid's `web.cjs`
// loads and caches the SSR core before resolution can be patched.
// See ./index.js for the full rationale.
//
// Scope of this commit:
//   - Lines are absolute-positioned at `row * lineHeight`, eliminating
//     the subpixel-accumulation drift that the inline flow layout in
//     Commit B suffered from. Cursors are likewise placed at
//     `col * charWidth, row * lineHeight`. Both lines and cursors share
//     the same coordinate system inside the `.lines` container, so they
//     stay aligned regardless of how subtly the rendered char width
//     differs from our measurement.
//   - Syntax highlighting via `walkScreenLineTags` from
//     `../screen-line-tag-walker` — the same walker the legacy editor
//     uses. Output is built as an HTML string and assigned via Solid's
//     `innerHTML` prop; the line is treated as opaque DOM, which is
//     dramatically faster than nesting Solid components per scope.
//   - Blinking cursor: an interval flips a class on `.cursors`, which
//     is faded out via the existing `.cursors.blink-off .cursor` CSS
//     rule. Blinking pauses for ~300ms after every selection change so
//     the cursor stays solidly visible while the user is moving it.
//   - Mouse: clicking maps `clientX/Y` to a screen position via the
//     measured `lineHeight` / `charWidth` plus `caretRangeFromPoint`
//     for fine column accuracy, and drives `model.setCursorScreenPosition`.
//     Mousedown + drag extends the selection.
//   - Autoscroll: `didRequestAutoscroll` (called by the model whenever
//     a cursor moves with `autoscroll: true` — the default) computes a
//     desired scroll rectangle from the screen range and adjusts
//     `scrollTop` / `scrollLeft` so the cursor stays in view.
//   - Focus: `element.focus()` is overridden to redirect to the hidden
//     input. This catches every path that brings focus to the editor —
//     `pane.activated()` calling `paneElement.focus()` then forwarding
//     to `view.focus()`, `pane.activeItemChanged()` calling
//     `itemView.focus()` after a tab switch, `atom.workspace.open()`
//     callers calling `editor.element.focus()`, etc. — without each one
//     having to be wired separately.
//
// Out of scope (still): gutters, line numbers, decorations, code
// folding, soft wrap, virtualization for very long lines.

const { render, For } = require('solid-js/web');
const {
  createSignal,
  createMemo,
  onCleanup,
  onMount
} = require('solid-js');

const { walkScreenLineTags } = require('../screen-line-tag-walker');

let TextEditor = null;
let TextEditorElement = null;

const CURSOR_BLINK_PERIOD = 800;
const CURSOR_BLINK_RESUME_DELAY = 300;
// Keep at least this many lines of context above/below the cursor when
// autoscrolling — matches the legacy editor's default `verticalScrollMargin`.
const DEFAULT_VERTICAL_SCROLL_MARGIN = 2;
const DEFAULT_HORIZONTAL_SCROLL_MARGIN = 6;

// --- Helpers ------------------------------------------------------------

function escapeHtml(s) {
  // We only ever pass user-line text (and class names) through here, so
  // a minimal escape table is sufficient. `"` doesn't need escaping
  // inside an element body, but we escape it anyway because className
  // strings are also fed through this routine when building attributes.
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Walk a screen line's tag stream and return the inner HTML for the
// `.line` div. Mirrors `LineComponent.appendContents` in the legacy
// component but emits a string instead of touching the DOM directly,
// which lets us hand the result to Solid's `innerHTML` prop.
function buildLineHtml(screenLine, displayLayer) {
  if (!screenLine || !screenLine.tags) {
    const text = (screenLine && screenLine.lineText) || '';
    return text.length > 0 ? escapeHtml(text) : '&nbsp;';
  }
  let html = '';
  let emittedAnyText = false;
  walkScreenLineTags({
    tags: screenLine.tags,
    lineText: screenLine.lineText,
    displayLayer,
    onOpenScope: (className) => {
      html += '<span class="' + escapeHtml(className) + '">';
    },
    onCloseScope: () => {
      html += '</span>';
    },
    onTextRun: (text) => {
      if (text.length > 0) emittedAnyText = true;
      html += escapeHtml(text);
    }
  });
  if (!emittedAnyText) html += '&nbsp;';
  return html;
}

// --- Solid components ---------------------------------------------------

function Line(props) {
  // `props.screenLine` is fresh each render (the model rebuilds the
  // array of screen lines on every display change), so this memo
  // recomputes per render too — that's fine, the walker is cheap.
  const html = createMemo(() =>
    buildLineHtml(props.screenLine, props.displayLayer)
  );
  return (
    <div
      class="line"
      data-screen-row={props.row}
      style={
        'position: absolute; left: 0; right: 0; ' +
        'top: ' + (props.row * props.lineHeight) + 'px; ' +
        'height: ' + props.lineHeight + 'px;'
      }
      // eslint-disable-next-line solid/no-innerhtml
      innerHTML={html()}
    />
  );
}

function Cursor(props) {
  // `props.position` is an accessor; reading it inside the inline style
  // builder makes Solid re-evaluate when the position changes.
  const style = () => {
    const lh = props.lineHeight();
    const cw = props.charWidth();
    if (!lh) return 'display: none;';
    const pos = props.position;
    if (!pos) return 'display: none;';
    return (
      'position: absolute; ' +
      'left: ' + (pos.column * cw) + 'px; ' +
      'top: ' + (pos.row * lh) + 'px; ' +
      'width: ' + Math.max(1, Math.round(cw)) + 'px; ' +
      'height: ' + lh + 'px; ' +
      'pointer-events: none;'
    );
  };
  return <div class="cursor" style={style()} />;
}

function Selection(props) {
  // Render a selection range as up to three rectangles: a partial top
  // line, a full middle block, and a partial bottom line. Matches what
  // CodeMirror / the legacy editor draw.
  const rects = createMemo(() => {
    const range = props.range;
    if (!range || range.isEmpty()) return [];
    const lh = props.lineHeight();
    const cw = props.charWidth();
    if (!lh || !cw) return [];
    const startRow = range.start.row;
    const endRow = range.end.row;
    const startCol = range.start.column;
    const endCol = range.end.column;
    const out = [];
    if (startRow === endRow) {
      out.push({
        top: startRow * lh,
        left: startCol * cw,
        width: Math.max(0, (endCol - startCol) * cw),
        height: lh
      });
    } else {
      // Top line: from startCol to end of line. We don't know the line's
      // length in pixels here without a measurement; extend to the right
      // edge of the content area instead, which is what users expect.
      out.push({
        top: startRow * lh,
        left: startCol * cw,
        right: 0,
        height: lh
      });
      if (endRow > startRow + 1) {
        out.push({
          top: (startRow + 1) * lh,
          left: 0,
          right: 0,
          height: (endRow - startRow - 1) * lh
        });
      }
      out.push({
        top: endRow * lh,
        left: 0,
        width: endCol * cw,
        height: lh
      });
    }
    return out;
  });
  return (
    <For each={rects()}>
      {(r) => (
        <div
          class="selection"
          style={
            'position: absolute; ' +
            'top: ' + r.top + 'px; ' +
            'left: ' + r.left + 'px; ' +
            (r.right != null ? 'right: ' + r.right + 'px; ' : '') +
            (r.width != null ? 'width: ' + r.width + 'px; ' : '') +
            'height: ' + r.height + 'px; ' +
            'pointer-events: none;'
          }
        />
      )}
    </For>
  );
}

function Editor(props) {
  const model = props.model;
  const component = props.component;
  const displayLayer = model.displayLayer;

  // --- reactive sources ---

  const [displayVersion, bumpDisplayVersion] = createSignal(0);
  component._notifyDisplayChange = () => bumpDisplayVersion((v) => v + 1);

  const [selectionsVersion, bumpSelectionsVersion] = createSignal(0);
  component._notifySelectionChange = () =>
    bumpSelectionsVersion((v) => v + 1);

  const [scrollTop, setScrollTop] = createSignal(0);
  const [scrollLeft, setScrollLeft] = createSignal(0);
  component._setScrollTopSignal = setScrollTop;
  component._setScrollLeftSignal = setScrollLeft;

  const [lineHeight, setLineHeight] = createSignal(0);
  const [charWidth, setCharWidth] = createSignal(0);

  const [blinkOff, setBlinkOff] = createSignal(false);
  component._pauseBlinkAndShow = () => {
    setBlinkOff(false);
    component._restartBlinkInterval();
  };

  // --- derived data ---

  const screenLines = createMemo(() => {
    displayVersion();
    const count = model.getScreenLineCount();
    const arr = new Array(count);
    for (let i = 0; i < count; i++) {
      arr[i] = model.screenLineForScreenRow(i);
    }
    return arr;
  });

  const cursorPositions = createMemo(() => {
    selectionsVersion();
    const cursors = model.getCursors();
    return cursors.map((c) => c.getScreenPosition());
  });

  const selectionRanges = createMemo(() => {
    selectionsVersion();
    const selections = model.getSelections();
    return selections.map((s) => s.getScreenRange());
  });

  // --- mount / measure ---

  let measureRef;
  let scrollerRef;
  let linesRef;

  const measure = () => {
    if (!measureRef) return false;
    const sample = measureRef.querySelector('.measurement-sample');
    if (!sample) return false;
    const rect = sample.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    // The sample contains exactly 100 'x's so we average across them and
    // avoid the per-character subpixel rounding error that made the
    // single-character measurement drift visibly at column ~40+.
    const cw = rect.width / 100;
    const lh = rect.height;
    setCharWidth(cw);
    setLineHeight(lh);
    component._lineHeight = lh;
    component._charWidth = cw;
    return true;
  };

  onMount(() => {
    component._scroller = scrollerRef;
    component._linesEl = linesRef;
    if (!measure()) {
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(measure);
      }
      requestAnimationFrame(() => {
        if (!component._lineHeight) measure();
      });
    }
    // Wire the scroll container's scroll position back into our signals
    // so cursor / selection coordinates and the future virtualization
    // stay in sync with the actual viewport.
    const onScroll = () => {
      setScrollTop(scrollerRef.scrollTop);
      setScrollLeft(scrollerRef.scrollLeft);
      component.scrollTop = scrollerRef.scrollTop;
      component.scrollLeft = scrollerRef.scrollLeft;
    };
    scrollerRef.addEventListener('scroll', onScroll, { passive: true });
    onCleanup(() => scrollerRef.removeEventListener('scroll', onScroll));
  });

  // --- blinking ---

  let blinkInterval = null;
  let resumeTimeout = null;
  const restartBlinkInterval = () => {
    if (blinkInterval) clearInterval(blinkInterval);
    if (resumeTimeout) clearTimeout(resumeTimeout);
    setBlinkOff(false);
    // Pause briefly then start the periodic toggle, so the cursor stays
    // solid right after a selection change and the user can see where it
    // landed.
    resumeTimeout = setTimeout(() => {
      blinkInterval = setInterval(() => {
        if (!component.focused || !component.attached) return;
        setBlinkOff((v) => !v);
      }, CURSOR_BLINK_PERIOD / 2);
    }, CURSOR_BLINK_RESUME_DELAY);
  };
  component._restartBlinkInterval = restartBlinkInterval;
  onMount(() => restartBlinkInterval());
  onCleanup(() => {
    if (blinkInterval) clearInterval(blinkInterval);
    if (resumeTimeout) clearTimeout(resumeTimeout);
  });

  // --- content size ---

  const contentHeight = createMemo(
    () => screenLines().length * (lineHeight() || 0)
  );
  const contentWidth = createMemo(() => {
    // Approximate the content width from the model's longest line; we'll
    // refine this later by measuring rendered widths.
    const cw = charWidth();
    if (!cw) return 0;
    const longest = model.getMaxScreenLineLength
      ? model.getMaxScreenLineLength()
      : 0;
    return Math.max(longest * cw, 0);
  });

  // --- render ---

  return (
    <div
      class="pulsar-editor-root"
      style={
        'position: relative; width: 100%; height: 100%; ' +
        'overflow: hidden; box-sizing: border-box; ' +
        'font-family: monospace; white-space: pre;'
      }
    >
      <div
        ref={(el) => (measureRef = el)}
        class="measurements"
        aria-hidden="true"
        style={
          'position: absolute; left: -9999px; top: 0; ' +
          'visibility: hidden; pointer-events: none; white-space: pre;'
        }
      >
        <span class="measurement-sample">{'x'.repeat(100)}</span>
      </div>
      <div
        ref={(el) => (scrollerRef = el)}
        class="scroll-view"
        style={
          'position: absolute; inset: 0; overflow: auto; ' +
          'will-change: scroll-position;'
        }
      >
        <div
          ref={(el) => (linesRef = el)}
          class="lines"
          style={
            'position: relative; ' +
            'width: ' + Math.max(contentWidth(), 1) + 'px; ' +
            'height: ' + Math.max(contentHeight(), 1) + 'px;'
          }
        >
          <For each={screenLines()}>
            {(line, i) => (
              <Line
                screenLine={line}
                displayLayer={displayLayer}
                row={i()}
                lineHeight={lineHeight()}
              />
            )}
          </For>
          <div
            class={'selections' + (blinkOff() ? ' blink-off' : '')}
            style="position: absolute; inset: 0; pointer-events: none;"
          >
            <For each={selectionRanges()}>
              {(range) => (
                <Selection
                  range={range}
                  lineHeight={lineHeight}
                  charWidth={charWidth}
                />
              )}
            </For>
          </div>
          <div
            class={'cursors' + (blinkOff() ? ' blink-off' : '')}
            style="position: absolute; inset: 0; pointer-events: none;"
          >
            <For each={cursorPositions()}>
              {(pos) => (
                <Cursor
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
  );
}

// --- Component class ----------------------------------------------------

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
      if (!TextEditorElement) {
        TextEditorElement = require('../text-editor-element');
      }
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

    // Set by the Editor Solid component.
    this._notifyDisplayChange = null;
    this._notifySelectionChange = null;
    this._setScrollTopSignal = null;
    this._setScrollLeftSignal = null;
    this._pauseBlinkAndShow = null;
    this._restartBlinkInterval = null;
    this._scroller = null;
    this._linesEl = null;
    this._activeItemSub = null;

    // `<atom-text-editor>` may carry pre-existing children (e.g. the
    // `initialText` text node from `textContent`); clear them so the
    // Solid root has a clean container.
    while (this.element.firstChild) {
      this.element.removeChild(this.element.firstChild);
    }

    // Hidden input — captures keystrokes that produce text. Editing
    // commands (backspace, enter, arrows, …) bypass this and flow
    // through atom.keymaps → editor commands → model.
    this.hiddenInput = document.createElement('input');
    this.hiddenInput.classList.add('hidden-input');
    this.hiddenInput.setAttribute('tabindex', '-1');
    this.hiddenInput.style.cssText =
      'position: absolute; width: 1px; height: 1px; opacity: 0; ' +
      'padding: 0; border: 0; pointer-events: none; z-index: 5;';
    this.hiddenInput.addEventListener(
      'input',
      this._onHiddenInputInput.bind(this)
    );
    this.hiddenInput.addEventListener(
      'focus',
      this._onHiddenInputFocus.bind(this)
    );
    this.hiddenInput.addEventListener(
      'blur',
      this._onHiddenInputBlur.bind(this)
    );
    this.element.appendChild(this.hiddenInput);

    // Solid mount target.
    this.solidHost = document.createElement('div');
    this.solidHost.classList.add('pulsar-text-editor-solid-host');
    this.solidHost.style.cssText =
      'display: block; width: 100%; height: 100%;';
    this.element.appendChild(this.solidHost);

    this.disposeRender = render(
      () => <Editor model={this.props.model} component={this} />,
      this.solidHost
    );

    // Focus interception. Override the host element's `focus()` so any
    // upstream caller that focuses the editor (pane activation, tab
    // switch, workspace.open, etc.) ends up at the hidden input. This
    // is much more robust than chasing every individual focus path.
    const originalElementFocus = this.element.focus.bind(this.element);
    this.element.focus = (options) => {
      if (this.hiddenInput) {
        this.hiddenInput.focus(options);
      } else {
        originalElementFocus(options);
      }
    };

    // Mouse: clicks (or click+drag) inside the lines area position the
    // cursor and start a selection. Clicks elsewhere in the editor
    // shell still focus the input but don't move the cursor.
    this.element.addEventListener(
      'mousedown',
      this._onMouseDown.bind(this),
      true
    );

    // When the workspace's active pane item becomes our editor — e.g.
    // because the user clicked our tab — focus the hidden input. This
    // covers the case where `pane.activateItem()` runs without the
    // pane already having focus, which would otherwise leave the new
    // editor visible but not receiving keystrokes.
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
      if (this._restartBlinkInterval) this._restartBlinkInterval();
    }
  }

  _onHiddenInputBlur(event) {
    // If focus is moving to something inside our element (e.g. a child
    // overlay we render later), don't treat it as a real blur.
    if (
      event.relatedTarget &&
      this.element.contains(event.relatedTarget)
    ) {
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
    // Always grab focus on any click in the editor — even if it's on
    // chrome that doesn't move the cursor.
    if (document.activeElement !== this.hiddenInput) {
      this.hiddenInput.focus({ preventScroll: true });
    }
    if (!this._linesEl || !this._lineHeight) return;
    const linesRect = this._linesEl.getBoundingClientRect();
    // Only treat clicks inside the lines area as cursor-positioning
    // gestures. Clicks on (future) gutters / scrollbars fall through.
    if (
      event.clientX < linesRect.left ||
      event.clientY < linesRect.top ||
      event.clientX > linesRect.right ||
      event.clientY > linesRect.bottom
    ) {
      return;
    }

    event.preventDefault();
    const screenPosition = this._screenPositionForMouseEvent(event);
    const model = this.props.model;
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

    // Track drag for selection extension.
    let dragging = false;
    const onMove = (moveEvent) => {
      dragging = true;
      const pos = this._screenPositionForMouseEvent(moveEvent);
      model.selectToScreenPosition(pos, {
        suppressSelectionMerge: true,
        autoscroll: false
      });
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

  _screenPositionForMouseEvent(event) {
    const linesRect = this._linesEl.getBoundingClientRect();
    const lh = this._lineHeight;
    const cw = this._charWidth;
    const y = event.clientY - linesRect.top;
    const x = event.clientX - linesRect.left;
    const row = Math.max(0, Math.floor(y / lh));
    const lineCount = this.props.model.getScreenLineCount();
    const clampedRow = Math.min(row, lineCount - 1);
    // Round to nearest column (so clicking just past mid-character lands
    // after the character, like a normal text editor).
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

  // --- Model-driven callbacks (called from text-editor.js) --------------

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
    if (this._pauseBlinkAndShow) this._pauseBlinkAndShow();
  }

  didUpdateSelections() {
    if (this._notifySelectionChange) this._notifySelectionChange();
    if (this._pauseBlinkAndShow) this._pauseBlinkAndShow();
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
    const startTop = screenRange.start.row * lh;
    const endBottom = (screenRange.end.row + 1) * lh;
    const viewportHeight = this._scroller.clientHeight;
    const margin = this._verticalAutoscrollMargin() * lh;

    let desiredTop = startTop - margin;
    let desiredBottom = endBottom + margin;

    if (options && options.center) {
      const desiredCenter = (startTop + endBottom) / 2;
      desiredTop = desiredCenter - viewportHeight / 2;
      desiredBottom = desiredCenter + viewportHeight / 2;
    }

    if (desiredBottom > this._scroller.scrollTop + viewportHeight) {
      this._scroller.scrollTop = desiredBottom - viewportHeight;
    }
    if (desiredTop < this._scroller.scrollTop) {
      this._scroller.scrollTop = Math.max(0, desiredTop);
    }
  }

  _autoscrollHorizontally(screenRange, options) {
    const cw = this._charWidth;
    if (!cw) return;
    const startLeft = screenRange.start.column * cw;
    const endRight = screenRange.end.column * cw;
    const viewportWidth = this._scroller.clientWidth;
    const margin = this._horizontalAutoscrollMargin() * cw;

    let desiredLeft = Math.max(0, startLeft - margin);
    let desiredRight = endRight + margin;

    if (options && options.center) {
      const desiredCenter = (startLeft + endRight) / 2;
      desiredLeft = desiredCenter - viewportWidth / 2;
      desiredRight = desiredCenter + viewportWidth / 2;
    }

    if (desiredRight > this._scroller.scrollLeft + viewportWidth) {
      this._scroller.scrollLeft = desiredRight - viewportWidth;
    }
    if (desiredLeft < this._scroller.scrollLeft) {
      this._scroller.scrollLeft = Math.max(0, desiredLeft);
    }
  }

  _verticalAutoscrollMargin() {
    const m = this.props.model && this.props.model.verticalScrollMargin;
    return m != null ? m : DEFAULT_VERTICAL_SCROLL_MARGIN;
  }

  _horizontalAutoscrollMargin() {
    const m = this.props.model && this.props.model.horizontalScrollMargin;
    return m != null ? m : DEFAULT_HORIZONTAL_SCROLL_MARGIN;
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
    if (!this._lineHeight) return this.props.model.clipScreenPosition([0, 0]);
    const row = Math.max(0, Math.floor(top / this._lineHeight));
    const col = Math.max(0, Math.round(left / (this._charWidth || 1)));
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
    return this.props.model.getMaxScreenLineLength() * (this._charWidth || 0);
  }

  getClientContainerHeight() {
    return this.element ? this.element.clientHeight : 0;
  }
  getClientContainerWidth() {
    return this.element ? this.element.clientWidth : 0;
  }
  getScrollContainerHeight() { return this.getClientContainerHeight(); }
  getScrollContainerWidth() { return this.getClientContainerWidth(); }
  getScrollContainerClientHeight() { return this.getClientContainerHeight(); }

  getVerticalScrollbarWidth() { return 0; }
  getHorizontalScrollbarHeight() { return 0; }

  getGutterContainerWidth() { return 0; }

  // --- Scroll -----------------------------------------------------------

  getScrollTop() {
    return this._scroller ? this._scroller.scrollTop : this.scrollTop;
  }
  setScrollTop(top) {
    const v = Math.max(0, top || 0);
    this.scrollTop = v;
    if (this._scroller) this._scroller.scrollTop = v;
    return v;
  }

  getScrollLeft() {
    return this._scroller ? this._scroller.scrollLeft : this.scrollLeft;
  }
  setScrollLeft(left) {
    const v = Math.max(0, left || 0);
    this.scrollLeft = v;
    if (this._scroller) this._scroller.scrollLeft = v;
    return v;
  }

  getScrollBottom() {
    return this.getScrollTop() + this.getClientContainerHeight();
  }
  setScrollBottom(bottom) {
    return this.setScrollTop(bottom - this.getClientContainerHeight());
  }
  getScrollRight() {
    return this.getScrollLeft() + this.getClientContainerWidth();
  }
  setScrollRight(right) {
    return this.setScrollLeft(right - this.getClientContainerWidth());
  }

  getScrollHeight() { return this.getContentHeight(); }
  getScrollWidth() { return this.getContentWidth(); }
  getMaxScrollTop() {
    return Math.max(
      0,
      this.getScrollHeight() - this.getClientContainerHeight()
    );
  }
  getMaxScrollLeft() {
    return Math.max(
      0,
      this.getScrollWidth() - this.getClientContainerWidth()
    );
  }

  getScrollTopRow() {
    return this._lineHeight
      ? Math.floor(this.getScrollTop() / this._lineHeight)
      : 0;
  }
  setScrollTopRow(row) {
    if (this._lineHeight) this.setScrollTop(row * this._lineHeight);
  }
  getScrollLeftColumn() {
    return this._charWidth
      ? Math.floor(this.getScrollLeft() / this._charWidth)
      : 0;
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
  getRenderedEndRow() {
    return this.props.model.getScreenLineCount();
  }

  // --- Input ------------------------------------------------------------

  setInputEnabled(enabled) { this.inputEnabled = enabled !== false; }
  getHiddenInput() { return this.hiddenInput; }

  // --- Decoration / gutter queries -------------------------------------

  queryGuttersToRender() {
    return this.props.model
      ? [this.props.model.getLineNumberGutter()]
      : [];
  }

  queryDecorationsToRender() {}
}

PulsarTextEditorComponent.attachedComponents = null;

module.exports = PulsarTextEditorComponent;
