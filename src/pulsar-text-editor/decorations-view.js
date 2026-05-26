'use strict';

function rangeToRects(range, lh, cw, topForRow) {
  if (!range || range.isEmpty()) return [];
  const { start, end } = range;
  if (start.row === end.row) {
    const w = (end.column - start.column) * cw;
    if (w <= 0) return [];
    return [{
      top: topForRow(start.row),
      left: start.column * cw,
      width: w,
      right: null,
      height: lh
    }];
  }
  const rects = [];
  rects.push({ top: topForRow(start.row), left: start.column * cw, right: 0, width: null, height: lh });
  for (let r = start.row + 1; r < end.row; r++) {
    rects.push({ top: topForRow(r), left: 0, right: 0, width: null, height: lh });
  }
  if (end.column > 0) {
    rects.push({ top: topForRow(end.row), left: 0, width: end.column * cw, right: null, height: lh });
  }
  return rects;
}

// Manages the `.highlights` and `.cursors` overlay layers inside linesWrapper.
// Both are `position: absolute` and span the full content height so their
// children's absolute coordinates are relative to the lines-wrapper top.
class DecorationsView {
  constructor(highlightsEl, cursorsEl) {
    this._highlightsEl = highlightsEl;
    this._cursorsEl = cursorsEl;

    // Keyed maps for stable DOM node reuse.
    this._selectionEls = new Map();   // index → HTMLElement
    this._highlightEls = new Map();   // decoKey → HTMLElement
    this._cursorEls = new Map();      // index → HTMLElement
  }

  update({ selectionRanges, highlightDecos, cursorDescriptors, blinkOff, lineHeight, charWidth, topForRow, totalHeight }) {
    // Layer height must cover the full content (rows * lh + blocks height).
    const hpx = totalHeight + 'px';
    if (this._highlightsEl.style.height !== hpx) this._highlightsEl.style.height = hpx;
    if (this._cursorsEl.style.height !== hpx) this._cursorsEl.style.height = hpx;

    // Blink toggle.
    const cursClass = 'cursors' + (blinkOff ? ' blink-off' : '');
    if (this._cursorsEl.className !== cursClass) this._cursorsEl.className = cursClass;

    this._updateSelections(selectionRanges, lineHeight, charWidth, topForRow);
    this._updateHighlights(highlightDecos, lineHeight, charWidth, topForRow);
    this._updateCursors(cursorDescriptors, lineHeight, charWidth, topForRow);
  }

  // ---- selections ----

  _updateSelections(selectionRanges, lh, cw, topForRow) {
    for (let i = 0; i < selectionRanges.length; i++) {
      let el = this._selectionEls.get(i);
      if (!el) {
        el = document.createElement('div');
        el.className = 'highlight selection';
        this._highlightsEl.appendChild(el);
        this._selectionEls.set(i, el);
      }
      if (lh && cw) {
        const rects = rangeToRects(selectionRanges[i], lh, cw, topForRow);
        this._syncRegions(el, rects);
      }
    }
    // Remove excess.
    for (let i = selectionRanges.length; ; i++) {
      const el = this._selectionEls.get(i);
      if (!el) break;
      if (el.parentNode) el.parentNode.removeChild(el);
      this._selectionEls.delete(i);
    }
  }

  // ---- highlight decorations ----

  _updateHighlights(highlightDecos, lh, cw, topForRow) {
    const newKeys = new Set();
    for (const h of highlightDecos) {
      newKeys.add(h.key);
      let el = this._highlightEls.get(h.key);
      if (!el) {
        el = document.createElement('div');
        el.className = 'highlight' + (h.class ? ' ' + h.class : '');
        this._highlightsEl.appendChild(el);
        this._highlightEls.set(h.key, el);
      }
      if (lh && cw) {
        const rects = rangeToRects(h.range, lh, cw, topForRow);
        this._syncRegions(el, rects);
      }
    }
    // Remove stale.
    for (const [key, el] of this._highlightEls) {
      if (!newKeys.has(key)) {
        if (el.parentNode) el.parentNode.removeChild(el);
        this._highlightEls.delete(key);
      }
    }
  }

  // ---- cursors ----

  _updateCursors(cursorDescriptors, lh, cw, topForRow) {
    for (let i = 0; i < cursorDescriptors.length; i++) {
      const { position, extraClass, extraStyle } = cursorDescriptors[i];
      let el = this._cursorEls.get(i);
      if (!el) {
        el = document.createElement('div');
        this._cursorsEl.appendChild(el);
        this._cursorEls.set(i, el);
      }
      const cls = 'cursor' + (extraClass ? ' ' + extraClass : '');
      if (el.className !== cls) el.className = cls;

      const style = this._cursorStyle(position, extraStyle, lh, cw, topForRow);
      if (el.style.cssText !== style) el.style.cssText = style;
    }
    // Remove excess cursor elements.
    for (let i = cursorDescriptors.length; ; i++) {
      const el = this._cursorEls.get(i);
      if (!el) break;
      if (el.parentNode) el.parentNode.removeChild(el);
      this._cursorEls.delete(i);
    }
  }

  _cursorStyle(pos, extraStyle, lh, cw, topForRow) {
    if (!lh || !cw || !pos) return 'display: none;';
    let baseX = pos.column * cw;
    let baseY = topForRow ? topForRow(pos.row) : pos.row * lh;

    let extraRest = null;
    if (extraStyle) {
      if (extraStyle.top != null) {
        const v = extraStyle.top;
        if (typeof v === 'string' && v.endsWith('px')) baseY += parseFloat(v);
        else if (typeof v === 'number') baseY += v;
      }
      if (extraStyle.left != null) {
        const v = extraStyle.left;
        if (typeof v === 'string' && v.endsWith('ch')) baseX += parseFloat(v) * cw;
        else if (typeof v === 'string' && v.endsWith('px')) baseX += parseFloat(v);
        else if (typeof v === 'number') baseX += v;
      }
      // Any other extra style props (visibility, width, background, etc.).
      const { top: _t, left: _l, ...rest } = extraStyle;
      if (Object.keys(rest).length > 0) extraRest = rest;
    }

    let style =
      'position: absolute; top: 0; left: 0; ' +
      'width: ' + cw + 'px; height: ' + lh + 'px; ' +
      'transform: translate(' + baseX + 'px, ' + baseY + 'px);';
    if (extraRest) {
      for (const [k, v] of Object.entries(extraRest)) {
        const prop = k.replace(/([A-Z])/g, c => '-' + c.toLowerCase());
        style += ' ' + prop + ': ' + v + ';';
      }
    }
    return style;
  }

  // ---- region reconciliation ----

  // Create/update/remove `.region` child divs inside `wrapperEl` to match `rects`.
  _syncRegions(wrapperEl, rects) {
    let i = 0;
    for (; i < rects.length; i++) {
      const r = rects[i];
      let regionEl = wrapperEl.children[i];
      if (!regionEl) {
        regionEl = document.createElement('div');
        regionEl.className = 'region';
        wrapperEl.appendChild(regionEl);
      }
      const style =
        'position: absolute; box-sizing: border-box; ' +
        'top: ' + r.top + 'px; ' +
        'left: ' + r.left + 'px; ' +
        'height: ' + r.height + 'px; ' +
        (r.right != null ? 'right: 0;' : 'width: ' + r.width + 'px;');
      if (regionEl.style.cssText !== style) regionEl.style.cssText = style;
    }
    // Remove excess region elements.
    while (wrapperEl.children.length > rects.length) {
      wrapperEl.removeChild(wrapperEl.lastChild);
    }
  }
}

module.exports = DecorationsView;
