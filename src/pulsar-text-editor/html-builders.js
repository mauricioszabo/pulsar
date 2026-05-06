'use strict';

const { walkScreenLineTags } = require('../screen-line-tag-walker');

const NBSP = ' ';

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Build the inner HTML for a `.line` div by walking the tag stream.
// `visibleColumnRange` (when non-null) is forwarded to the walker so only
// text-run spans for columns inside the viewport reach the DOM — this keeps
// the DOM small for very long lines (e.g. minified JS).
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

// Build inner HTML for the plain-text fast path used by very long lines.
// No syntax highlighting — exists so opening a 1.3 MB minified-JS line
// stays responsive when the language mode would take seconds to produce scope
// info. Column-range virtualization still applies so the DOM stays small.
function buildPlainLineHtml(text, visibleColumnRange) {
  if (!text || text.length === 0) return NBSP;
  if (visibleColumnRange) {
    const [from, to] = visibleColumnRange;
    const clipped = text.substring(Math.max(0, from), Math.min(text.length, to));
    return clipped.length > 0 ? escapeHtml(clipped) : NBSP;
  }
  return escapeHtml(text);
}

// Apply a line / line-number decoration's `class` to every row it
// intersects, accumulating into `byRow: Map<row, className>`.
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

// Convert a screen-range into a list of absolutely-positioned rect
// descriptors. Callers map these to `.region` divs inside a `.selection`
// or `.highlight` wrapper. `topForRow` is the block-decoration-aware pixel
// top accessor so highlights/selections stay aligned with line text.
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
  // Top partial line (start.col → end of line).
  rects.push({ top: topForRow(start.row), left: start.column * cw, right: 0, width: null, height: lh });
  // Full middle lines (block decorations can diverge tops from uniform lh step).
  for (let r = start.row + 1; r < end.row; r++) {
    rects.push({ top: topForRow(r), left: 0, right: 0, width: null, height: lh });
  }
  // Bottom partial line (0 → end.col).
  if (end.column > 0) {
    rects.push({ top: topForRow(end.row), left: 0, width: end.column * cw, right: null, height: lh });
  }
  return rects;
}

module.exports = {
  NBSP,
  escapeHtml,
  buildLineHtml,
  buildPlainLineHtml,
  applyLineDecoration,
  rangeToRects
};
