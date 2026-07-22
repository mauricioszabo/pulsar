'use strict';

const { walkScreenLineTags } = require('../screen-line-tag-walker');
const { LONG_LINE_THRESHOLD, PLAIN_TEXT_THRESHOLD } = require('./viewport');

const NBSP = ' ';

const EMPTY_IDS = [];
// Reused scratch element for parsing a single token's HTML into a DOM node.
const TOKEN_SCRATCH =
  typeof document !== 'undefined' ? document.createElement('div') : null;

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

// Tree-sitter-optimized path (ADR 006, milestones M3/M4): each token is a
// SELF-CONTAINED span subtree that is a direct child of the line element:
//
//   <span data-ts-row=R data-ts-col=C class="scopeA">   ← outer scope
//     <span data-ts-row=R data-ts-col=C class="scopeB"> ← inner scope
//       <span data-ts-row=R data-ts-col=C>text</span>   ← class-less leaf
//     </span>
//   </span>
//
// Why nested (not one flat class list): theme CSS is written against Atom's
// nested structure — flattening every scope onto one class attribute makes
// selectors like `.syntax--function` match a token (e.g. a comma) merely
// *inside* a function and color it wrongly.
//
// Why self-contained per token (not scope spans shared across tokens): it makes
// each token an independently replaceable DOM node keyed by `data-ts-row`/
// `data-ts-col`, so an edit repaints only the token spans that actually changed
// (see `reconcileTokenDom`) instead of the whole line. Every span in a token's
// subtree carries that token's row/col, so `[data-ts-row][data-ts-col]` finds
// the whole token.
function buildTokenHtml(token, languageMode, row) {
  const attrs = ' data-ts-row="' + row + '" data-ts-col="' + token.column + '"';
  const ids = token.scopeIds || [];
  let open = '';
  let close = '';
  for (const id of ids) {
    const cls = languageMode.classNameForScopeId(id);
    open += '<span' + attrs + (cls ? ' class="' + escapeHtml(cls) + '"' : '') + '>';
    close = '</span>' + close;
  }
  return open + '<span' + attrs + '>' + escapeHtml(token.text) + '</span>' + close;
}

function buildTokensLineHtml(tokens, languageMode, row) {
  if (!tokens || tokens.length === 0) return NBSP;
  let html = '';
  let hasText = false;
  for (const token of tokens) {
    if (!token.text) continue;
    hasText = true;
    html += buildTokenHtml(token, languageMode, row);
  }
  return hasText ? html : NBSP;
}

