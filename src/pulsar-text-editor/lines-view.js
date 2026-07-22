'use strict';

const { walkScreenLineTags } = require('../screen-line-tag-walker');
const { LONG_LINE_THRESHOLD, PLAIN_TEXT_THRESHOLD } = require('./viewport');

const NBSP = ' ';

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildLineHtml(screenLine, displayLayer, visibleColumnRange) {
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
    visibleColumnRange,
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

function buildPlainLineHtml(text, visibleColumnRange) {
  if (!text || text.length === 0) return NBSP;
  if (visibleColumnRange) {
    const [from, to] = visibleColumnRange;
    const clipped = text.substring(Math.max(0, from), Math.min(text.length, to));
    return clipped.length > 0 ? escapeHtml(clipped) : NBSP;
  }
  return escapeHtml(text);
}

// Tree-sitter-optimized path (ADR 006, milestone M3): build a line's HTML from
// flat tokens produced by `languageMode.getScreenLineTokens`. Each token becomes
// a single <span> tagged with its buffer `data-ts-row`/`data-ts-col`, all of its
// active scopes flattened into the class list. Only the columns the tokenizer
// returned (the visible window) are emitted; the enclosing line's `padding-left`
// (set by the caller, as for 'long' lines) positions the window horizontally.
function buildTokensLineHtml(tokens, languageMode, row) {
  if (!tokens || tokens.length === 0) return NBSP;
  let html = '';
  let hasText = false;
  for (const token of tokens) {
    if (!token.text) continue;
    hasText = true;
    let classes = '';
    if (token.scopeIds && token.scopeIds.length > 0) {
      classes = token.scopeIds
        .map((id) => languageMode.classNameForScopeId(id))
        .filter(Boolean)
        .join(' ');
    }
    html += '<span data-ts-row="' + row + '" data-ts-col="' + token.column + '"';
    if (classes) html += ' class="' + escapeHtml(classes) + '"';
    html += '>' + escapeHtml(token.text) + '</span>';
  }
  return hasText ? html : NBSP;
}

const LINE_CACHE_SLACK = 200;

// Manages all DOM content inside the `.lines-wrapper` scroll container:
//   topSpacer → [before-blocks, line, after-blocks]... → bottomSpacer → placeholder
//
// The highlights and cursors overlay divs are created externally (by the
// component) and appended after bottomSpacer; this class does not touch them.
class LinesView {
  constructor(linesWrapper, options = {}) {
    this._linesWrapper = linesWrapper;
    this._onBlockDecorationResize = options.onBlockDecorationResize;

    // Spacers are always present as fixed reference points.
    this._topSpacerEl = document.createElement('div');
    this._topSpacerEl.style.display = 'block';
    linesWrapper.appendChild(this._topSpacerEl);

    this._bottomSpacerEl = document.createElement('div');
    this._bottomSpacerEl.style.display = 'block';
    linesWrapper.appendChild(this._bottomSpacerEl);

    this._placeholderEl = null;

    // Keyed DOM nodes.
    this._lineEls = new Map();   // screenRow → HTMLElement
    this._blockEls = new Map();  // blockInfo → HTMLElement
    this._blockInfosByEl = new Map(); // HTMLElement → blockInfo
    this._blockResizeObserver = null;

    if (typeof ResizeObserver !== 'undefined' && this._onBlockDecorationResize) {
      this._blockResizeObserver = new ResizeObserver(entries => {
        for (const entry of entries) {
          const info = this._blockInfosByEl.get(entry.target);
          if (info) this._onBlockDecorationResize(info);
        }
      });
    }

    // Line wrapper cache: same structure as Solid's lineCache — avoids
    // rebuilding the screenLine object on every tokenization tick.
    this._lineCache = new Map(); // screenRow → wrapper
  }

  // Call this on every render frame with fresh computed state.
  update(state) {
    const {
      firstRow, lastRow, model, displayLayer,
      sortedBlocks, topSpacer, bottomSpacer,
      charWidth, lineHeight, visColRange,
      cursorRows, placeholderText, longestLineWidth,
      tokenSource,
    } = state;

    if (!model || (model.isDestroyed && model.isDestroyed())) return;

    // Update spacer heights.
    const topPx = topSpacer + 'px';
    if (this._topSpacerEl.style.height !== topPx) this._topSpacerEl.style.height = topPx;
    const botPx = bottomSpacer + 'px';
    if (this._bottomSpacerEl.style.height !== botPx) this._bottomSpacerEl.style.height = botPx;

    // Drive the scroll container's horizontal extent.
    const mw = 'max(100%, ' + longestLineWidth + 'px)';
    if (this._linesWrapper.style.minWidth !== mw) this._linesWrapper.style.minWidth = mw;

    // Compute visible screen line wrappers (with caching, same as Solid).
    const buffer = model.getBuffer ? model.getBuffer() : model.buffer;
    const canUsePlain = this._supportsPlainText(model, buffer, displayLayer);
    const visibleItems = [];

    for (let r = firstRow; r <= lastRow; r++) {
      let item;

      if (tokenSource) {
        // Tree-sitter-optimized path: tokens come directly from the language
        // mode's windowed tokenizer, and the line length comes straight from
        // the buffer — no display-layer screen-line query at all. The cached
        // item's identity is stable; the token HTML is rebuilt from the visible
        // column window on each render (M3 is non-incremental — M4 adds
        // change-driven repainting).
        const tsBuffer = tokenSource.buffer;
        const length = tsBuffer
          ? tsBuffer.lineLengthForRow(r) || 0
          : model.lineLengthForScreenRow(r);
        const cached = this._lineCache.get(r);
        if (cached && cached.mode === 'tokens' && cached.lineLength === length) {
          item = cached;
        } else {
          item = { row: r, mode: 'tokens', lineLength: length };
          this._lineCache.set(r, item);
        }
        visibleItems.push(item);
        continue;
      }

      const length = model.lineLengthForScreenRow(r);
      if (canUsePlain && length > PLAIN_TEXT_THRESHOLD) {
        const bufRow = model.bufferRowForScreenRow(r);
        const text = buffer.lineForRow(bufRow);
        const cached = this._lineCache.get(r);
        if (cached && cached.mode === 'plain' && cached.lineText === text && cached.lineLength === length) {
          item = cached;
        } else {
          item = { row: r, mode: 'plain', lineText: text, lineLength: length };
          this._lineCache.set(r, item);
        }
      } else {
        const screenLine = model.screenLineForScreenRow(r);
        const mode = length > LONG_LINE_THRESHOLD ? 'long' : 'short';
        const cached = this._lineCache.get(r);
        if (cached && cached.mode === mode && cached.screenLine === screenLine) {
          item = cached;
        } else {
          item = { row: r, mode, screenLine, lineLength: length };
          this._lineCache.set(r, item);
        }
      }
      visibleItems.push(item);
    }

    // Prune stale cache entries.
    if (this._lineCache.size > (lastRow - firstRow + 1) + LINE_CACHE_SLACK) {
      const keepFrom = firstRow - LINE_CACHE_SLACK / 2;
      const keepTo = lastRow + LINE_CACHE_SLACK / 2;
      for (const k of this._lineCache.keys()) {
        if (k < keepFrom || k > keepTo) this._lineCache.delete(k);
      }
    }

    // Build flat ordered list of elements: [beforeBlocks, line, afterBlocks...].
    const newEls = [];
    for (const item of visibleItems) {
      const row = item.row;
      for (const b of this._blocksAtRow(row, 'before', sortedBlocks)) {
        newEls.push(this._getOrUpdateBlockEl(b));
      }
      newEls.push(this._getOrUpdateLineEl(item, { charWidth, lineHeight, visColRange, displayLayer, cursorRows, tokenSource }));
      for (const b of this._blocksAtRow(row, 'after', sortedBlocks)) {
        newEls.push(this._getOrUpdateBlockEl(b));
      }
    }

    // Remove stale line elements from the keyed map (DOM removal happens in reconcile).
    const visRowSet = new Set(visibleItems.map(i => i.row));
    for (const row of this._lineEls.keys()) {
      if (!visRowSet.has(row)) this._lineEls.delete(row);
    }
    // Determine which block infos are still in use this render.
    const usedBlocks = new Set();
    for (const item of visibleItems) {
      for (const b of this._blocksAtRow(item.row, 'before', sortedBlocks)) usedBlocks.add(b);
      for (const b of this._blocksAtRow(item.row, 'after', sortedBlocks)) usedBlocks.add(b);
    }
    for (const info of this._blockEls.keys()) {
      if (!usedBlocks.has(info)) this._removeBlockEl(info);
    }

    this._reconcile(newEls);
    this._updatePlaceholder(placeholderText);
  }

  // ---- helpers ----

  _supportsPlainText(model, buffer, displayLayer) {
    if (!buffer) return false;
    if (model.isSoftWrapped && model.isSoftWrapped()) return false;
    const folds = displayLayer.foldsMarkerLayer;
    if (folds && folds.getMarkerCount && folds.getMarkerCount() > 0) return false;
    return true;
  }

  _blocksAtRow(row, position, sortedBlocks) {
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
      el.className = 'block-decoration';
      this._blockEls.set(blockInfo, el);
      this._blockInfosByEl.set(el, blockInfo);
      if (this._blockResizeObserver) this._blockResizeObserver.observe(el);
    }
    blockInfo.wrapperElement = el;
    // Re-attach the item element if it moved (appendChild of already-attached
    // node moves it from its previous parent — intentional same as Solid).
    const item = blockInfo.element;
    if (item && item.nodeType === 1 && item.parentNode !== el) {
      el.appendChild(item);
    }
    return el;
  }

  _removeBlockEl(blockInfo) {
    const el = this._blockEls.get(blockInfo);
    if (!el) return;
    if (this._blockResizeObserver) this._blockResizeObserver.unobserve(el);
    this._blockInfosByEl.delete(el);
    this._blockEls.delete(blockInfo);
    if (blockInfo.wrapperElement === el) blockInfo.wrapperElement = null;
  }

  _getOrUpdateLineEl(item, { charWidth, lineHeight, visColRange, displayLayer, cursorRows, tokenSource }) {
    let el = this._lineEls.get(item.row);
    if (!el) {
      el = document.createElement('div');
      this._lineEls.set(item.row, el);
    }

    // Class.
    let cls = 'line';
    if (cursorRows.has(item.row)) cls += ' cursor-line';
    if (el.className !== cls) el.className = cls;

    // data-screen-row.
    if (el.dataset.screenRow !== String(item.row)) el.dataset.screenRow = item.row;

    // Style.
    const lh = lineHeight;
    const cw = charWidth;
    const heightStyle = lh ? 'height: ' + lh + 'px; overflow: hidden; ' : '';
    let style;
    if (!cw) {
      style = heightStyle;
    } else if (item.mode === 'short') {
      style = heightStyle + 'min-width: ' + (item.lineLength * cw) + 'px;';
    } else {
      const leftPad = visColRange ? Math.max(0, visColRange[0]) * cw : 0;
      style = heightStyle +
        'padding-left: ' + leftPad + 'px; ' +
        'min-width: ' + (item.lineLength * cw) + 'px;';
    }
    if (el.style.cssText !== style) el.style.cssText = style;

    // Tree-sitter-optimized path: rebuild token spans from the windowed
    // tokenizer every render (non-incremental; M4 will cache/repaint by change).
    if (item.mode === 'tokens') {
      const from = visColRange ? Math.max(0, visColRange[0]) : 0;
      const to = visColRange ? visColRange[1] : Infinity;
      const tokens = tokenSource.getScreenLineTokens(item.row, from, to);
      if (tokens == null) {
        // Tree not ready this frame; fall back to plain buffer text so the
        // line isn't blank.
        const buffer = tokenSource.buffer;
        const text = buffer ? buffer.lineForRow(item.row) : '';
        el.innerHTML = buildPlainLineHtml(text, visColRange);
      } else {
        el.innerHTML = buildTokensLineHtml(tokens, tokenSource, item.row);
      }
      return el;
    }

    // HTML — only update if the content actually changed.
    // For 'short' lines the key is the cached screenLine object; for
    // 'long'/'plain' the rendered slice also depends on the visible column
    // range.
    const colKey = (item.mode !== 'short' && visColRange)
      ? visColRange[0] + ',' + visColRange[1]
      : '';
    const needsHtml = el._lastItem !== item || el._lastColKey !== colKey;
    if (needsHtml) {
      let html;
      if (item.mode === 'plain') {
        html = buildPlainLineHtml(item.lineText, visColRange);
      } else if (item.mode === 'long') {
        html = buildLineHtml(item.screenLine, displayLayer, visColRange);
      } else {
        html = buildLineHtml(item.screenLine, displayLayer, null);
      }
      el.innerHTML = html;
      el._lastItem = item;
      el._lastColKey = colKey;
    }

    return el;
  }

  // Reconcile variable content (everything between topSpacer and bottomSpacer)
  // with `newEls`, reusing existing nodes and leaving already-ordered nodes in
  // place. This keeps cursor blink / selection-only renders from detaching and
  // reattaching every visible line.
  _reconcile(newEls) {
    const wrapper = this._linesWrapper;
    const newElSet = new Set(newEls);

    let child = this._topSpacerEl.nextSibling;

    for (const el of newEls) {
      while (child && child !== this._bottomSpacerEl && !newElSet.has(child)) {
        const next = child.nextSibling;
        wrapper.removeChild(child);
        child = next;
      }

      if (child === el) {
        child = child.nextSibling;
      } else {
        wrapper.insertBefore(
          el,
          child && child !== this._bottomSpacerEl ? child : this._bottomSpacerEl
        );
        child = el.nextSibling;
      }
    }

    while (child && child !== this._bottomSpacerEl) {
      const next = child.nextSibling;
      wrapper.removeChild(child);
      child = next;
    }
  }

  _updatePlaceholder(text) {
    if (text != null) {
      if (!this._placeholderEl) {
        this._placeholderEl = document.createElement('div');
        this._placeholderEl.className = 'placeholder-text';
        this._placeholderEl.style.cssText = 'position: absolute; top: 0; left: 0;';
        this._linesWrapper.appendChild(this._placeholderEl);
      }
      if (this._placeholderEl.textContent !== text) this._placeholderEl.textContent = text;
    } else if (this._placeholderEl) {
      if (this._placeholderEl.parentNode) {
        this._placeholderEl.parentNode.removeChild(this._placeholderEl);
      }
      this._placeholderEl = null;
    }
  }
}

module.exports = LinesView;
