'use strict';

const { Position } = require('./position');
const { Range } = require('./range');
const { Selection } = require('./selection');
const { getTextDocument } = require('./text-document');

const ViewColumn = Object.freeze({
  Active: -1, Beside: -2, One: 1, Two: 2, Three: 3,
  Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9
});

const TextEditorRevealType = Object.freeze({
  Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3
});

const TextEditorLineNumbersStyle = Object.freeze({ Off: 0, On: 1, Relative: 2, Interval: 3 });
const TextEditorSelectionChangeKind = Object.freeze({ Keyboard: 1, Mouse: 2, Command: 3 });
const OverviewRulerLane = Object.freeze({ Left: 1, Center: 2, Right: 4, Full: 7 });
const DecorationRangeBehavior = Object.freeze({ OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 });

class TextEditorDecorationType {
  constructor(options, styleElement) {
    this._options = options;
    this._styleElement = styleElement;
    this._className = styleElement ? styleElement.dataset.decorationClass : undefined;
    this._disposed = false;
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    if (this._styleElement && this._styleElement.parentNode) {
      this._styleElement.parentNode.removeChild(this._styleElement);
    }
    // Destroy all associated decorations tracked globally
    if (this._decorations) {
      for (const d of this._decorations) { try { d.destroy(); } catch (e) {} }
      this._decorations = [];
    }
  }
}

class TextEditorEdit {
  constructor(atomEditor) {
    this._editor = atomEditor;
    this._ops = [];
  }

  replace(rangeOrSelection, value) {
    this._ops.push({ type: 'replace', range: rangeOrSelection, value });
  }

  insert(location, value) {
    this._ops.push({ type: 'insert', location, value });
  }

  delete(rangeOrSelection) {
    this._ops.push({ type: 'delete', range: rangeOrSelection });
  }

  setEndOfLine(endOfLine) {
    this._ops.push({ type: 'eol', endOfLine });
  }

  _apply() {
    this._editor.transact(() => {
      for (const op of this._ops) {
        if (op.type === 'replace') {
          this._editor.setTextInBufferRange(op.range.toAtomRange(), op.value);
        } else if (op.type === 'insert') {
          this._editor.setTextInBufferRange([op.location.toAtomPoint(), op.location.toAtomPoint()], op.value);
        } else if (op.type === 'delete') {
          this._editor.setTextInBufferRange(op.range.toAtomRange(), '');
        }
      }
    });
  }
}

class TextEditor {
  constructor(atomEditor) {
    this._editor = atomEditor;
    this._document = getTextDocument(atomEditor);
    this._decorationMap = new Map(); // TextEditorDecorationType → Decoration[]
  }

  get document() {
    this._document = getTextDocument(this._editor);
    return this._document;
  }

  get selection() {
    const sel = this._editor.getLastSelection();
    return selectionFromAtomSelection(sel);
  }

  set selection(sel) {
    this._editor.setSelectedBufferRange(sel.toAtomRange(), { reversed: sel.isReversed });
  }

  get selections() {
    return this._editor.getSelections().map(selectionFromAtomSelection);
  }

  set selections(sels) {
    this._editor.setSelectedBufferRanges(sels.map(s => s.toAtomRange()));
  }

  get visibleRanges() {
    const el = atom.views.getView(this._editor);
    if (!el || !el.component) return [new Range(new Position(0, 0), new Position(0, 0))];
    const firstRow = el.component.getFirstVisibleRow ? el.component.getFirstVisibleRow() : 0;
    const lastRow = el.component.getLastVisibleRow ? el.component.getLastVisibleRow() : this._editor.getLineCount();
    return [new Range(new Position(firstRow, 0), new Position(lastRow, 0))];
  }

  get options() {
    return {
      tabSize: this._editor.getTabLength(),
      insertSpaces: this._editor.getSoftTabs(),
      cursorStyle: 1,
      lineNumbers: 1
    };
  }

  get viewColumn() { return ViewColumn.One; }

