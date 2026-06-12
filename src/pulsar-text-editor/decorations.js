'use strict';

// ---------------------------------------------------------------------------
// Pure computation helpers (stateless, called from component._render)
// ---------------------------------------------------------------------------

function applyLineDecoration(byRow, decoration, screenRange, reversed) {
  if (!decoration.class) return;
  const empty = screenRange.isEmpty();
  if (empty) {
    if (decoration.onlyNonEmpty) return;
  } else {
    if (decoration.onlyEmpty) return;
  }
  let omitLastRow = false;
  if (!empty && decoration.omitEmptyLastRow !== false) {
    omitLastRow = screenRange.end.column === 0;
  }
  let startRow = screenRange.start.row;
  let endRow = screenRange.end.row;
  if (decoration.onlyHead) {
    if (reversed) endRow = startRow;
    else startRow = endRow;
  }
  for (let row = startRow; row <= endRow; row++) {
    if (omitLastRow && row === screenRange.end.row) break;
    const cur = byRow.get(row);
    byRow.set(row, cur ? cur + ' ' + decoration.class : decoration.class);
  }
}

function computeSortedBlocks(blockDecorations) {
  const list = [];
  blockDecorations.forEach((info) => list.push(info));
  list.sort((a, b) => {
    if (a.row !== b.row) return a.row - b.row;
    if (a.position !== b.position) return a.position === 'before' ? -1 : 1;
    return (a.order || 0) - (b.order || 0);
  });
  return list;
}

function computeLineNumDecoClasses(model) {
  const byRow = new Map();
  if (!model || !model.decorationManager) return byRow;
  const total = model.getScreenLineCount();
  let propsByMarker = null;
  if (model.decorationManager.decorationPropertiesByMarkerForScreenRowRange) {
    propsByMarker = model.decorationManager.decorationPropertiesByMarkerForScreenRowRange(0, total);
  }
  if (!propsByMarker) return byRow;
  for (const [marker, decos] of propsByMarker) {
    for (const d of decos) {
      if (!d || !d.class) continue;
      const isLN = Array.isArray(d.type)
        ? d.type.indexOf('line-number') !== -1
        : d.type === 'line-number';
      if (!isLN) continue;
      const range = marker.getScreenRange ? marker.getScreenRange() : null;
      if (!range) continue;
      const reversed = marker.isReversed ? marker.isReversed() : false;
      applyLineDecoration(byRow, d, range, reversed);
    }
  }
  return byRow;
}

let rangeForOverlayMeasurement = null;

function textNodesForElement(element) {
  const nodes = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) nodes.push(node);
  return nodes;
}

function textNodeAndOffsetForColumn(textNodes, column) {
  if (textNodes.length === 0) return [null, 0];
  if (column <= 0) return [textNodes[0], 0];

  let previous = 0;
  for (const node of textNodes) {
    const next = previous + node.length;
    if (column <= next) return [node, column - previous];
    previous = next;
  }

  const last = textNodes[textNodes.length - 1];
  return [last, last.length];
}

function measuredOverlayLeftForScreenPosition(editorElement, row, column, charWidth) {
  if (!editorElement || !editorElement.querySelector) return null;
  const lineEl = editorElement.querySelector(`.line[data-screen-row="${row}"]`);
  if (!lineEl || !lineEl.isConnected) return null;

  const computedStyle = window.getComputedStyle(lineEl);
  const paddingLeft = parseFloat(computedStyle.paddingLeft) || 0;
  const renderedColumnStart = charWidth ? Math.round(paddingLeft / charWidth) : 0;
  const renderedColumn = column - renderedColumnStart;
  if (renderedColumn < 0) return null;

  const textNodes = textNodesForElement(lineEl);
  const [textNode, offset] = textNodeAndOffsetForColumn(textNodes, renderedColumn);
  if (!textNode) return null;

  rangeForOverlayMeasurement ??= document.createRange();
  rangeForOverlayMeasurement.setStart(textNode, offset);
  rangeForOverlayMeasurement.setEnd(textNode, offset);

  const rect = rangeForOverlayMeasurement.getBoundingClientRect();
  return rect && Number.isFinite(rect.left) ? rect.left : null;
}

