'use strict';

const { Position } = require('./position');
const { Range } = require('./range');
const { Selection } = require('./selection');
const { TextDocument } = require('./text-document');

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
    this._document = new TextDocument(atomEditor);
    this._decorationMap = new Map(); // TextEditorDecorationType → Decoration[]
  }

  get document() { return this._document; }

  get selection() {
    const sel = this._editor.getLastSelection();
    const range = sel.getBufferRange();
    const cursor = sel.cursor;
    const anchor = cursor.isAtEndOfSelection ? range.start : range.end;
    return new Selection(
      new Position(range.start.row, range.start.column),
      new Position(range.end.row, range.end.column)
    );
  }

  set selection(sel) {
    this._editor.setSelectedBufferRange(sel.toAtomRange());
  }

  get selections() {
    return this._editor.getSelections().map(sel => {
      const range = sel.getBufferRange();
      return new Selection(
        new Position(range.start.row, range.start.column),
        new Position(range.end.row, range.end.column)
      );
    });
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
      newDecorations.push({ destroy() { marker.destroy(); } });
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

module.exports = { TextEditor, TextEditorDecorationType, TextEditorEdit, ViewColumn, TextEditorRevealType, TextEditorLineNumbersStyle, TextEditorSelectionChangeKind, OverviewRulerLane, DecorationRangeBehavior };