  edit(callback, options) {
    const editBuilder = new TextEditorEdit(this._editor);
    try {
      callback(editBuilder);
      editBuilder._apply();
      return Promise.resolve(true);
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  insertSnippet(snippet, location) {
    const text = typeof snippet === 'string' ? snippet : snippet.value;
    if (location) {
      this._editor.setSelectedBufferRange(location instanceof Selection ? location.toAtomRange() : [[location.line, location.character], [location.line, location.character]]);
    }
    // Use atom snippets if available, otherwise insert raw text
    try {
      atom.packages.serviceHub.consume('snippets', '0.1.0', snippets => {
        snippets.insertSnippet(text, this._editor);
      });
    } catch (e) {
      this._editor.insertText(text);
    }
    return Promise.resolve(true);
  }

  setDecorations(decorationType, rangesOrOptions) {
    // Remove existing decorations for this type
    const existing = this._decorationMap.get(decorationType) || [];
    for (const d of existing) { try { d.destroy(); } catch (e) {} }

    const newDecorations = [];
    const items = Array.isArray(rangesOrOptions) ? rangesOrOptions : [];

    for (const item of items) {
      let range, hoverMessage, renderOptions;
      if (item instanceof Range) {
        range = item;
      } else if (item && item.range) {
        range = item.range;
        hoverMessage = item.hoverMessage;
        renderOptions = item.renderOptions;
      } else {
        continue;
      }

      const marker = this._editor.markBufferRange(range.toAtomRange(), { invalidate: 'never' });
      const props = { type: 'highlight', class: decorationType._className };
      if (decorationType._options && decorationType._options.isWholeLine) {
        props.type = 'line';
      }
      const decoration = this._editor.decorateMarker(marker, props);
      const disposables = [{ destroy() { marker.destroy(); } }];

      const afterOptions = (renderOptions && renderOptions.after) || (decorationType._options && decorationType._options.after);
      if (afterOptions && afterOptions.contentText) {
        const overlayMarker = this._editor.markBufferRange(endPointRange(range), { invalidate: 'touch' });
        const overlayElement = createAfterDecorationElement(afterOptions, () => overlayMarker.destroy());
        this._editor.decorateMarker(overlayMarker, {
          type: 'overlay',
          position: 'tail',
          item: overlayElement,
          avoidOverflow: false
        });
        disposables.push({ destroy() { overlayMarker.destroy(); } });
      }

      if (hoverMessage) {
        try {
          const text = typeof hoverMessage === 'string' ? hoverMessage : hoverMessage.value || String(hoverMessage);
          if (text) marker.getProperties().title = text;
        } catch (e) {}
      }

      newDecorations.push({ destroy() { for (const d of disposables) d.destroy(); } });
    }

    this._decorationMap.set(decorationType, newDecorations);
    if (!decorationType._decorations) decorationType._decorations = [];
    decorationType._decorations.push(...newDecorations);
  }

  revealRange(range, revealType) {
    this._editor.scrollToBufferPosition([range.start.line, range.start.character]);
  }

  show(column) {
    const pane = atom.workspace.paneForItem(this._editor);
    if (pane) pane.activate();
  }

  hide() {}
}

function selectionFromAtomSelection(selection) {
  const range = selection.getBufferRange();
  const cursor = selection.cursor || (selection.getCursor && selection.getCursor());
  const cursorAtEnd = !cursor || cursor.isAtEndOfSelection !== false;
  const anchor = cursorAtEnd ? range.start : range.end;
  const active = cursorAtEnd ? range.end : range.start;
  return new Selection(
    new Position(anchor.row, anchor.column),
    new Position(active.row, active.column)
  );
}

function endPointRange(range) {
  const end = range.end || range.start;
  return [[end.line, end.character], [end.line, end.character]];
}

function createAfterDecorationElement(options, close) {
  const el = document.createElement('span');
  el.classList.add('vscode-after-decoration-tooltip');
  el.style.cssText = [
    'display:inline-flex',
    'position:relative',
    // Pulsar overlay decorations are positioned below the marker row by
    // default (the same behavior autocomplete popups want). VSCode
    // `renderOptions.after.contentText` is an inline after-decoration, so move
    // this overlay back up by exactly one editor line.
    'top:calc(-1 * var(--editor-line-height))',
    'align-items:center',
    'gap:4px',
    'max-width:50vw',
    'margin-left:0.5em',
    'padding:1px 5px',
    'border-radius:3px',
    'background:var(--overlay-background-color,var(--base-background-color,#2d2d2d))',
    'border:1px solid var(--base-border-color,#555)',
    `color:${cssColor(options.color) || 'var(--text-color,inherit)'}`,
    'font-size:0.9em',
    'line-height:1.35',
    'box-shadow:0 1px 4px rgba(0,0,0,0.25)',
    'white-space:pre',
    'overflow:hidden',
    'text-overflow:ellipsis',
    'vertical-align:baseline',
    'pointer-events:auto'
  ].join(';');

  const text = document.createElement('span');
  text.classList.add('vscode-after-decoration-tooltip-text');
  text.textContent = String(options.contentText || '');
  text.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
  el.appendChild(text);

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = '×';
  button.title = 'Close';
  button.style.cssText = 'margin:0 0 0 2px;padding:0;border:0;background:transparent;color:inherit;opacity:0.75;cursor:pointer;font:inherit;line-height:1;';
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    close();
  });
  el.appendChild(button);

  return el;
}

function cssColor(value) {
  if (!value) return undefined;
  if (typeof value === 'string') return value;
  if (value.id) return `var(--${String(value.id).replace(/\./g, '-')})`;
  return undefined;
}

module.exports = { TextEditor, TextEditorDecorationType, TextEditorEdit, ViewColumn, TextEditorRevealType, TextEditorLineNumbersStyle, TextEditorSelectionChangeKind, OverviewRulerLane, DecorationRangeBehavior };