function computeHighlightDecos(model, firstRow, lastRow) {
  if (!model || !model.decorationManager) return [];
  const dm = model.decorationManager;
  if (!dm.decorationPropertiesByMarkerForScreenRowRange) return [];
  const propsByMarker = dm.decorationPropertiesByMarkerForScreenRowRange(firstRow, lastRow + 1);
  const out = [];
  for (const [marker, decos] of propsByMarker) {
    const range = marker.getScreenRange ? marker.getScreenRange() : null;
    if (!range || range.isEmpty()) continue;
    for (let i = 0; i < decos.length; i++) {
      const d = decos[i];
      if (!d) continue;
      const isHighlight = Array.isArray(d.type)
        ? d.type.indexOf('highlight') !== -1
        : d.type === 'highlight';
      if (!isHighlight) continue;
      if (d.class === 'selection') continue;
      out.push({
        key: marker.id + ':' + (d.class || '') + ':' + i,
        class: d.class || '',
        range
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// BlockDecorations — manages the full lifecycle of block decorations
// ---------------------------------------------------------------------------

class BlockDecorations {
  // callbacks: { scheduleUpdate, replayAutoscroll }
  constructor(callbacks) {
    this._scheduleUpdate = callbacks.scheduleUpdate;
    this._replayAutoscroll = callbacks.replayAutoscroll;
    // Map<decoration, blockInfo>
    // blockInfo: { decoration, element, wrapperElement, row, position, order, height, ro, markerSub, destroySub }
    this._map = new Map();
  }

  get map() { return this._map; }

  add(decoration) {
    if (this._map.has(decoration)) return;
    const props = decoration.getProperties
      ? decoration.getProperties()
      : decoration.properties;
    if (!props || !props.item) return;
    const element = props.item.element || props.item;
    if (!element || typeof element !== 'object' || element.nodeType !== 1) return;
    const marker = decoration.getMarker
      ? decoration.getMarker()
      : decoration.marker;
    if (!marker || marker.isDestroyed()) return;

    const headPos = marker.getHeadScreenPosition();
    const row = headPos ? headPos.row : 0;
    const position = props.position === 'after' ? 'after' : 'before';
    const order = typeof props.order === 'number' ? props.order : 0;

    const ro = new ResizeObserver(() => {
      const info = this._map.get(decoration);
      if (!info) return;
      if (this._updateHeight(info)) {
        this._scheduleUpdate();
        this._replayAutoscroll();
      }
    });
    ro.observe(element);

    let markerSub = null;
    if (marker.onDidChange) {
      markerSub = marker.onDidChange(() => {
        const info = this._map.get(decoration);
        if (!info) return;
        const newRow = marker.getHeadScreenPosition().row;
        if (info.row !== newRow) {
          info.row = newRow;
          this._scheduleUpdate();
        }
      });
    }

    let destroySub = null;
    if (decoration.onDidDestroy) {
      destroySub = decoration.onDidDestroy(() => {
        this.remove(decoration);
      });
    }

    const info = {
      decoration, element, row, position, order,
      height: 0,
      ro, markerSub, destroySub,
      wrapperElement: null
    };
    info.height = this._measureHeight(info);
    this._map.set(decoration, info);
    this._scheduleUpdate();
  }

  remove(decoration) {
    const info = this._map.get(decoration);
    if (!info) return;
    info.ro.disconnect();
    if (info.markerSub) info.markerSub.dispose();
    if (info.destroySub) info.destroySub.dispose();
    info.wrapperElement = null;
    this._map.delete(decoration);
    this._scheduleUpdate();
  }

  destroyAll() {
    for (const decoration of [...this._map.keys()]) {
      this.remove(decoration);
    }
  }

  syncFromModel(model) {
    if (!model || !model.decorationManager) return;
    const all = model.decorationManager.getDecorations
      ? model.decorationManager.getDecorations()
      : [];
    for (const decoration of all) {
      if (!decoration.isType || !decoration.isType('block')) continue;
      this.add(decoration);
    }
  }

  invalidate(decoration) {
    const info = this._map.get(decoration);
    if (!info) return;
    if (this._updateHeight(info)) {
      this._scheduleUpdate();
      this._replayAutoscroll();
    }
  }

  syncRenderedHeights() {
    let changed = false;
    for (const info of this._map.values()) {
      const wrapper = info.wrapperElement;
      if (!wrapper || !isNodeConnected(wrapper)) continue;
      if (this._updateHeight(info)) changed = true;
    }
    if (changed) {
      this._scheduleUpdate();
      this._replayAutoscroll();
    }
    return changed;
  }

  _updateHeight(info) {
    const newHeight = this._measureHeight(info);
    if (Math.abs((info.height || 0) - newHeight) <= 0.5) return false;
    info.height = newHeight;
    return true;
  }

  _measureHeight(info) {
    const wrapper = info.wrapperElement;
    const target = wrapper && isNodeConnected(wrapper) ? wrapper : info.element;
    if (!target) return 0;

    if (target.parentNode && isNodeConnected(target)) {
      const before = document.createElement('div');
      const after = document.createElement('div');
      const sentinelStyle =
        'display: block; height: 1px; margin: 0; padding: 0; border: 0; overflow: hidden;';
      before.style.cssText = sentinelStyle;
      after.style.cssText = sentinelStyle;
      target.parentNode.insertBefore(before, target);
      target.parentNode.insertBefore(after, target.nextSibling);
      const height = after.getBoundingClientRect().top -
        before.getBoundingClientRect().bottom;
      before.remove();
      after.remove();
      return Math.max(0, height);
    }

    return target.offsetHeight || 0;
  }
}

// ---------------------------------------------------------------------------
// OverlayDecorations — manages overlay decoration DOM and positioning
// ---------------------------------------------------------------------------

class OverlayDecorations {
  // callbacks: { scheduleUpdate, getLineHeight, getCharWidth, getScroller,
  //              getPixelTopForRow, getElement }
  constructor(callbacks) {
    this._cb = callbacks;
    // Map<decoration, { wrapperEl, resizeObserver, destroySub, markerSub }>
    this._map = new Map();
  }

  get map() { return this._map; }

  syncFromModel(model) {
    if (!model || !model.decorationManager) return;
    const liveDecorations = new Set();
    const allDecorations = model.decorationManager.getDecorations
      ? model.decorationManager.getDecorations()
      : [];
    for (const decoration of allDecorations) {
      if (!decoration.isType('overlay')) continue;
      liveDecorations.add(decoration);
      if (!this._map.has(decoration)) {
        this._add(decoration);
      } else {
        this._position(decoration);
      }
    }
    for (const [decoration, entry] of this._map) {
      if (!liveDecorations.has(decoration)) {
        this._remove(decoration, entry);
      }
    }
  }

  destroyAll() {
    for (const [decoration, entry] of this._map) {
      this._remove(decoration, entry);
    }
  }

  repositionAll() {
    for (const decoration of this._map.keys()) {
      this._position(decoration);
    }
  }

  _add(decoration) {
    const props = decoration.getProperties ? decoration.getProperties() : decoration.properties;
    if (!props) return;
    const item = props.item;
    if (!item) return;
    const itemEl = item.element || item;
    if (!itemEl || typeof itemEl !== 'object' || !itemEl.appendChild) return;

    const wrapperEl = document.createElement('atom-overlay');
    if (props.class) wrapperEl.classList.add(props.class);
    wrapperEl.style.cssText = 'position: fixed; z-index: 4;';
    wrapperEl.appendChild(itemEl);
    this._cb.getElement().appendChild(wrapperEl);

    const resizeObserver = new ResizeObserver(() => { this._position(decoration); });
    resizeObserver.observe(itemEl);

    let destroySub = null;
    if (decoration.onDidDestroy) {
      destroySub = decoration.onDidDestroy(() => {
        const entry = this._map.get(decoration);
        if (entry) this._remove(decoration, entry);
      });
    }

    let markerSub = null;
    const marker = decoration.getMarker();
    if (marker && marker.onDidChange) {
      markerSub = marker.onDidChange(() => this._position(decoration));
    }

    this._map.set(decoration, { wrapperEl, resizeObserver, destroySub, markerSub });
    this._position(decoration);
  }

  _position(decoration) {
    const entry = this._map.get(decoration);
    if (!entry) return;
    const { wrapperEl } = entry;
    const props = decoration.getProperties ? decoration.getProperties() : decoration.properties;
    if (!props) return;
    const marker = decoration.getMarker ? decoration.getMarker() : null;
    if (!marker) return;

    const screenPosition = props.position === 'tail'
      ? marker.getTailScreenPosition()
      : marker.getHeadScreenPosition();

    const lh = this._cb.getLineHeight();
    const cw = this._cb.getCharWidth();
    const scroller = this._cb.getScroller();
    if (!lh || !cw || !scroller) return;

    const scrollerOffsetTop = scroller.offsetTop;
    const scrollerOffsetLeft = scroller.offsetLeft;
    const pixelTopForRow = this._cb.getPixelTopForRow();
    const pixelTop = (pixelTopForRow
      ? pixelTopForRow(screenPosition.row)
      : screenPosition.row * lh) - scroller.scrollTop;
    const fallbackPixelLeft = screenPosition.column * cw - scroller.scrollLeft;
    const measuredLeft = measuredOverlayLeftForScreenPosition(
      this._cb.getElement(),
      screenPosition.row,
      screenPosition.column,
      cw
    );
    const leftIsViewportRelative = measuredLeft != null;

    let top = scrollerOffsetTop + pixelTop + lh;
    let left = leftIsViewportRelative
      ? measuredLeft
      : scrollerOffsetLeft + fallbackPixelLeft;

    const itemEl = wrapperEl.firstChild;
    if (itemEl) {
      const itemRect = itemEl.getBoundingClientRect();
      const editorRect = this._cb.getElement().getBoundingClientRect();
      const windowH = window.innerHeight;
      const windowW = window.innerWidth;
      const absTop = editorRect.top + top;
      if (absTop + itemRect.height > windowH) {
        const flippedTop = scrollerOffsetTop + pixelTop - itemRect.height;
        if (editorRect.top + flippedTop >= 0) top = flippedTop;
      }

      if (props.avoidOverflow !== false) {
        const computedStyle = window.getComputedStyle(itemEl);
        const marginLeft = parseInt(computedStyle.marginLeft, 10) || 0;
        const itemLeft = leftIsViewportRelative
          ? left + marginLeft
          : editorRect.left + left + marginLeft;
        const itemRight = itemLeft + itemRect.width;
        if (itemLeft < 0) {
          left -= itemLeft;
        } else if (itemRight > windowW) {
          left -= itemRight - windowW;
        }
      }
    }

    wrapperEl.style.top = Math.round(top) + 'px';
    wrapperEl.style.left = Math.round(left) + 'px';
  }

  _remove(decoration, entry) {
    if (!entry) return;
    const { wrapperEl, resizeObserver, destroySub, markerSub } = entry;
    resizeObserver.disconnect();
    if (destroySub) destroySub.dispose();
    if (markerSub) markerSub.dispose();
    if (wrapperEl.parentNode) wrapperEl.parentNode.removeChild(wrapperEl);
    this._map.delete(decoration);
  }
}

// ---------------------------------------------------------------------------
// Shared utility
// ---------------------------------------------------------------------------

function isNodeConnected(node) {
  if (!node) return false;
  if (node.isConnected != null) return node.isConnected;
  return document.documentElement.contains(node);
}

module.exports = {
  computeSortedBlocks,
  computeLineNumDecoClasses,
  computeHighlightDecos,
  BlockDecorations,
  OverlayDecorations
};
