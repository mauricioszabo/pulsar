'use babel';

// New SolidJS-based TextEditorComponent — Commit B MVP.
//
// IMPORTANT: this file is loaded indirectly via `./index.js`, which
// runs `./solid-loader-shim` first. Do not require this file directly
// from outside the directory — `babel-preset-solid` hoists its
// runtime imports above any source-level `require()`, so without the
// shim being installed before this module is read, Solid's `web.cjs`
// loads and caches the SSR core before resolution can be patched.
// See ./index.js for the full rationale.
//
// Scope of this commit (per ADR 006, Commit B):
//   - Render every screen line of the model in source order, plain
//     monospace, no syntax highlighting yet.
//   - A simple cursor sits on top, positioned by row * lineHeight and
//     column * charWidth (both measured once on mount).
//   - The hidden input captures `input` events and forwards them to
//     `model.insertText`. Editing keys (Backspace, Enter, arrows,
//     etc.) flow through Atom's keymap → editor commands → model,
//     which fires `didChangeDisplayLayer` / `didChangeSelectionRange`
//     back into us; both bump Solid signals that drive re-render.
//   - No virtualization, no scrolling beyond browser default, no
//     gutters, no decorations, no mouse interaction. Those land in
//     subsequent commits.
//
// The legacy Etch implementation at src/text-editor-component.js
// remains the default and is not modified.
//
// Authoring notes:
// - JSX. The `'use babel'` header above triggers Pulsar's per-file
//   Babel pipeline; the `overrides` entry in src/babel.config.js
//   applies `babel-preset-solid` (with `moduleName` pointed at the
//   client `web.cjs`) to anything under `src/pulsar-text-editor/`.

const { render, For } = require('solid-js/web');
const { createSignal, createMemo, onCleanup, onMount } = require('solid-js');

let TextEditor = null;
let TextEditorElement = null;

// --- Solid components ---------------------------------------------------

function Line(props) {
  // NBSP gives empty lines a height so the cursor is visible on them.
  return (
    <div class="line" data-screen-row={props.row}>
      {props.lineText && props.lineText.length > 0 ? props.lineText : ' '}
    </div>
  );
}

function Cursor(props) {
  // `props.position`, `props.lineHeight`, `props.charWidth` are
  // accessor functions — read them inside the style accessor so Solid
  // re-runs the binding when any of them change.
  const style = () => {
    const lh = props.lineHeight();
    const cw = props.charWidth();
    if (!lh) return 'display: none';
    const pos = props.position();
    if (!pos) return 'display: none';
    return [
      'position: absolute',
      'left: ' + (pos.column * cw) + 'px',
      'top: ' + (pos.row * lh) + 'px',
      'width: 2px',
      'height: ' + lh + 'px',
      // Explicit color (rather than `currentColor`) so the cursor is
      // visible even when our minimal DOM doesn't pick up a theme's
      // `color` cascade. Will be replaced by themeable styling later.
      'background: #fff',
      'box-shadow: 0 0 0 1px #000',
      'pointer-events: none',
      'z-index: 2'
    ].join('; ') + ';';
  };
  return <div class="cursor" style={style()} />;
}

function Editor(props) {
  const model = props.model;
  const component = props.component;

  // --- reactive sources ---

  // Bumped by didChangeDisplayLayer / didResetDisplayLayer.
  const [displayVersion, bumpDisplayVersion] = createSignal(0);
  component._notifyDisplayChange = () =>
    bumpDisplayVersion(v => v + 1);

  // Bumped by didChangeSelectionRange / didUpdateSelections.
  const [cursorPos, setCursorPos] = createSignal(
    model.getCursorScreenPosition()
  );
  component._notifySelectionChange = () =>
    setCursorPos(model.getCursorScreenPosition());

  // Measurements (filled in onMount).
  const [lineHeight, setLineHeight] = createSignal(0);
  const [charWidth, setCharWidth] = createSignal(0);

  // --- derived data ---

  const screenLines = createMemo(() => {
    displayVersion(); // dependency
    const count = model.getScreenLineCount();
    const arr = new Array(count);
    for (let i = 0; i < count; i++) {
      arr[i] = model.screenLineForScreenRow(i);
    }
    return arr;
  });

  // --- mount ---

  let measureRef;
  const measure = () => {
    if (!measureRef) return false;
    const sample = measureRef.querySelector('.measurement-sample');
    if (!sample) return false;
    const rect = sample.getBoundingClientRect();
    // `sample` contains exactly one 'x' character. Its rendered width
    // is the base char width; its height is the line height.
    if (!rect.width || !rect.height) return false;
    setCharWidth(rect.width);
    setLineHeight(rect.height);
    component._lineHeight = rect.height;
    component._charWidth = rect.width;
    // eslint-disable-next-line no-console
    console.info(
      '[pulsar-text-editor] measured lineHeight=' + rect.height +
      ' charWidth=' + rect.width
    );
    return true;
  };
  onMount(() => {
    // First attempt: synchronous after mount. If fonts haven't fully
    // loaded yet, the rect may be 0 — retry on `document.fonts.ready`
    // and on the next frame as a fallback.
    if (measure()) return;
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(measure);
    }
    requestAnimationFrame(() => {
      if (component._lineHeight) return;
      measure();
    });
  });

  // --- render ---

  return (
    <div
      class="pulsar-editor-root"
      style="position: relative; font-family: monospace; white-space: pre; overflow: auto; height: 100%; box-sizing: border-box;"
    >
      <div
        ref={el => (measureRef = el)}
        class="measurements"
        aria-hidden="true"
        style="position: absolute; left: -9999px; top: 0; visibility: hidden; pointer-events: none;"
      >
        <span class="measurement-sample">x</span>
      </div>
      <div class="lines" style="position: relative;">
        <For each={screenLines()}>
          {(line, i) => (
            <Line lineText={line && line.lineText} row={i()} />
          )}
        </For>
        <Cursor
          position={cursorPos}
          lineHeight={lineHeight}
          charWidth={charWidth}
        />
      </div>
    </div>
  );
}

