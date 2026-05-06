'use strict';

const NBSP = ' ';

// Manages the line-number gutter that lives outside the scroll container.
// Vertical sync is done by `translateY(-scrollTop)` on the inner element —
// the same frame as the scroll event, before the next render, so the gutter
// never lags the content by one frame.
class GutterView {
  constructor() {
    // Outer wrapper: clips the inner translateY'd content.
    this._outerEl = document.createElement('div');
    this._outerEl.style.cssText = 'overflow: hidden; flex-shrink: 0;';

    // Inner div: scrolled via CSS transform.
    this._innerEl = document.createElement('div');
    this._innerEl.className = 'gutter line-numbers';
    this._innerEl.setAttribute('gutter-name', 'line-number');
    this._innerEl.style.cssText = 'will-change: transform;';
    this._outerEl.appendChild(this._innerEl);

    // Fixed spacers.
    this._topSpacerEl = document.createElement('div');
    this._topSpacerEl.style.display = 'block';
    this._innerEl.appendChild(this._topSpacerEl);

    this._bottomSpacerEl = document.createElement('div');
    this._bottomSpacerEl.style.display = 'block';
    this._innerEl.appendChild(this._bottomSpacerEl);

    // Keyed elements.
    this._lineNumEls = new Map();   // screenRow → HTMLElement
    this._blockEls = new Map();     // blockInfo → HTMLElement
  }

  // Imperatively sync vertical scroll (called same-frame as scroll event).
  setScrollTop(scrollTop) {
    this._innerEl.style.transform = 'translateY(' + (-scrollTop) + 'px)';
  }

  update(state) {
    const {
      showGutter, showLineNumbers, maxDigits,
      visibleGutterRows, sortedBlocks,
      topSpacer, bottomSpacer,
      lineNumDecoClasses, scrollTop
    } = state;

    if (!showGutter) {
      this._outerEl.style.display = 'none';
      return;
    }
    this._outerEl.style.display = '';

    this.setScrollTop(scrollTop);
    const topPx = topSpacer + 'px';
    if (this._topSpacerEl.style.height !== topPx) this._topSpacerEl.style.height = topPx;
    const botPx = bottomSpacer + 'px';
    if (this._bottomSpacerEl.style.height !== botPx) this._bottomSpacerEl.style.height = botPx;

    // Build flat interleaved list: [before-blocks, line-number, after-blocks]...
    const newEls = [];
    for (const row of visibleGutterRows) {
      for (const b of this._blocksAt(row.screenRow, 'before', sortedBlocks)) {
        newEls.push(this._getOrUpdateBlockEl(b));
      }
      newEls.push(this._getOrUpdateLineNumEl(row, { showLineNumbers, maxDigits, lineNumDecoClasses }));
      for (const b of this._blocksAt(row.screenRow, 'after', sortedBlocks)) {
        newEls.push(this._getOrUpdateBlockEl(b));
      }
    }

    // Remove stale line-number elements.
    const visRowSet = new Set(visibleGutterRows.map(r => r.screenRow));
    for (const row of this._lineNumEls.keys()) {
      if (!visRowSet.has(row)) this._lineNumEls.delete(row);
    }

    this._reconcile(newEls);
  }

  // ---- helpers ----

  _blocksAt(row, position, sortedBlocks) {
    const out = [];
    for (let i = 0; i < sortedBlocks.length; i++) {
      const b = sortedBlocks[i];
      if (b.row > row) break;
      if (b.row === row && b.position === position) out.push(b);
    }
    return out;
  }

  _getOrUpdateBlockEl(blockInfo) {
    let el = this._blockEls.get(blockInfo);
    if (!el) {
      el = document.createElement('div');
      el.style.display = 'block';
      this._blockEls.set(blockInfo, el);
    }
    const h = blockInfo.height + 'px';
    if (el.style.height !== h) el.style.height = h;
    return el;
  }

  _getOrUpdateLineNumEl(rowData, { showLineNumbers, maxDigits, lineNumDecoClasses }) {
    const { screenRow, bufferRow, softWrapped, foldable } = rowData;
    let el = this._lineNumEls.get(screenRow);
    if (!el) {
      el = document.createElement('div');
      const span = document.createElement('span');
      span.className = 'line-number-text';
      const icon = document.createElement('div');
      icon.className = 'icon-right';
      el.appendChild(span);
      el.appendChild(icon);
      this._lineNumEls.set(screenRow, el);
    }

    // Class.
    let cls = 'line-number';
    if (foldable) cls += ' foldable';
    const decoClass = lineNumDecoClasses ? lineNumDecoClasses.get(screenRow) : null;
    if (decoClass) cls += ' ' + decoClass;
    if (el.className !== cls) el.className = cls;

    // data-screen-row.
    if (el.dataset.screenRow !== String(screenRow)) el.dataset.screenRow = screenRow;

    // Label text (firstElementChild is always the .line-number-text span).
    const span = el.firstElementChild;
    if (span) {
      let label = '';
      if (showLineNumbers) {
        const raw = softWrapped ? '•' : String(bufferRow + 1);
        label = NBSP.repeat(Math.max(0, maxDigits - raw.length)) + raw;
      }
      if (span.textContent !== label) span.textContent = label;
    }

    return el;
  }

  // Replace variable content between topSpacer and bottomSpacer.
  _reconcile(newEls) {
    const inner = this._innerEl;
    const toRemove = [];
    let child = this._topSpacerEl.nextSibling;
    while (child && child !== this._bottomSpacerEl) {
      toRemove.push(child);
      child = child.nextSibling;
    }
    for (const el of toRemove) {
      if (el.parentNode === inner) inner.removeChild(el);
    }
    for (const el of newEls) {
      inner.insertBefore(el, this._bottomSpacerEl);
    }
  }

  getOuterEl() { return this._outerEl; }
  getInnerEl() { return this._innerEl; }
}

module.exports = GutterView;
