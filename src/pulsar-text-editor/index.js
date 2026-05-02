// New SolidJS-based TextEditorComponent (scaffold).
//
// This file is the entry point for the experimental text editor
// implementation gated behind the `core.useNewTextEditor` config flag.
// Right now it is a *stub*: every public method returns a reasonable
// default so external callers (text-editor.js, text-editor-element.js,
// downstream packages) do not crash when the flag is on. The legacy
// Etch implementation at src/text-editor-component.js remains the
// default and is not modified.
//
// See docs/decisions/006-replace-etch-text-editor-with-solidjs.md for
// the migration plan. Subsequent commits will replace these stubs with
// real SolidJS components.
//
// Authoring notes:
// - This file is plain JS so Commit A does not depend on the
//   `solid-js` / `babel-preset-solid` packages being installed yet.
//   When real Solid components land in a follow-up commit, this file
//   (or a sibling file under this directory) will get a `'use babel'`
//   header so Pulsar's Babel pipeline picks up `babel-preset-solid`.
// - The Babel `overrides` entry in src/babel.config.js already covers
//   anything under `src/pulsar-text-editor/`.

'use strict';

let TextEditor = null;
let TextEditorElement = null;

class PulsarTextEditorComponent {
  // --- Static API ---------------------------------------------------------

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

  // --- Construction -------------------------------------------------------

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

    // Some `<atom-text-editor>` elements are created with prior children
    // (e.g. an `initialText` text node from `textContent`). Clear them so
    // the placeholder is the only thing rendered.
    while (this.element.firstChild) {
      this.element.removeChild(this.element.firstChild);
    }

    this.hiddenInput = document.createElement('input');
    this.hiddenInput.classList.add('hidden-input');
    this.hiddenInput.setAttribute('tabindex', '-1');
    this.hiddenInput.style.cssText =
      'position: absolute; width: 1px; height: 1px; opacity: 0;';

    this.placeholder = document.createElement('div');
    this.placeholder.classList.add('pulsar-text-editor-placeholder');
    // Inline styles deliberately heavy-handed so the scaffold is visible
    // regardless of whatever theme rules apply to `<atom-text-editor>`
    // descendants. Will be removed in a later commit.
    this.placeholder.style.cssText = [
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
    this.placeholder.textContent =
      '[pulsar-text-editor] new SolidJS text editor (experimental scaffold).\n' +
      'Rendering not yet implemented. core.useNewTextEditor is ON.';

    this.element.appendChild(this.hiddenInput);
    this.element.appendChild(this.placeholder);

    // Diagnostic — visible in DevTools (Cmd/Ctrl+Alt+I) so we can confirm
    // the swap fires. Remove once rendering lands.
    // eslint-disable-next-line no-console
    console.info(
      '[pulsar-text-editor] mounted on',
      this.element,
      '(model:', this.props.model && this.props.model.id, ')'
    );

    this.nextUpdatePromise = null;
    this.resolveNextUpdatePromise = null;
  }

  // --- Update / lifecycle -------------------------------------------------

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
  }

  didShow() { this.visible = true; }
  didHide() { this.visible = false; }
  didFocus() { this.focused = true; }
  didBlur() { this.focused = false; }

  didUpdateStyles() {}
  didUpdateScrollbarStyles() {}

  // --- Model-driven callbacks (called from text-editor.js) ----------------

  didChangeDisplayLayer(_changes) {}
  didResetDisplayLayer() {}
  didChangeSelectionRange() {}
  didUpdateSelections() {}
  didRequestAutoscroll(_scrollEvent) {}

  addBlockDecoration(_decoration) {}
  invalidateBlockDecorationDimensions() {}

  // --- Position / measurement queries -------------------------------------

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

  // --- Dimensions ---------------------------------------------------------

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

  // --- Scroll -------------------------------------------------------------

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

  // --- Viewport -----------------------------------------------------------

  getFirstVisibleRow() { return 0; }
  getLastVisibleRow() { return 0; }
  getFirstVisibleColumn() { return 0; }

  getRenderedStartRow() { return 0; }
  getRenderedEndRow() { return 0; }

  // --- Input --------------------------------------------------------------

  setInputEnabled(_enabled) {}
  getHiddenInput() { return this.hiddenInput; }

  // --- Decoration / gutter queries ---------------------------------------

  queryGuttersToRender() {
    return this.props.model
      ? [this.props.model.getLineNumberGutter()]
      : [];
  }

  queryDecorationsToRender() {}
}

PulsarTextEditorComponent.attachedComponents = null;

module.exports = PulsarTextEditorComponent;
