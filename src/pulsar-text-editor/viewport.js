'use strict';

// How many extra rows to render beyond the visible viewport on each side.
const OVERSCAN = 10;
// Extra columns beyond the visible horizontal viewport.
const COLUMN_OVERSCAN = 64;
// Lines longer than this trigger column-range virtualization.
const LONG_LINE_THRESHOLD = 10000;
// Lines longer than this skip the language mode and render as plain text.
const PLAIN_TEXT_THRESHOLD = 100000;

// Given a pixel offset from the top of the content, return the screen row
// that contains that pixel. Block decorations make this non-linear: each
// block adds height between rows, so we walk sortedBlocks to accumulate
// the extra offset and find the right row.
function rowAtPixel(pixel, lineHeight, totalRows, sortedBlocks) {
  if (!lineHeight) return 0;
  let extraSoFar = 0;
  let bi = 0;
  for (let row = 0; row < totalRows; row++) {
    while (bi < sortedBlocks.length && sortedBlocks[bi].row === row && sortedBlocks[bi].position === 'before') {
      extraSoFar += sortedBlocks[bi].height;
      bi++;
    }
    while (bi < sortedBlocks.length && sortedBlocks[bi].row === row && sortedBlocks[bi].position === 'after') {
      extraSoFar += sortedBlocks[bi].height;
      bi++;
    }
    if (pixel < (row + 1) * lineHeight + extraSoFar) return row;
  }
  return Math.max(0, totalRows - 1);
}

function computeFirstRenderedRow(scrollTop, lineHeight, totalRows, sortedBlocks) {
  if (!lineHeight) return 0;
  return Math.max(0, rowAtPixel(scrollTop, lineHeight, totalRows, sortedBlocks) - OVERSCAN);
}

function computeLastRenderedRow(scrollTop, viewportHeight, lineHeight, totalRows, sortedBlocks) {
  if (!lineHeight) return Math.min(totalRows > 0 ? totalRows - 1 : 0, OVERSCAN * 2);
  return Math.min(
    totalRows > 0 ? totalRows - 1 : 0,
    rowAtPixel(scrollTop + viewportHeight, lineHeight, totalRows, sortedBlocks) + OVERSCAN
  );
}

function computeVisibleColumnRange(scrollLeft, viewportWidth, charWidth) {
  const cw = charWidth || 8;
  const vw = viewportWidth || (typeof window !== 'undefined' ? window.innerWidth : 1024);
  const startCol = Math.max(0, Math.floor(scrollLeft / cw) - COLUMN_OVERSCAN);
  const endCol = Math.ceil((scrollLeft + vw) / cw) + COLUMN_OVERSCAN;
  return [startCol, endCol];
}

// Returns the visual top (relative to lines-wrapper) of screen row `row`,
// including the cumulative height of all block decorations that precede it.
// A block "precedes" row R when: its row < R, or its row === R and position === 'before'.
function pixelTopForRow(row, lineHeight, sortedBlocks) {
  const lh = lineHeight || 0;
  let extra = 0;
  for (let i = 0; i < sortedBlocks.length; i++) {
    const b = sortedBlocks[i];
    if (b.row > row) break;
    if (b.row === row && b.position !== 'before') break;
    extra += b.height;
  }
  return row * lh + extra;
}

// Bottom edge of row `row` — includes all 'after' blocks at that row.
function pixelBottomForRow(row, lineHeight, sortedBlocks) {
  const lh = lineHeight || 0;
  let extra = 0;
  for (let i = 0; i < sortedBlocks.length; i++) {
    const b = sortedBlocks[i];
    if (b.row > row) break;
    extra += b.height;
  }
  return row * lh + extra + lh;
}

// Top spacer reserves space for everything above the first rendered row:
// `first * lh` PLUS the height of every block strictly before `first`.
// Blocks AT `first` with position 'before' render inline, not in the spacer.
function computeTopSpacer(firstRenderedRow, lineHeight, sortedBlocks) {
  if (!lineHeight) return 0;
  let extra = 0;
  for (let i = 0; i < sortedBlocks.length; i++) {
    const b = sortedBlocks[i];
    if (b.row >= firstRenderedRow) break;
    extra += b.height;
  }
  return firstRenderedRow * lineHeight + extra;
}

// Bottom spacer reserves space for rows after `last`, plus blocks strictly
// below the rendered range. Blocks in [first, last] are rendered inline.
function computeBottomSpacer(lastRenderedRow, totalRows, lineHeight, sortedBlocks) {
  if (!lineHeight) return 0;
  let extra = 0;
  for (let i = 0; i < sortedBlocks.length; i++) {
    const b = sortedBlocks[i];
    if (b.row > lastRenderedRow) extra += b.height;
  }
  return Math.max(0, (totalRows - 1 - lastRenderedRow) * lineHeight + extra);
}

module.exports = {
  OVERSCAN,
  COLUMN_OVERSCAN,
  LONG_LINE_THRESHOLD,
  PLAIN_TEXT_THRESHOLD,
  rowAtPixel,
  computeFirstRenderedRow,
  computeLastRenderedRow,
  computeVisibleColumnRange,
  pixelTopForRow,
  pixelBottomForRow,
  computeTopSpacer,
  computeBottomSpacer
};
