'use babel';

// New SolidJS-based TextEditorComponent (scaffold).
//
// This file is the entry point for the experimental text editor
// implementation gated behind the `core.useNewTextEditor` config flag.
// Right now most public methods are *stubs*: they return a reasonable
// default so external callers (text-editor.js, text-editor-element.js,
// downstream packages) do not crash when the flag is on. The legacy
// Etch implementation at src/text-editor-component.js remains the
// default and is not modified.
//
// See docs/decisions/006-replace-etch-text-editor-with-solidjs.md for
// the migration plan. Subsequent commits will replace the placeholder
// rendering below with real SolidJS components for lines, gutters,
// cursors, etc.
//
// Authoring notes:
// - This file uses JSX. The `'use babel'` header above triggers
//   Pulsar's per-file Babel pipeline (see src/babel.js); the
//   `overrides` entry in src/babel.config.js applies
//   `babel-preset-solid` to anything under `src/pulsar-text-editor/`,
//   so JSX becomes Solid template clones + reactive bindings at load
//   time. There is no separate build step.
// - We deliberately use ES imports here so Babel is also exercising
//   the import → require transform from babel-preset-atomic. If this
//   file evaluates without throwing, the preset stack is wired up.

// IMPORTANT: import from `solid-js/web/dist/web.cjs` directly, not from
// `solid-js/web`. Solid's package.json `exports` field maps the `node`
// condition to the SSR build (`server.cjs`), and Electron's renderer
// process reports as Node when `require()` runs — so the bare specifier
// gives us a server build that throws "Client-only API called on the
// server side" the moment we call `render`. The dist filename is part
// of Solid's published layout (1.9.x) and is stable across patch
// releases of that minor.
import { render } from 'solid-js/web/dist/web.cjs';
import { createSignal, onCleanup } from 'solid-js';

let TextEditor = null;
let TextEditorElement = null;

// --- Solid placeholder component ----------------------------------------

// Reactive ticker so we can visually confirm Solid signals and DOM
// bindings are alive: the number on screen should increment once per
// second. Removed once the real renderer lands.
function ScaffoldPlaceholder(props) {
  const [tick, setTick] = createSignal(0);
  const intervalId = setInterval(() => setTick(t => t + 1), 1000);
  onCleanup(() => clearInterval(intervalId));

  const containerStyle = [
    'display: block',
    'box-sizing: border-box',
    'width: 100%',
    'height: 100%',
    'min-height: 4em',
    'padding: 1em',
    'background: #2a1414',
    'color: #ff8a8a',
    'font-family: monospace',
    'font-size: 14px',
    'border: 2px dashed #ff5252',
    'white-space: pre-wrap',
    'overflow: auto'
  ].join('; ') + ';';

  return (
    <div class="pulsar-text-editor-placeholder" style={containerStyle}>
      <div>[pulsar-text-editor] new SolidJS text editor (experimental scaffold).</div>
      <div>Rendering not yet implemented. core.useNewTextEditor is ON.</div>
      <div>
        Solid signal tick: <strong>{tick()}s</strong>
        {' '}— if this number is changing, JSX → Babel → Solid → reactive DOM
        is working end to end.
      </div>
      <div>Model id: {props.modelId}</div>
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

    // `<atom-text-editor>` may be created with prior children (e.g. an
    // `initialText` text node from `textContent`). Clear them so the
    // Solid root has a clean container.
    while (this.element.firstChild) {
      this.element.removeChild(this.element.firstChild);
    }

    this.hiddenInput = document.createElement('input');
    this.hiddenInput.classList.add('hidden-input');
    this.hiddenInput.setAttribute('tabindex', '-1');
    this.hiddenInput.style.cssText =
      'position: absolute; width: 1px; height: 1px; opacity: 0;';
    this.element.appendChild(this.hiddenInput);

    this.solidHost = document.createElement('div');
    this.solidHost.classList.add('pulsar-text-editor-solid-host');
    this.solidHost.style.cssText = 'display: block; width: 100%; height: 100%;';
    this.element.appendChild(this.solidHost);

    const modelId = this.props.model && this.props.model.id;
    this.disposeRender = render(
      () => <ScaffoldPlaceholder modelId={modelId} />,
      this.solidHost
    );

    this.nextUpdatePromise = null;
    this.resolveNextUpdatePromise = null;

    // Diagnostic — visible in DevTools so we can confirm the swap fires
    // and the Solid mount succeeded. Remove once rendering lands.
    // eslint-disable-next-line no-console
    console.info(
      '[pulsar-text-editor] mounted on',
      this.element,
      '(model:', modelId, ')'
    );
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
  didFocus() { this.focused = true; }
  didBlur() { this.focused = false; }

  didUpdateStyles() {}
  didUpdateScrollbarStyles() {}

  // --- Model-driven callbacks (called from text-editor.js) --------------

  didChangeDisplayLayer(_changes) {}
  didResetDisplayLayer() {}
  didChangeSelectionRange() {}
  didUpdateSelections() {}
  didRequestAutoscroll(_scrollEvent) {}

  addBlockDecoration(_decoration) {}
  invalidateBlockDecorationDimensions() {}

  // --- Position / measurement queries -----------------------------------

  pixelPositionForScreenPosition(_screenPosition) {
    return { top: 0, left: 0 };
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

  measureDimensions() {}

  // --- Dimensions -------------------------------------------------------

  getLineHeight() { return 0; }
  getBaseCharacterWidth() { return 0; }

  getContentHeight() { return 0; }
  getContentWidth() { return 0; }

  getClientContainerHeight() { return 0; }
  getClientContainerWidth() { return 0; }
  getScrollContainerHeight() { return 0; }
  getScrollContainerWidth() { return 0; }
  getScrollContainerClientHeight() { return 0; }

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

  getScrollHeight() { return 0; }
  getScrollWidth() { return 0; }
  getMaxScrollTop() { return 0; }
  getMaxScrollLeft() { return 0; }

  getScrollTopRow() { return 0; }
  setScrollTopRow(_row) {}
  getScrollLeftColumn() { return 0; }
  setScrollLeftColumn(_column) {}

  // --- Viewport ---------------------------------------------------------

  getFirstVisibleRow() { return 0; }
  getLastVisibleRow() { return 0; }
  getFirstVisibleColumn() { return 0; }

  getRenderedStartRow() { return 0; }
  getRenderedEndRow() { return 0; }

  // --- Input ------------------------------------------------------------

  setInputEnabled(_enabled) {}
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