// --- Component class ----------------------------------------------------

class PulsarTextEditorComponent {
  // --- Static API -------------------------------------------------------

  // Deprecated no-ops kept for ABI compatibility. Solid has no central
  // scheduler; batching happens via Solid's `batch()` invoked from
  // ViewRegistry's `updateDocument()` in a later commit.
  static setScheduler(_scheduler) {}
  static getScheduler() { return null; }

  static didUpdateStyles() {
    if (this.attachedComponents) {
      this.attachedComponents.forEach(c => c.didUpdateStyles());
    }
  }

  static didUpdateScrollbarStyles() {
    if (this.attachedComponents) {
      this.attachedComponents.forEach(c => c.didUpdateScrollbarStyles());
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

    // Cached on mount by the Editor Solid component, used by
    // `getLineHeight`/`getBaseCharacterWidth` and friends.
    this._lineHeight = 0;
    this._charWidth = 0;

    // Set by the Editor Solid component to bump the relevant signals.
    this._notifyDisplayChange = null;
    this._notifySelectionChange = null;

    // `<atom-text-editor>` may be created with prior children (e.g. an
    // `initialText` text node from `textContent`). Clear them so the
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
      'padding: 0; border: 0; pointer-events: none;';
    this.hiddenInput.addEventListener('input', this._onHiddenInputInput.bind(this));
    this.hiddenInput.addEventListener('focus', this._onHiddenInputFocus.bind(this));
    this.hiddenInput.addEventListener('blur', this._onHiddenInputBlur.bind(this));
    this.element.appendChild(this.hiddenInput);

    // Solid mount target. The Editor renders into this div.
    this.solidHost = document.createElement('div');
    this.solidHost.classList.add('pulsar-text-editor-solid-host');
    this.solidHost.style.cssText = 'display: block; width: 100%; height: 100%;';
    this.element.appendChild(this.solidHost);

    this.disposeRender = render(
      () => <Editor model={this.props.model} component={this} />,
      this.solidHost
    );

    // Focus management is delicate here. Atom's `<atom-pane>` has a
    // capture-phase focus listener that calls `paneModel.focus()` →
    // `activate()` → emits `did-activate`, and `PaneElement.activated()`
    // conditionally focuses the pane element itself. There are several
    // emit-subscribed paths that can end up calling `paneElement.focus()`
    // synchronously *during* the focus event for our hidden input, with
    // the net effect that focus is yanked out from under us and lands on
    // `<atom-pane>`. The legacy Etch editor renders a deeper DOM that
    // happens to side-step this, but the simplest reliable fix here is:
    //
    //   1. On mousedown (capture), focus the hidden input.
    //   2. Defensively refocus on the next microtask, the next animation
    //      frame, and a 0ms timeout — covering whichever async tier the
    //      stealing path runs in.
    //   3. Trap any `focusin` that lands on something inside the editor
    //      that *isn't* the hidden input and snap focus back.
    //
    // `preventDefault` on mousedown stops the browser's own click-focus
    // resolution from competing with us.
    this._refocusHiddenInput = () => {
      if (this.attached && document.activeElement !== this.hiddenInput) {
        this.hiddenInput.focus();
      }
    };
    this.element.addEventListener('mousedown', event => {
      if (event.target === this.hiddenInput) return;
      event.preventDefault();
      this.hiddenInput.focus();
      Promise.resolve().then(this._refocusHiddenInput);
      requestAnimationFrame(this._refocusHiddenInput);
      setTimeout(this._refocusHiddenInput, 0);
    }, true);
    // `focusin` bubbles. If focus lands on our editor element itself
    // (e.g., after `view.focus()` is called from `<atom-pane>`'s focus
    // forwarding), redirect to the hidden input.
    this.element.addEventListener('focusin', event => {
      if (
        event.target === this.element &&
        document.activeElement !== this.hiddenInput
      ) {
        this.hiddenInput.focus();
      }
    });

    this.nextUpdatePromise = null;
    this.resolveNextUpdatePromise = null;

    // Diagnostic — visible in DevTools so we can confirm the swap
    // fires and the Solid mount succeeded. Remove once stable.
    // eslint-disable-next-line no-console
    console.info(
      '[pulsar-text-editor] mounted on',
      this.element,
      '(model:', this.props.model && this.props.model.id, ')'
    );
  }

  // --- Hidden input handlers --------------------------------------------

  _onHiddenInputInput(event) {
    // eslint-disable-next-line no-console
    console.info(
      '[pulsar-text-editor] input event data=', JSON.stringify(event.data),
      'inputType=', event.inputType
    );
    if (!this.inputEnabled) return;
    // event.data is the inserted text for `insertText`,
    // `insertFromPaste`, `insertCompositionText`, etc. Null for
    // deletion-type inputs (which we don't expect here — Backspace
    // is consumed by atom.keymaps before it reaches us).
    const text = event.data;
    if (text != null && text.length > 0) {
      this.props.model.insertText(text);
    }
    // Clear so we never accumulate state in the input element.
    this.hiddenInput.value = '';
  }

  _onHiddenInputFocus() {
    // eslint-disable-next-line no-console
    console.info('[pulsar-text-editor] hidden input focus');
    if (!this.focused) {
      this.focused = true;
      this.element.classList.add('is-focused');
    }
  }

  _onHiddenInputBlur(event) {
    // eslint-disable-next-line no-console
    console.info(
      '[pulsar-text-editor] hidden input blur, relatedTarget=',
      event && event.relatedTarget,
      'activeElement=', document.activeElement
    );
    if (this.focused) {
      this.focused = false;
      this.element.classList.remove('is-focused');
    }
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
      this.nextUpdatePromise = new Promise(resolve => {
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
    if (this.disposeRender) {
      this.disposeRender();
      this.disposeRender = null;
    }
  }

  didShow() { this.visible = true; }
  didHide() { this.visible = false; }

  didFocus() {
    // Forward focus to the hidden input so keystrokes have a target.
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
    // The cursor sits on top of the lines; a display change can move it.
    if (this._notifySelectionChange) this._notifySelectionChange();
  }

  didResetDisplayLayer() {
    if (this._notifyDisplayChange) this._notifyDisplayChange();
    if (this._notifySelectionChange) this._notifySelectionChange();
  }

  didChangeSelectionRange() {
    if (this._notifySelectionChange) this._notifySelectionChange();
  }

  didUpdateSelections() {
    if (this._notifySelectionChange) this._notifySelectionChange();
  }

  didRequestAutoscroll(_scrollEvent) {}

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

  screenPositionForPixelPosition(_pixelPosition) {
    return this.props.model.clipScreenPosition({ row: 0, column: 0 });
  }

  pixelRangeForScreenRange(range) {
    return {
      start: this.pixelPositionForScreenPosition(range && range.start),
      end: this.pixelPositionForScreenPosition(range && range.end)
    };
  }

  renderedScreenLineForRow(_row) { return null; }

  measureDimensions() {
    // Measurements are taken in the Editor component's `onMount`.
    // This is a no-op now; if a caller needs a refresh, future
    // commits can re-run the measurement here.
  }

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

  getScrollTop() { return this.scrollTop; }
  setScrollTop(top) {
    this.scrollTop = Math.max(0, top || 0);
    return this.scrollTop;
  }

  getScrollLeft() { return this.scrollLeft; }
  setScrollLeft(left) {
    this.scrollLeft = Math.max(0, left || 0);
    return this.scrollLeft;
  }

  getScrollBottom() { return this.scrollTop; }
  setScrollBottom(_bottom) { return this.scrollTop; }
  getScrollRight() { return this.scrollLeft; }
  setScrollRight(_right) { return this.scrollLeft; }

  getScrollHeight() { return this.getContentHeight(); }
  getScrollWidth() { return this.getContentWidth(); }
  getMaxScrollTop() {
    return Math.max(0, this.getScrollHeight() - this.getClientContainerHeight());
  }
  getMaxScrollLeft() {
    return Math.max(0, this.getScrollWidth() - this.getClientContainerWidth());
  }

  getScrollTopRow() {
    return this._lineHeight ? Math.floor(this.scrollTop / this._lineHeight) : 0;
  }
  setScrollTopRow(row) {
    if (this._lineHeight) this.setScrollTop(row * this._lineHeight);
  }
  getScrollLeftColumn() {
    return this._charWidth ? Math.floor(this.scrollLeft / this._charWidth) : 0;
  }
  setScrollLeftColumn(column) {
    if (this._charWidth) this.setScrollLeft(column * this._charWidth);
  }

  // --- Viewport ---------------------------------------------------------

  // We don't virtualize yet, so the rendered range is the entire buffer.
  getFirstVisibleRow() { return this.getScrollTopRow(); }
  getLastVisibleRow() {
    const lh = this._lineHeight;
    if (!lh) return 0;
    return Math.min(
      this.props.model.getScreenLineCount() - 1,
      Math.floor((this.scrollTop + this.getClientContainerHeight()) / lh)
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