function scopeIdsEqual(a, b) {
  a = a || EMPTY_IDS;
  b = b || EMPTY_IDS;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Two tokens render to the same subtree (ignoring position) when their text and
// scope stack match. Position differences are patched cheaply via `data-ts-col`.
function tokenContentEqual(a, b) {
  return a.text === b.text && scopeIdsEqual(a.scopeIds, b.scopeIds);
}

function setTokenColumn(node, column) {
  if (!node || node.nodeType !== 1) return;
  const c = String(column);
  if (node.getAttribute('data-ts-col') !== c) node.setAttribute('data-ts-col', c);
  const inner = node.querySelectorAll('[data-ts-col]');
  for (let i = 0; i < inner.length; i++) {
    if (inner[i].getAttribute('data-ts-col') !== c) inner[i].setAttribute('data-ts-col', c);
  }
}

function buildTokenNode(token, languageMode, row) {
  TOKEN_SCRATCH.innerHTML = buildTokenHtml(token, languageMode, row);
  return TOKEN_SCRATCH.firstChild;
}

// Pure diff: given the currently-rendered token list and the new one, return
// the common-prefix length `p` and common-suffix length `s` (matched by content,
// ignoring column). Tokens [0,p) and the last `s` are content-identical to what
// is already in the DOM; tokens in the middle [p, len-s) differ and must be
// rebuilt. Kept separate from the DOM work so it can be unit-tested.
function planTokenReconcile(oldTokens, newTokens) {
  const oldLen = oldTokens.length;
  const newLen = newTokens.length;
  let p = 0;
  while (p < oldLen && p < newLen && tokenContentEqual(oldTokens[p], newTokens[p])) p++;
  let s = 0;
  while (
    s < (oldLen - p) && s < (newLen - p) &&
    tokenContentEqual(oldTokens[oldLen - 1 - s], newTokens[newLen - 1 - s])
  ) s++;
  return { p, s, oldLen, newLen };
}

// Mutate `el`'s children in place so they match `newTokens`, touching only the
// token subtrees that actually changed. `oldTokens` is what `el` currently
// renders (one child per token, in order). Unchanged tokens keep their exact
// DOM nodes; tokens that only shifted column get a `data-ts-col` update; only
// genuinely different tokens are rebuilt.
function reconcileTokenDom(el, oldTokens, newTokens, languageMode, row) {
  const kids = [];
  for (let n = el.firstChild; n; n = n.nextSibling) kids.push(n);
  // If the DOM child count doesn't match the cached token list, our assumptions
  // are off — rebuild wholesale rather than corrupt the line.
  if (kids.length !== oldTokens.length) {
    el.innerHTML = buildTokensLineHtml(newTokens, languageMode, row);
    return;
  }

  const { p, s, oldLen, newLen } = planTokenReconcile(oldTokens, newTokens);

  // Prefix/suffix content matched — only positions may have shifted.
  for (let i = 0; i < p; i++) {
    if (oldTokens[i].column !== newTokens[i].column) setTokenColumn(kids[i], newTokens[i].column);
  }
  for (let k = 0; k < s; k++) {
    const oldIdx = oldLen - 1 - k;
    const newCol = newTokens[newLen - 1 - k].column;
    if (oldTokens[oldIdx].column !== newCol) setTokenColumn(kids[oldIdx], newCol);
  }

  // Replace the differing middle [p, len-s) — the only spans repainted.
  const refNode = (oldLen - s < oldLen) ? kids[oldLen - s] : null;
  for (let i = p; i < oldLen - s; i++) el.removeChild(kids[i]);
  if (newLen - s > p) {
    const frag = document.createDocumentFragment();
    for (let i = p; i < newLen - s; i++) {
      frag.appendChild(buildTokenNode(newTokens[i], languageMode, row));
    }
    el.insertBefore(frag, refNode);
  }
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
      tokenSource, tokenDirty,
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
    // The tree-sitter path renders every row from tokens and has no display
    // layer, so the plain-text long-line fallback (which needs one) is skipped.
    const canUsePlain = tokenSource
      ? false
      : this._supportsPlainText(model, buffer, displayLayer);
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
      newEls.push(this._getOrUpdateLineEl(item, { charWidth, lineHeight, visColRange, displayLayer, cursorRows, tokenSource, tokenDirty }));
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
    if (!displayLayer) return false;
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

  _getOrUpdateLineEl(item, { charWidth, lineHeight, visColRange, displayLayer, cursorRows, tokenSource, tokenDirty }) {
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

    const lh = lineHeight;
    const cw = charWidth;
    const heightStyle = lh ? 'height: ' + lh + 'px; overflow: hidden; ' : '';

    // Tree-sitter-optimized path (M3 render + M4 incremental repaint).
    // Each token is a self-contained span subtree. Scopes are computed from
    // column 0 so highlighting is stable under horizontal scroll; only the
    // tokens reaching the visible window are emitted, offset with padding-left.
    if (item.mode === 'tokens') {
      const from = visColRange ? Math.max(0, visColRange[0]) : 0;
      const to = visColRange ? visColRange[1] : Infinity;

      const windowChanged = el._tsFrom !== from || el._tsTo !== to;
      const rowDirty = !tokenDirty ||
        tokenDirty.full ||
        item.row >= tokenDirty.fromRow ||
        (tokenDirty.rows && tokenDirty.rows.has(item.row));

      // Nothing about this row changed and the visible window is the same — the
      // existing spans are still correct, so don't touch the DOM (this is the
      // common case: renders caused only by cursor/selection movement).
      if (el._tokens != null && !windowChanged && !rowDirty) {
        return el;
      }

      const newTokens = tokenSource.getScreenLineTokens(item.row, from, to);

      let leftPad = 0;
      if (newTokens == null) {
        // Tree not parsed yet: plain buffer text for the visible window only.
        const buffer = tokenSource.buffer;
        const len = buffer ? (buffer.lineLengthForRow(item.row) || 0) : 0;
        const winFrom = Math.min(from, len);
        const winTo = Math.min(len, to);
        const text = winFrom < winTo
          ? buffer.getTextInRange([[item.row, winFrom], [item.row, winTo]])
          : '';
        leftPad = text ? winFrom * (cw || 0) : 0;
        const html = text ? escapeHtml(text) : NBSP;
        if (el.innerHTML !== html) el.innerHTML = html;
        el._tokens = null;
      } else {
        leftPad = (newTokens.length > 0 ? newTokens[0].column : 0) * (cw || 0);
        if (el._tokens == null || windowChanged) {
          // First paint for this row (or the window moved): build all spans.
          el.innerHTML = buildTokensLineHtml(newTokens, tokenSource, item.row);
        } else {
          // Incremental: repaint only the token spans that actually changed.
          reconcileTokenDom(el, el._tokens, newTokens, tokenSource, item.row);
        }
        el._tokens = newTokens;
      }

      el._tsFrom = from;
      el._tsTo = to;
      const style = cw
        ? heightStyle + 'padding-left: ' + leftPad + 'px; min-width: ' + (item.lineLength * cw) + 'px;'
        : heightStyle;
      if (el.style.cssText !== style) el.style.cssText = style;
      return el;
    }

    // Style (non-token modes).
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
// Exposed for unit tests of the incremental-repaint diff.
module.exports._test = {
  planTokenReconcile, tokenContentEqual, buildTokenHtml,
  buildTokensLineHtml, reconcileTokenDom
};
