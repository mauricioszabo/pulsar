'use babel';

// SolidJS-based TextEditorComponent — Commit D (feature-complete MVP).
//
// Features in this commit:
//  - Line number gutter with buffer-row numbers and soft-wrap dots.
//  - Viewport virtualization: only the rows currently visible in the
//    scroll viewport (plus OVERSCAN rows of padding above/below) are
//    rendered. Top and bottom spacer divs fill the rest of the
//    content height so native scrollbars are correctly sized.
//  - Correct layout: the gutter sticks to the left via CSS
//    `position: sticky; left: 0` and lines use a block flow layout,
//    so the browser establishes the content width naturally from the
//    longest rendered line. No more `width: 1px` starvation.
//  - Correct syntax highlighting via the existing `walkScreenLineTags`
//    walker, same as the legacy editor.
//  - Selections rendered as `.selection > .region` rects so the
//    existing core CSS (`@syntax-selection-color`) applies.
//  - Blinking cursor via `.cursors.blink-off` toggle, controlled by
//    the existing core CSS rule.
//  - Mouse support: click to position cursor; shift-click extends
//    selection; double/triple-click selects word/line; drag selection.
//  - Autoscroll: `didRequestAutoscroll` drives vertical and horizontal
//    scroll to keep the cursor in view after any movement.
//  - Focus: `element.focus()` is wrapped to (1) call native focus —
//    so the element's `focus` event fires for autocomplete-plus and
//    other packages that key off `editorView.addEventListener
//    ('focus', …)` — and (2) explicitly forward to the hidden input
//    so keystrokes have a target even on flows where the focus event
//    listener doesn't fire reliably (e.g. atom-select-list inside a
//    just-shown panel). `didBlur` calls `stopImmediatePropagation()`
//    when the blur is just due to focus transferring to our hidden
//    input, preventing downstream listeners (atom-select-list's
//    `didLoseFocus`) from misinterpreting it as a real blur.
//  - Measurement: line height is taken from a block wrapper (not
//    just the inline character), so the full rendered line height
//    including leading is captured. Character width is averaged over
//    100 characters to eliminate per-character subpixel rounding.

const { render, For, Show } = require('solid-js/web');
const {
  createSignal,
  createMemo,
  onMount,
  onCleanup
} = require('solid-js');

const { walkScreenLineTags } = require('../screen-line-tag-walker');

let TextEditor = null;
let TextEditorElement = null;

// How many extra rows to render beyond the visible viewport on each side.
const OVERSCAN = 10;
// How many extra columns to render beyond the visible horizontal viewport
// on each side. Mirrors the legacy editor's
// LONG_LINE_VIRTUALIZATION_OVERSCAN.
const COLUMN_OVERSCAN = 64;
// Lines longer than this trigger column-range virtualization: only the
// portion of the line currently visible horizontally is materialized in
// the DOM. Mirrors the legacy editor's
// LONG_LINE_VIRTUALIZATION_THRESHOLD and the existing tree-sitter
// highlighting limit.
const LONG_LINE_THRESHOLD = 10000;
// Lines longer than this skip the language mode entirely and render as
// plain text. Without this, opening a 1.3 MB minified-JS line takes
// ~18 s — the time is spent inside `ts_query_cursor_next_capture` /
// scope-resolver building scope info for the whole line, not in our
// own DOM emission. Plain text loses syntax highlighting on those
// lines but keeps the editor responsive; column-range virtualization
// (above) still applies so the DOM stays small too.
const PLAIN_TEXT_THRESHOLD = 100000;
const CURSOR_BLINK_PERIOD = 800;
const CURSOR_BLINK_RESUME_DELAY = 300;
const DEFAULT_VERTICAL_SCROLL_MARGIN = 2;
const DEFAULT_HORIZONTAL_SCROLL_MARGIN = 6;
const NBSP = ' ';

// ---------------------------------------------------------------------------
// HTML building helpers
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Build the inner HTML for a `.line` div by walking the tag stream.
// Returns a plain HTML string suitable for `innerHTML`.
//
// `visibleColumnRange` (when non-null) is forwarded to the walker, which
// emits scope opens/closes as before but only emits text-run spans for
// columns that intersect the viewport. For very long lines (e.g. minified
// JS) this reduces DOM nodes from O(line length) to O(viewport width),
// which keeps layout/paint fast even when the editor's content is wider
// than the viewport.
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
// No syntax highlighting, no language-mode involvement — this exists to
// make opening a buffer with one giant line responsive even when the
// language mode would take seconds to produce scope info for the line.
// `visibleColumnRange` clips the rendered text to a window around the
// viewport for the same DOM-size reasons as `buildLineHtml`.
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
//
// Honors the same filtering knobs as the legacy editor:
//   * `onlyEmpty` / `onlyNonEmpty` — skip if the marker's screen range
//     doesn't match.
//   * `onlyHead` — apply only to the row containing the marker's head.
//   * `omitEmptyLastRow` (default true) — when the screen range ends
//     at column 0 of a row, that row is excluded.
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

// ---------------------------------------------------------------------------
// Solid components
// ---------------------------------------------------------------------------

// Render a single block decoration. Block decorations carry an `item`
// (a DOM element or model with `.element`); we attach it under a
// wrapper div via `ref` so Solid removes the wrapper (and the item with
// it) when the row scrolls out of the rendered viewport.
//
// Re-attaching on every mount is intentional: the SAME `item` element
// might be moved between wrappers as the row enters/leaves the
// rendered window — `appendChild` of an already-attached node implicitly
// removes it from its previous parent, so this Just Works.
function BlockDecoration(props) {
  return (
    <div
      class="block-decoration"
      ref={(el) => {
        const item = props.block.element;
        if (item && el && item.parentNode !== el) {
          el.appendChild(item);
        }
      }}
    />
  );
}

// One screen line. Uses innerHTML so the span nesting from the tag
// walker is applied as a single DOM mutation rather than a tree of
// Solid components.
//
// Three rendering modes, picked from `item.mode`:
//   * 'short'   — full line, no virtualization. Default for normal-
//                 length lines; identical to the original behavior.
//   * 'long'    — line is wider than the viewport but short enough that
//                 the language mode produced tags for it. We pass the
//                 visible column range to the walker so only spans
//                 inside the viewport reach the DOM, then offset the
//                 line with a left padding equal to the skipped columns
//                 and set `min-width` to the line's full pixel width
//                 so horizontal scrolling still works.
//   * 'plain'   — line was so long the language mode would block the
//                 main thread for seconds. Skip syntax highlighting
//                 entirely; show clipped buffer text. Same padding /
//                 min-width treatment as 'long' so layout is correct.
function Line(props) {
  const html = createMemo(() => {
    const item = props.item;
    if (item.mode === 'plain') {
      return buildPlainLineHtml(item.lineText, props.visibleColumnRange());
    }
    if (item.mode === 'long') {
      return buildLineHtml(item.screenLine, props.displayLayer, props.visibleColumnRange());
    }
    return buildLineHtml(item.screenLine, props.displayLayer, null);
  });
  // Class composition:
  //   'line'                       — base
  //   ' cursor-line'               — primary cursor's row
  //   ' <line decoration class>'   — any `type:'line'` decorations
  //                                  intersecting this row
  const cls = () => {
    let c = 'line';
    if (props.cursorLine) c += ' cursor-line';
    if (props.extraClass) c += ' ' + props.extraClass;
    return c;
  };
  // Set min-width on every line so `contain: paint` (from the core CSS
  // `.line { contain: layout paint style }`) doesn't clip text that
  // extends past the line element's natural layout width. For 'short'
  // mode (no column virtualization) we just need min-width; for 'long'
  // and 'plain' we also add padding-left to shift the visible window.
  const style = () => {
    const item = props.item;
    const cw = props.charWidth();
    if (!cw) return '';
    const fullLen = item.lineLength;
    if (item.mode === 'short') {
      return 'min-width: ' + (fullLen * cw) + 'px;';
    }
    const range = props.visibleColumnRange();
    const leftPad = range ? Math.max(0, range[0]) * cw : 0;
    return 'padding-left: ' + leftPad + 'px; ' +
           'min-width: ' + (fullLen * cw) + 'px;';
  };
  return (
    <div
      class={cls()}
      data-screen-row={props.item.row}
      style={style()}
      // eslint-disable-next-line solid/no-innerhtml
      innerHTML={html()}
    />
  );
}

// One line-number cell in the gutter.
function LineNumber(props) {
  const cls = () => {
    let c = 'line-number';
    if (props.foldable) c += ' foldable';
    // line-number decorations (e.g. 'folded' from the folds marker layer)
    const decoClass = props.lineNumberDecoClasses
      ? props.lineNumberDecoClasses().get(props.row)
      : null;
    if (decoClass) c += ' ' + decoClass;
    return c;
  };
  // Number string: right-padded with NBSP to maxDigits width; soft-wrapped
  // rows show a bullet instead.
  const label = () => {
    if (!props.showLineNumbers) return '';
    const raw = props.softWrapped ? '•' : String(props.bufferRow + 1);
    return NBSP.repeat(Math.max(0, props.maxDigits - raw.length)) + raw;
  };
  return (
    <div class={cls()} data-screen-row={props.row}>
      <span class="line-number-text">{label()}</span>
      <div class="icon-right" />
    </div>
  );
}

// The left gutter containing line numbers. Lives OUTSIDE the scroll-view
// so it doesn't scroll horizontally. Vertical sync is achieved by applying
// translateY(-scrollTop) to the inner content, exactly as the legacy editor
// does.  The container clips content with `overflow: hidden`.
//
// Block decorations push lines down in the content area, so the gutter must
// insert matching spacer divs between line numbers so they stay aligned.
// We also expose the inner `.gutter` element via `props.gutterRef` so the
// scroll handler can update its transform imperatively (same frame as the
// scroll event, no SolidJS re-render lag) to prevent the one-frame shaking
// that results from the signal-driven translateY path.
//
// The flat item list merges visibleRows and sortedBlocks into a single
// memo so any change to either (new block added, block resized, row
// scrolled into view) triggers exactly one re-render of the <For>.
function GutterContainer(props) {
  // Flat list of gutter items: { type: 'line', ...rowData } or
  // { type: 'block', height }.  Built as a memo so it reacts to both
  // visibleRows and sortedBlocks changes.
  const gutterItems = createMemo(() => {
    const rows = props.visibleRows();
    const blocks = props.sortedBlocks();
    const items = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      for (let j = 0; j < blocks.length; j++) {
        const b = blocks[j];
        if (b.row === row.screenRow && b.position === 'before') {
          items.push({ type: 'block', height: b.height, key: b });
        }
      }
      items.push({ type: 'line', ...row });
      for (let j = 0; j < blocks.length; j++) {
        const b = blocks[j];
        if (b.row === row.screenRow && b.position === 'after') {
          items.push({ type: 'block', height: b.height, key: b });
        }
      }
    }
    return items;
  });

  return (
    <div
      class="gutter-container"
      style={
        'position: relative; z-index: 1; flex-shrink: 0; ' +
        'background-color: inherit; overflow: hidden; user-select: none;'
      }
    >
      <div
        ref={props.gutterRef}
        class="gutter line-numbers"
        style={
          'will-change: transform; ' +
          'transform: translateY(' + (-props.scrollTop()) + 'px);'
        }
      >
        <div style={`height: ${props.topSpacer()}px; display: block;`} />
        <For each={gutterItems()}>
          {(item) => (
            item.type === 'block'
              ? <div style={`height: ${item.height}px; display: block;`} />
              : <LineNumber
                  row={item.screenRow}
                  bufferRow={item.bufferRow}
                  softWrapped={item.softWrapped}
                  foldable={item.foldable}
                  lineNumberDecoClasses={props.lineNumberDecoClasses}
                  showLineNumbers={props.showLineNumbers()}
                  maxDigits={props.maxDigits()}
                />
          )}
        </For>
        <div style={`height: ${props.bottomSpacer()}px; display: block;`} />
      </div>
    </div>
  );
}

// Converts a screen-range into a list of absolutely-positioned rect
// descriptors. Callers map these to `.region` divs inside a `.selection`
// wrapper so the core CSS `@syntax-selection-color` rule applies.
//
// `topForRow` is the editor's `pixelTopForRow` accessor; it includes
// the cumulative height of any block decorations conceptually before
// each row, which keeps highlights aligned with the visible text once
// blocks are pushing rows down.
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
  // Full middle lines (if any). Each row gets its own rect because the
  // tops between them may diverge from a uniform `lh` step once block
  // decorations are accounted for.
  for (let r = start.row + 1; r < end.row; r++) {
    rects.push({
      top: topForRow(r),
      left: 0, right: 0, width: null,
      height: lh
    });
  }
  // Bottom partial line (0 → end.col).
  if (end.column > 0) {
    rects.push({ top: topForRow(end.row), left: 0, width: end.column * cw, right: null, height: lh });
  }
  return rects;
}

// Render one selection range as `.region` divs inside a `.selection`.
function SelectionHighlight(props) {
  const rects = createMemo(() => {
    const lh = props.lineHeight();
    const cw = props.charWidth();
    if (!lh || !cw) return [];
    return rangeToRects(props.range, lh, cw, props.topForRow);
  });
  return (
    <div class="highlight selection">
      <For each={rects()}>
        {(r) => (
          <div
            class="region"
            style={
              'position: absolute; box-sizing: border-box; ' +
              'top: ' + r.top + 'px; ' +
              'left: ' + r.left + 'px; ' +
              'height: ' + r.height + 'px; ' +
              (r.right != null ? 'right: 0; ' : 'width: ' + r.width + 'px; ')
            }
          />
        )}
      </For>
    </div>
  );
}

// Absolute-positioned cursor bar. Uses CSS `border-left` for the
// visible caret; opacity is controlled by `.is-focused .cursor` and
// `.cursors.blink-off .cursor` in core-ui/text-editor.less.
//
// `extraClass` and `extraStyle` come from `type: 'cursor'` decorations
// merged across the cursor's marker (vim-mode-plus uses these to shift
// the block cursor back inside the selection in visual mode, etc.).
//
// Positioning composition (matches legacy editor behavior):
//   * Base position is set via `transform: translate(...)` so it does
//     not collide with the decoration's `top` / `left` properties.
//   * The decoration's `top` / `left` (cursor-style-manager passes
//     deltas like `{ top: lineHeight * dRow + 'px', left: dCol + 'ch' }`)
//     then act as additional offsets, since `top`/`left` apply on top
//     of an already-translated absolutely-positioned element.
//   * Other style props (`visibility`, `width`, `background`, etc.) are
//     applied verbatim, overriding base values where they conflict.
function CursorBar(props) {
  const style = () => {
    const lh = props.lineHeight();
    const cw = props.charWidth();
    if (!lh || !cw) return { display: 'none' };
    const pos = props.position;
    if (!pos) return { display: 'none' };
    let baseX = pos.column * cw;
    // Use the editor's `pixelTopForRow` if provided so the cursor stays
    // aligned with the line text when block decorations push subsequent
    // rows down. Falls back to `pos.row * lh` when no helper is given
    // (which happens during the brief window before measurement).
    let baseY = props.topForRow ? props.topForRow(pos.row) : pos.row * lh;
    const extra = props.extraStyle;
    // vim-mode-plus passes `top`/`left` as delta strings (e.g. '-43px', '0ch').
    // These must be incorporated into the transform, not applied as absolute
    // CSS top/left (which would just shift from 0, not from the cursor position).
    let extraRest = null;
    if (extra) {
      if (extra.top != null) {
        const v = extra.top;
        if (typeof v === 'string' && v.endsWith('px')) baseY += parseFloat(v);
        else if (typeof v === 'number') baseY += v;
      }
      if (extra.left != null) {
        const v = extra.left;
        if (typeof v === 'string' && v.endsWith('ch')) baseX += parseFloat(v) * cw;
        else if (typeof v === 'string' && v.endsWith('px')) baseX += parseFloat(v);
        else if (typeof v === 'number') baseX += v;
      }
      // Pass through any other extra style props (e.g. visibility, width, background)
      const { top: _t, left: _l, ...rest } = extra;
      if (Object.keys(rest).length > 0) extraRest = rest;
    }
    const base = {
      position: 'absolute',
      top: 0,
      left: 0,
      width: cw + 'px',
      height: lh + 'px',
      transform: 'translate(' + baseX + 'px, ' + baseY + 'px)'
    };
    return extraRest ? Object.assign(base, extraRest) : base;
  };
  const cls = () => 'cursor' + (props.extraClass ? ' ' + props.extraClass : '');
  return <div class={cls()} style={style()} />;
}

// Top-level editor component.
function Editor(props) {
  const model = props.model;
  const component = props.component;
  const displayLayer = model.displayLayer;
  const buffer = model.getBuffer ? model.getBuffer() : model.buffer;
  // Soft-wrap or fold-aware files use buffer-row→screen-row translation
  // that diverges from identity, so the plain-text fast path can't safely
  // substitute `buffer.lineForRow(bufferRow)` for `screenLine.lineText`.
  // Cache an "is simple" flag once per render (refreshed on display
  // changes via the memo).
  const supportsPlainTextFastPath = () => {
    if (!buffer) return false;
    if (model.isSoftWrapped && model.isSoftWrapped()) return false;
    // If folds are present the screen-line text contains the fold marker
    // glyph, which differs from buffer text — we'd render the un-folded
    // text and the visible position would drift away from screen
    // coordinates. `getMarkerCount()` is O(1); `findMarkers()` requires
    // a params object and is O(N).
    const folds = displayLayer.foldsMarkerLayer;
    if (folds && folds.getMarkerCount && folds.getMarkerCount() > 0) {
      return false;
    }
    return true;
  };

  // --- reactive signals ---

  const [displayVersion, bumpDisplay] = createSignal(0);
  component._notifyDisplayChange = () => bumpDisplay((v) => v + 1);

  const [selectionsVersion, bumpSelections] = createSignal(0);
  component._notifySelectionChange = () => bumpSelections((v) => v + 1);

  // Bumped when any decoration is added/removed/updated on the model.
  // Drives cursor decoration merge (vim-mode-plus block-cursor style),
  // line-class, line-number, highlight, and custom-gutter decoration
  // queries.
  const [decorationsVersion, bumpDecorations] = createSignal(0);
  component._notifyDecorationsChange = () => bumpDecorations((v) => v + 1);

  // Block decorations — tracked separately so changes to a block's
  // height (which DON'T touch the decoration list) trigger relayout.
  // Each entry: { decoration, element, row, position, order, height,
  //               ro, markerSub, destroySub }
  const blockDecorations = new Map();
  const [blocksVersion, bumpBlocks] = createSignal(0);
  // Public hook for the constructor to add a block decoration as
  // soon as the model emits it. The actual decoration discovery lives
  // in `_observeBlockDecorations` on the component class.
  component._addBlockDecoration = (decoration) => {
    if (blockDecorations.has(decoration)) return;
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
      const info = blockDecorations.get(decoration);
      if (!info) return;
      const newHeight = element.offsetHeight || 0;
      if (info.height !== newHeight) {
        info.height = newHeight;
        bumpBlocks((v) => v + 1);
      }
    });
    ro.observe(element);
    let markerSub = null;
    if (marker.onDidChange) {
      markerSub = marker.onDidChange(() => {
        const info = blockDecorations.get(decoration);
        if (!info) return;
        const newRow = marker.getHeadScreenPosition().row;
        if (info.row !== newRow) {
          info.row = newRow;
          bumpBlocks((v) => v + 1);
        }
      });
    }
    let destroySub = null;
    if (decoration.onDidDestroy) {
      destroySub = decoration.onDidDestroy(() => {
        component._removeBlockDecoration(decoration);
      });
    }
    blockDecorations.set(decoration, {
      decoration, element, row, position, order,
      height: element.offsetHeight || 0,
      ro, markerSub, destroySub
    });
    bumpBlocks((v) => v + 1);
  };
  component._removeBlockDecoration = (decoration) => {
    const info = blockDecorations.get(decoration);
    if (!info) return;
    info.ro.disconnect();
    if (info.markerSub) info.markerSub.dispose();
    if (info.destroySub) info.destroySub.dispose();
    blockDecorations.delete(decoration);
    bumpBlocks((v) => v + 1);
  };
  component._destroyAllBlockDecorations = () => {
    for (const decoration of [...blockDecorations.keys()]) {
      component._removeBlockDecoration(decoration);
    }
  };

  // scrollTop and scrollLeft are kept in sync with the scroller DOM
  // element via a scroll event listener installed in onMount.
  const [scrollTop, setScrollTop] = createSignal(0);
  const [scrollLeft, setScrollLeft] = createSignal(0);
  component._setScrollTopSignal = setScrollTop;
  component._setScrollLeftSignal = setScrollLeft;

  // Viewport height in px, updated on resize.
  const [viewportHeight, setViewportHeight] = createSignal(0);
  // Viewport width in px, updated on resize. Drives column-range
  // virtualization for long lines.
  const [viewportWidth, setViewportWidth] = createSignal(0);

  // Font metrics, filled by the measurement pass in onMount.
  const [lineHeight, setLineHeight] = createSignal(0);
  const [charWidth, setCharWidth] = createSignal(0);

  // Blinking control.
  const [blinkOff, setBlinkOff] = createSignal(false);

  // Placeholder text shown when buffer is empty (mini editors mostly).
  // Bumped by onDidChangePlaceholderText and by every buffer change so
  // it appears/disappears as the user types/deletes.
  const [placeholderVersion, bumpPlaceholder] = createSignal(0);
  component._notifyPlaceholderChange = () => bumpPlaceholder((v) => v + 1);

  const placeholderText = createMemo(() => {
    placeholderVersion();
    displayVersion();
    if (!model.isEmpty || !model.isEmpty()) return null;
    return model.getPlaceholderText ? model.getPlaceholderText() : null;
  });

  // --- refs ---
  let measureRef;
  let scrollerRef;
  let linesWrapperRef;
  let bottomSpacerRef;
  let gutterInnerRef;

  // --- derived data ---

  // Guard against memos firing after the model has been destroyed.
  // `model.destroy()` runs `displayLayer.destroy()` before emitting
  // `did-destroy`, and ResizeObserver / scroll callbacks can fire
  // synchronously during the surrounding DOM teardown. Calling
  // `bufferRowForScreenRow` (or any display-layer query) on a destroyed
  // layer trips its `Invalid translated buffer row` assertion. Every
  // memo that talks to the display layer checks this first; once it's
  // false we leave previous values in place and rely on the model's
  // `did-destroy` handler to dispose the Solid render shortly after.
  const isModelAlive = () => !(model.isDestroyed && model.isDestroyed());

  const totalScreenRows = createMemo((prev) => {
    displayVersion();
    if (!isModelAlive()) return prev || 0;
    return model.getScreenLineCount();
  }, 0);

  // Given a pixel offset from the top of the content, return the screen row
  // that contains that pixel. Block decorations make this non-linear: each
  // block adds height between rows, so we walk sortedBlocks to accumulate
  // the extra offset and find the right row.
  const rowAtPixel = (pixel) => {
    const lh = lineHeight();
    if (!lh) return 0;
    const total = totalScreenRows();
    const blocks = sortedBlocks(); // tracked as reactive dependency
    let extraSoFar = 0;
    let bi = 0;
    for (let row = 0; row < total; row++) {
      // Consume 'before' blocks at this row — they sit above the line.
      while (bi < blocks.length && blocks[bi].row === row && blocks[bi].position === 'before') {
        extraSoFar += blocks[bi].height;
        bi++;
      }
      // Consume 'after' blocks at this row — they sit below the line.
      while (bi < blocks.length && blocks[bi].row === row && blocks[bi].position === 'after') {
        extraSoFar += blocks[bi].height;
        bi++;
      }
      // Bottom edge of this row (including its after-blocks).
      if (pixel < (row + 1) * lh + extraSoFar) return row;
    }
    return Math.max(0, total - 1);
  };

  const firstRenderedRow = createMemo(() => {
    const lh = lineHeight();
    if (!lh) return 0;
    return Math.max(0, rowAtPixel(scrollTop()) - OVERSCAN);
  });

  const lastRenderedRow = createMemo(() => {
    const lh = lineHeight();
    const total = totalScreenRows();
    if (!lh) return Math.min(total - 1, OVERSCAN * 2);
    const viewH = viewportHeight() || (scrollerRef ? scrollerRef.clientHeight : 0);
    return Math.min(total - 1, rowAtPixel(scrollTop() + viewH) + OVERSCAN);
  });

  // [startCol, endCol] for column-range virtualization on long lines.
  // Falls back to rough defaults before measurement completes so that
  // the FIRST render of a buffer with a giant line doesn't materialize
  // the entire line as a single text node — opening big.js (1.3 MB
  // single-line minified JS) without a fallback would land ~1.3 MB of
  // text in the DOM before our `onMount`-driven measurement re-runs the
  // memo and clips it. With fallbacks the first render already clips to
  // a viewport-sized window; the next render (once real measurements
  // arrive) corrects the values.
  const visibleColumnRange = createMemo(() => {
    let cw = charWidth();
    if (!cw) cw = 8;
    let vw = viewportWidth() || (scrollerRef ? scrollerRef.clientWidth : 0);
    if (!vw) vw = (typeof window !== 'undefined' ? window.innerWidth : 1024);
    const sl = scrollLeft();
    const startCol = Math.max(0, Math.floor(sl / cw) - COLUMN_OVERSCAN);
    const endCol = Math.ceil((sl + vw) / cw) + COLUMN_OVERSCAN;
    return [startCol, endCol];
  });

  // Block decorations — sorted list of all known blocks across the
  // buffer. We need ALL of them (not just visible) so the top/bottom
  // spacers can reserve room for off-screen blocks and the scroll
  // height matches what the content will be once those rows scroll
  // into view.
  //
  // Sort order: by row asc; within a row, 'before' precedes 'after';
  // tie-break by `order` (legacy editor convention) then by insertion.
  const sortedBlocks = createMemo(() => {
    blocksVersion();
    const list = [];
    blockDecorations.forEach((info) => list.push(info));
    list.sort((a, b) => {
      if (a.row !== b.row) return a.row - b.row;
      if (a.position !== b.position) return a.position === 'before' ? -1 : 1;
      return (a.order || 0) - (b.order || 0);
    });
    return list;
  });

  // Sum of all block-decoration heights anywhere in the buffer.
  const totalBlocksHeight = createMemo(() => {
    blocksVersion();
    let total = 0;
    blockDecorations.forEach((info) => { total += info.height; });
    return total;
  });

  // Returns the visual top (relative to lines-wrapper) of screen row
  // `row`, including the cumulative height of all block decorations
  // that conceptually precede it. A block "precedes" row R when:
  //   * its row < R, OR
  //   * its row === R and its position === 'before'
  // Used by the cursor/selection layer so they stay aligned with the
  // line text once block decorations push subsequent rows down.
  const pixelTopForRow = (row) => {
    const lh = lineHeight() || 0;
    let extra = 0;
    const blocks = sortedBlocks();
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.row > row) break;
      if (b.row === row && b.position !== 'before') break;
      extra += b.height;
    }
    return row * lh + extra;
  };
  // Expose for imperative callers (`pixelPositionForScreenPosition`).
  component._pixelTopForRow = pixelTopForRow;
  // Block-aware inverse: given a pixel offset from content top, return the
  // screen row that contains it. Exposed so the component class can use it
  // in mouse-click and screenPositionForPixelPosition calculations.
  component._rowAtPixel = rowAtPixel;

  // Top spacer reserves space for everything above the first rendered
  // row: `first * lh` PLUS the height of every block whose row is
  // strictly less than first. Blocks AT row first whose position is
  // 'before' are rendered between the spacer and line first, so they
  // are NOT in the spacer.
  const topSpacer = createMemo(() => {
    const first = firstRenderedRow();
    const lh = lineHeight();
    if (!lh) return 0;
    let extra = 0;
    const blocks = sortedBlocks();
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.row >= first) break;
      extra += b.height;
    }
    return first * lh + extra;
  });

  // Bottom spacer reserves space for: lines after `last`, plus blocks
  // strictly below the rendered range. All blocks at rows in
  // [first, last] are rendered inline with the lines, so the spacer
  // only needs to account for `b.row > last`.
  const bottomSpacer = createMemo(() => {
    const lh = lineHeight();
    if (!lh) return 0;
    const last = lastRenderedRow();
    const total = totalScreenRows();
    let extra = 0;
    const blocks = sortedBlocks();
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.row > last) extra += b.height;
    }
    return Math.max(0, (total - 1 - last) * lh + extra);
  });

  // Reactive lookup: blocks at a specific (row, position).  Returns a
  // (possibly empty) array. Memoized internally per render so renders
  // touching the same row repeatedly don't re-scan the sorted list.
  const blocksAt = (row, position) => {
    const out = [];
    const blocks = sortedBlocks();
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      if (b.row > row) break;
      if (b.row === row && b.position === position) out.push(b);
    }
    return out;
  };

  // Visible screen lines as wrappers, with stable identity across
  // renders. `<For>` (used below) keys items by referential identity, so
  // if we minted a fresh wrapper per row on every cycle each `<Line>`
  // would unmount and remount on every tokenization event during initial
  // open — that's what made opening a long file slow.
  //
  // Wrapper shape:
  //   { row, lineLength, mode: 'short', screenLine }
  //   { row, lineLength, mode: 'long',  screenLine }
  //   { row, lineLength, mode: 'plain', lineText }
  //
  // 'short'  – default; `<Line>` renders the full content with no
  //            virtualization.
  // 'long'   – line is wide enough that we want column-range
  //            virtualization in the walker, but short enough that
  //            asking the language mode for tags is acceptable.
  // 'plain'  – line is so long that calling
  //            `model.screenLineForScreenRow(row)` would block the main
  //            thread inside tree-sitter (`ts_query_cursor_next_capture`
  //            and friends — see profile-derived constant comments at
  //            the top of this file). We bypass the language mode and
  //            render plain buffer text instead, losing syntax
  //            highlighting on those lines but keeping the editor open
  //            responsive. The plain-text path is only available when
  //            screen rows correspond 1:1 with buffer rows (no soft
  //            wrap, no folds); otherwise we fall back to 'long' or
  //            'short' as appropriate.
  //
  // Rows that have scrolled far out of view are pruned when the cache
  // grows past `LINE_CACHE_SLACK` rows beyond the visible window, so
  // memory stays bounded on huge files.
  const lineCache = new Map();
  const LINE_CACHE_SLACK = 200;
  const visibleScreenLines = createMemo((prev) => {
    displayVersion();
    if (!isModelAlive()) return prev || [];
    const first = firstRenderedRow();
    const last = lastRenderedRow();
    const canUsePlain = supportsPlainTextFastPath();
    const arr = [];
    for (let r = first; r <= last; r++) {
      // Cheap: screenLineLengths array lookup (with possible spatial
      // index population, which doesn't invoke the language mode).
      const length = model.lineLengthForScreenRow(r);

      // Decide rendering mode WITHOUT calling screenLineForScreenRow
      // for the plain-text path.
      let wrapper;
      if (canUsePlain && length > PLAIN_TEXT_THRESHOLD) {
        const bufferRow = model.bufferRowForScreenRow(r);
        const text = buffer.lineForRow(bufferRow);
        const cached = lineCache.get(r);
        if (
          cached &&
          cached.mode === 'plain' &&
          cached.lineText === text &&
          cached.lineLength === length
        ) {
          arr.push(cached);
          continue;
        }
        wrapper = { row: r, mode: 'plain', lineText: text, lineLength: length };
      } else {
        const screenLine = model.screenLineForScreenRow(r);
        const mode = length > LONG_LINE_THRESHOLD ? 'long' : 'short';
        const cached = lineCache.get(r);
        if (
          cached &&
          cached.mode === mode &&
          cached.screenLine === screenLine
        ) {
          arr.push(cached);
          continue;
        }
        wrapper = { row: r, mode, screenLine, lineLength: length };
      }
      lineCache.set(r, wrapper);
      arr.push(wrapper);
    }
    if (lineCache.size > (last - first + 1) + LINE_CACHE_SLACK) {
      const keepFrom = first - LINE_CACHE_SLACK / 2;
      const keepTo = last + LINE_CACHE_SLACK / 2;
      for (const k of lineCache.keys()) {
        if (k < keepFrom || k > keepTo) lineCache.delete(k);
      }
    }
    return arr;
  }, []);

  // Gutter data: same row range with buffer-row metadata. Wrappers are
  // cached per screenRow so `<For>` reuses gutter cells across renders
  // unless the underlying buffer-row metadata for that row changes —
  // mirrors the `lineCache` strategy used for the line list.
  const gutterCache = new Map();
  const visibleRows = createMemo((prev) => {
    displayVersion();
    if (!isModelAlive()) return prev || [];
    const first = firstRenderedRow();
    const last = lastRenderedRow();
    const count = last - first + 1;
    if (count <= 0) return [];

    const rows = [];
    let prevBufRow = first > 0 ? model.bufferRowForScreenRow(first - 1) : -1;
    for (let i = 0; i < count; i++) {
      const screenRow = first + i;
      const bufRow = model.bufferRowForScreenRow(screenRow);
      const softWrapped = bufRow === prevBufRow;
      const nextBufRow = i + 1 < count
        ? model.bufferRowForScreenRow(screenRow + 1)
        : bufRow + 1;
      // Skip the `isFoldableAtBufferRow` check for very long lines:
      // the tree-sitter language mode answers it by scanning the parse
      // tree across the whole row for fold captures
      // (`getOrCreateBoundariesIterator` → `ts_query_cursor_next_capture`),
      // which on a 1.3 MB minified line is 10+ s of work. Long minified
      // lines aren't usefully foldable anyway. The threshold matches
      // the line-rendering plain-text fast path so the gutter and the
      // line agree on which rows are "too big to ask the language mode
      // about".
      const length = model.lineLengthForScreenRow(screenRow);
      const foldable = !softWrapped &&
        bufRow !== nextBufRow &&
        length <= PLAIN_TEXT_THRESHOLD &&
        model.isFoldableAtBufferRow(bufRow);
      const cached = gutterCache.get(screenRow);
      if (
        cached &&
        cached.bufferRow === bufRow &&
        cached.softWrapped === softWrapped &&
        cached.foldable === foldable
      ) {
        rows.push(cached);
      } else {
        const wrapper = { screenRow, bufferRow: bufRow, softWrapped, foldable };
        gutterCache.set(screenRow, wrapper);
        rows.push(wrapper);
      }
      prevBufRow = bufRow;
    }
    if (gutterCache.size > count + LINE_CACHE_SLACK) {
      const keepFrom = first - LINE_CACHE_SLACK / 2;
      const keepTo = last + LINE_CACHE_SLACK / 2;
      for (const k of gutterCache.keys()) {
        if (k < keepFrom || k > keepTo) gutterCache.delete(k);
      }
    }
    return rows;
  }, []);

  const maxDigits = createMemo((prev) => {
    displayVersion();
    if (!isModelAlive()) return prev || 2;
    return Math.max(2, String(model.getLineCount()).length);
  }, 2);

  const showLineNumbers = createMemo(() => {
    displayVersion();
    return model.doesShowLineNumbers ? model.doesShowLineNumbers() : true;
  });

  // Mini editors (find-and-replace input, autocomplete suggestion box,
  // etc.) should not show the gutter at all.
  const showGutter = createMemo(() => {
    displayVersion();
    if (model.isMini && model.isMini()) return false;
    if (model.anyLineNumberGutterVisible) {
      return model.anyLineNumberGutterVisible();
    }
    return true;
  });

  // Width of the longest screen line in pixels, used to size the
  // lines-wrapper so the scroll container has a real horizontal range.
  // Without this, `.line { contain: layout }` from the core CSS prevents
  // line content from expanding the wrapper — the scroller never grows
  // wider than the viewport and horizontal scrolling is impossible.
  const longestLineWidth = createMemo(() => {
    displayVersion();
    if (!isModelAlive()) return 0;
    const cw = charWidth();
    if (!cw) return 0;
    const longestRow = model.getApproximateLongestScreenRow
      ? model.getApproximateLongestScreenRow()
      : 0;
    const length = model.lineLengthForScreenRow
      ? model.lineLengthForScreenRow(longestRow)
      : 0;
    return (length + 1) * cw;
  });

  // Per-screen-row extra classes from `type: 'line-number'` decorations
  // (e.g. the 'folded' class that text-editor.js adds via decorateMarkerLayer
  // on the foldsMarkerLayer). Keyed by screen row; value is the combined
  // class string for that row.
  const lineNumberDecoClasses = createMemo(() => {
    decorationsVersion();
    displayVersion();
    const byRow = new Map();
    if (!isModelAlive() || !model.decorationManager) return byRow;
    const total = model.getScreenLineCount();
    let propsByMarker = null;
    if (model.decorationManager.decorationPropertiesByMarkerForScreenRowRange) {
      propsByMarker = model.decorationManager.decorationPropertiesByMarkerForScreenRowRange(0, total);
    }
    if (!propsByMarker) return byRow;
    for (const [marker, decos] of propsByMarker) {
      for (const d of decos) {
        if (!d || !d.class) continue;
        const isLineNumber = Array.isArray(d.type)
          ? d.type.indexOf('line-number') !== -1
          : d.type === 'line-number';
        if (!isLineNumber) continue;
        const range = marker.getScreenRange ? marker.getScreenRange() : null;
        if (!range) continue;
        const reversed = marker.isReversed ? marker.isReversed() : false;
        applyLineDecoration(byRow, d, range, reversed);
      }
    }
    return byRow;
  });

  // Build full cursor descriptors: position + merged class/style from
  // any `type: 'cursor'` decorations attached to the cursor's marker.
  // vim-mode-plus uses cursor decorations with `style: { top, left }`
  // to shift the visible block cursor onto the head character of a
  // visual-mode selection (otherwise the block paints one char past
  // the highlighted text). Without this merge, packages that move or
  // restyle the cursor via decorations have no effect.
  const cursorDescriptors = createMemo((prev) => {
    selectionsVersion();
    decorationsVersion();
    displayVersion();
    if (!isModelAlive()) return prev || [];
    const cursors = model.getCursors();
    if (cursors.length === 0) return [];

    let propsByMarker = null;
    if (
      model.decorationManager &&
      model.decorationManager.decorationPropertiesByMarkerForScreenRowRange
    ) {
      const total = model.getScreenLineCount();
      // Range covers every cursor row, not just the rendered viewport,
      // because cursor decorations should apply to off-screen cursors too
      // (multi-cursor edits can place cursors anywhere in the buffer).
      propsByMarker = model.decorationManager.decorationPropertiesByMarkerForScreenRowRange(
        0,
        total
      );
    }

    return cursors.map((c) => {
      const position = c.getScreenPosition();
      let extraClass = null;
      let extraStyle = null;
      if (propsByMarker) {
        const decos = propsByMarker.get(c.getMarker());
        if (decos) {
          for (let i = 0; i < decos.length; i++) {
            const d = decos[i];
            if (!d) continue;
            const type = d.type;
            const isCursor = Array.isArray(type)
              ? type.indexOf('cursor') !== -1
              : type === 'cursor';
            if (!isCursor) continue;
            if (d.class) {
              extraClass = extraClass ? extraClass + ' ' + d.class : d.class;
            }
            if (d.style) {
              extraStyle = Object.assign(extraStyle || {}, d.style);
            }
          }
        }
      }
      return { position, extraClass, extraStyle };
    });
  }, []);

  const selectionRanges = createMemo((prev) => {
    selectionsVersion();
    if (!isModelAlive()) return prev || [];
    return model.getSelections().map((s) => s.getScreenRange());
  }, []);

  // Set of screen rows that have a cursor on them, for cursor-line class.
  // Uses the descriptor's display row (after applying any top-delta decoration
  // from vim-mode-plus) so that cursor-line follows the visual cursor, not the
  // model cursor (which vim places one row past the selection end in linewise
  // visual mode).
  const cursorRows = createMemo((prev) => {
    const descs = cursorDescriptors();
    const lh = lineHeight();
    if (!isModelAlive()) return prev || new Set();
    const s = new Set();
    for (const { position, extraStyle } of descs) {
      if (!position) continue;
      let displayRow = position.row;
      if (extraStyle && extraStyle.top != null && lh > 0) {
        const v = extraStyle.top;
        if (typeof v === 'string' && v.endsWith('px')) {
          displayRow += Math.round(parseFloat(v) / lh);
        } else if (typeof v === 'number') {
          displayRow += Math.round(v / lh);
        }
      }
      s.add(displayRow);
    }
    return s;
  }, new Set());

  // --- measurement ---

  const measure = () => {
    if (!measureRef) return false;
    const lineEl = measureRef.querySelector('.measure-line');
    const spanEl = measureRef.querySelector('.measure-chars');
    if (!lineEl || !spanEl) return false;
    const lineRect = lineEl.getBoundingClientRect();
    const spanRect = spanEl.getBoundingClientRect();
    if (!lineRect.height || !spanRect.width) return false;
    const lh = lineRect.height;
    const cw = spanRect.width / 100;
    setLineHeight(lh);
    setCharWidth(cw);
    component._lineHeight = lh;
    component._charWidth = cw;
    // Keep model measurements in sync so external callers (vim-mode-plus,
    // etc.) that use editor.getLineHeightInPixels() / getDefaultCharWidth()
    // get real values rather than the 0/null they were initialised with.
    if (model.setLineHeightInPixels) model.setLineHeightInPixels(lh);
    if (model.setDefaultCharWidth) model.setDefaultCharWidth(cw, cw, cw, cw);
    return true;
  };

  onMount(() => {
    component._scroller = scrollerRef;
    component._linesWrapper = linesWrapperRef;
    component._bottomSpacer = bottomSpacerRef;
    component._measure = measure;

    if (!measure()) {
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => measure());
      }
      requestAnimationFrame(() => { if (!component._lineHeight) measure(); });
    }

    // Sync scroll position signals with the DOM.
    const onScroll = () => {
      const st = scrollerRef.scrollTop;
      const sl = scrollerRef.scrollLeft;
      setScrollTop(st);
      setScrollLeft(sl);
      component.scrollTop = st;
      component.scrollLeft = sl;
      // Sync gutter translateY imperatively — same frame as the scroll
      // event, before SolidJS re-renders — so the gutter never lags the
      // content by one frame (which causes a visible shaking effect).
      if (gutterInnerRef) {
        gutterInnerRef.style.transform = 'translateY(' + (-st) + 'px)';
      }
      // Reposition any floating overlay decorations (e.g. autocomplete list)
      // when the scroller scrolls so they track their anchor position.
      for (const decoration of component._overlays.keys()) {
        component._positionOverlay(decoration);
      }
    };
    scrollerRef.addEventListener('scroll', onScroll, { passive: true });

    // Resize observer to keep viewport height current AND to re-measure
    // line height / char width when the user zooms (Cmd-+/-) or any
    // styling change resizes the measurement sample. Without this, the
    // cursor and line positions stay glued to the old metrics and drift
    // away from the actual rendered text after a zoom.
    const ro = new ResizeObserver(() => {
      setViewportHeight(scrollerRef.clientHeight);
      setViewportWidth(scrollerRef.clientWidth);
    });
    ro.observe(scrollerRef);
    // Initial values without waiting for the first observer notification.
    setViewportHeight(scrollerRef.clientHeight);
    setViewportWidth(scrollerRef.clientWidth);

    const measureRO = new ResizeObserver(() => { measure(); });
    if (measureRef) {
      const lineEl = measureRef.querySelector('.measure-line');
      if (lineEl) measureRO.observe(lineEl);
    }

    onCleanup(() => {
      scrollerRef.removeEventListener('scroll', onScroll);
      ro.disconnect();
      measureRO.disconnect();
    });
  });

  // --- blinking ---

  component._restartBlink = () => {
    if (component._blinkInterval) clearInterval(component._blinkInterval);
    if (component._blinkResume) clearTimeout(component._blinkResume);
    setBlinkOff(false);
    component._blinkResume = setTimeout(() => {
      component._blinkInterval = setInterval(() => {
        if (!component.focused || !component.attached) return;
        setBlinkOff((v) => !v);
      }, CURSOR_BLINK_PERIOD / 2);
    }, CURSOR_BLINK_RESUME_DELAY);
  };

  onMount(() => { if (component.focused) component._restartBlink(); });

  onCleanup(() => {
    if (component._blinkInterval) clearInterval(component._blinkInterval);
    if (component._blinkResume) clearTimeout(component._blinkResume);
  });

  // --- render ---

  return (
    <div
      class="pulsar-editor-root"
      style={
        'display: flex; flex-direction: column; ' +
        'width: 100%; height: 100%; ' +
        'overflow: hidden; box-sizing: border-box;'
      }
    >
      {/* Hidden measurement fixture. The `.measure-line` block gives us
          the full rendered line height (including leading); the inner
          `.measure-chars` span gives us the average character width. */}
      <div
        ref={(el) => (measureRef = el)}
        aria-hidden="true"
        style={
          'position: absolute; left: -9999px; top: 0; ' +
          'visibility: hidden; pointer-events: none;'
        }
      >
        <div class="measure-line" style="display: block; white-space: pre;">
          <span class="measure-chars">{'x'.repeat(100)}</span>
        </div>
      </div>

      {/* Main editor body: gutter (fixed-width, no horizontal scroll) +
          scroll-view (takes the rest, scrolls both axes). The gutter lives
          OUTSIDE the scroll container so it is never scrolled horizontally;
          it syncs vertically through a CSS translateY in GutterContainer. */}
      <div style="display: flex; flex-direction: row; flex: 1; overflow: hidden; min-height: 0;">

        <Show when={showGutter()}>
          <GutterContainer
            scrollTop={scrollTop}
            visibleRows={visibleRows}
            topSpacer={topSpacer}
            bottomSpacer={bottomSpacer}
            showLineNumbers={showLineNumbers}
            maxDigits={maxDigits}
            sortedBlocks={sortedBlocks}
            lineNumberDecoClasses={lineNumberDecoClasses}
            gutterRef={(el) => { gutterInnerRef = el; component._gutterInnerRef = el; }}
          />
        </Show>

        {/* Scroll-view: native overflow:auto handles both scrollbars.
            The lines-wrapper inside uses flow layout so each `.line`
            block naturally expands the content width to accommodate
            the longest line — no explicit `width` calculation needed. */}
        <div
          ref={(el) => (scrollerRef = el)}
          class="scroll-view"
          style="flex: 1; overflow: auto; position: relative;"
        >
          {/* `position: relative; z-index: 0` makes lines-wrapper a
              stacking context so `.region`'s `z-index: -1` (from the
              core CSS rule `.highlight .region`) only escapes far
              enough to land BEHIND the line text, not behind the whole
              page. Without an explicit stacking context the negative
              z-index would either disappear (if a positioned ancestor
              creates one anyway) or punch through to the body's
              background. */}
          <div
            ref={(el) => (linesWrapperRef = el)}
            class="lines-wrapper"
            style={
              'position: relative; z-index: 0; white-space: pre; ' +
              'min-width: max(100%, ' + longestLineWidth() + 'px);'
            }
          >
            {/* Top spacer pushes the first rendered row to its correct
                vertical position. */}
            <div style={`height: ${topSpacer()}px; display: block;`} />

            {/* Rendered lines in flow layout. Each `.line` is
                `display: block` so its content width drives the scroll
                container width. Syntax-highlighted spans nest inside.
                `<For>`'s identity-based diff plays correctly here only
                because `visibleScreenLines()` caches its wrappers per
                row (see `lineCache` above) — without that cache, every
                tokenization event during initial open of a long file
                tears down and re-creates every Line, which is what
                made open slow. With caching, only the row whose
                screenLine actually changed produces a new wrapper, so
                `<For>` swaps just the affected `<Line>`. */}
            <For each={visibleScreenLines()}>
              {(item) => (
                <>
                  {/* Block decorations with position 'before' render
                      ABOVE the line at the same row. */}
                  <For each={blocksAt(item.row, 'before')}>
                    {(b) => <BlockDecoration block={b} />}
                  </For>
                  <Line
                    item={item}
                    displayLayer={displayLayer}
                    visibleColumnRange={visibleColumnRange}
                    charWidth={charWidth}
                    cursorLine={cursorRows().has(item.row)}
                  />
                  {/* Block decorations with position 'after' render
                      BELOW the line at the same row. */}
                  <For each={blocksAt(item.row, 'after')}>
                    {(b) => <BlockDecoration block={b} />}
                  </For>
                </>
              )}
            </For>

            {/* Bottom spacer fills the remaining virtual height. */}
            <div ref={(el) => (bottomSpacerRef = el)} style={`height: ${bottomSpacer()}px; display: block;`} />

            {/* Placeholder text (e.g. "Filter commands", "Search…")
                shown when the buffer is empty. Mini editors use this
                heavily — without it, fuzzy finder and command palette
                inputs look blank when first opened. */}
            <Show when={placeholderText() != null}>
              <div class="placeholder-text" style="position: absolute; top: 0; left: 0;">
                {placeholderText()}
              </div>
            </Show>

            {/* Overlay layers: selections + cursors.

                Selection placement is subtle. The lines are
                non-positioned blocks so they paint at step 3 of
                `.lines-wrapper`'s stacking context. A naive
                positioned `.highlights` would paint at step 6 — i.e.
                ON TOP of the text — even with `.region`'s `z-index:
                -1`, because `.region` only escapes its own contain-
                created stacking context as far as `.highlights`,
                which itself paints above the lines.

                Solution: give `.highlights` explicit `z-index: -1`.
                That promotes it to step 2 of `.lines-wrapper`'s
                stacking context (behind non-positioned descendants),
                and it carries its `.region` children with it.
                Selections now paint behind the line text, matching
                the legacy editor's behavior. */}
            <div
              class="highlights"
              style={
                'position: absolute; top: 0; left: 0; right: 0; ' +
                'height: ' + (totalScreenRows() * (lineHeight() || 0) + totalBlocksHeight()) + 'px; ' +
                'pointer-events: none; z-index: -1;'
              }
            >
              <For each={selectionRanges()}>
                {(range) => (
                  <SelectionHighlight
                    range={range}
                    lineHeight={lineHeight}
                    charWidth={charWidth}
                    topForRow={pixelTopForRow}
                  />
                )}
              </For>
            </div>
            <div
              class={'cursors' + (blinkOff() ? ' blink-off' : '')}
              style={
                'position: absolute; top: 0; left: 0; right: 0; ' +
                'height: ' + (totalScreenRows() * (lineHeight() || 0) + totalBlocksHeight()) + 'px; ' +
                'pointer-events: none;'
              }
            >
              <For each={cursorDescriptors()}>
                {(c) => (
                  <CursorBar
                    position={c.position}
                    extraClass={c.extraClass}
                    extraStyle={c.extraStyle}
                    lineHeight={lineHeight}
                    charWidth={charWidth}
                    topForRow={pixelTopForRow}
                  />
                )}
              </For>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component class — public API called by text-editor-element.js,
// text-editor.js, and various packages.
// ---------------------------------------------------------------------------

class PulsarTextEditorComponent {
  // --- Static API -------------------------------------------------------

  static setScheduler(_scheduler) {}
  static getScheduler() { return null; }

  static didUpdateStyles() {
    if (this.attachedComponents) {
      this.attachedComponents.forEach((c) => c.didUpdateStyles());
    }
  }

  static didUpdateScrollbarStyles() {
    if (this.attachedComponents) {
      this.attachedComponents.forEach((c) => c.didUpdateScrollbarStyles());
    }
  }

  // --- Construction -----------------------------------------------------

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
    this.inputEnabled = true;

    this._lineHeight = 0;
    this._charWidth = 0;

    // Set by the Editor Solid component after it mounts.
    this._notifyDisplayChange = null;
    this._notifySelectionChange = null;
    this._notifyDecorationsChange = null;
    this._setScrollTopSignal = null;
    this._setScrollLeftSignal = null;
    this._restartBlink = null;
    this._scroller = null;
    this._linesWrapper = null;
    this._blinkInterval = null;
    this._blinkResume = null;
    this._activeItemSub = null;
    this._decorationsSub = null;
    this._destroySub = null;
    this._grammarSub = null;

    // Overlay decorations: packages like autocomplete-plus use
    // `editor.decorateMarker(marker, {type: 'overlay', item: el})`
    // to display floating UI (suggestion list, etc.) anchored to a
    // buffer position. We track each live overlay in a Map keyed by
    // the decoration object so we can update position on scroll/resize
    // and remove the DOM node when the decoration is destroyed.
    // Map<Decoration, { wrapperEl, resizeObserver, markerSub, decorationSub }>
    this._overlays = new Map();

    // Clear any pre-existing children (e.g. initialText node).
    while (this.element.firstChild) {
      this.element.removeChild(this.element.firstChild);
    }

    // Hidden input: captures typed text as `input` events. All editing
    // key commands (Backspace, arrow keys, etc.) are handled by
    // atom.keymaps and never arrive here as raw key events.
    this.hiddenInput = document.createElement('input');
    this.hiddenInput.classList.add('hidden-input');
    this.hiddenInput.setAttribute('tabindex', '-1');
    this.hiddenInput.style.cssText =
      'position: absolute; width: 1px; height: 1px; opacity: 0; ' +
      'padding: 0; border: 0; pointer-events: none; z-index: 5;';
    this.hiddenInput.addEventListener('input', this._onHiddenInputInput.bind(this));
    this.hiddenInput.addEventListener('focus', this._onHiddenInputFocus.bind(this));
    this.hiddenInput.addEventListener('blur', this._onHiddenInputBlur.bind(this));
    this.element.appendChild(this.hiddenInput);

    // Solid host div.
    this.solidHost = document.createElement('div');
    this.solidHost.classList.add('pulsar-text-editor-solid-host');
    this.solidHost.style.cssText = 'display: block; width: 100%; height: 100%;';
    this.element.appendChild(this.solidHost);

    this.disposeRender = render(
      () => <Editor model={this.props.model} component={this} />,
      this.solidHost
    );

    // Focus management.
    //
    // Two-step focus override:
    //   1. Call the element's native `focus()` so the element receives
    //      focus and its `focus` event fires. Packages like
    //      autocomplete-plus listen to that event on the editor view
    //      via `editorView.addEventListener('focus', …)` to know an
    //      editor became active — without this step the activation
    //      hook never runs and autocomplete stays dormant.
    //   2. Forward focus to the hidden input so it can collect
    //      keystrokes. This is also done by `didFocus()` in response
    //      to the focus event, but doing it here too is a belt-and-
    //      suspenders measure: in some flows (e.g. atom-select-list's
    //      `focus()` call right after `panel.show()`) the focus event
    //      doesn't reliably reach `didFocus`, leaving the dialog
    //      visible but unable to receive typing until the user clicks
    //      the editor.  Explicitly chaining `hiddenInput.focus()` here
    //      makes the open-and-type workflow Just Work.
    this.element.focus = (options) => {
      if (!this.focused) {
        this.element.dispatchEvent(new FocusEvent('focus', { bubbles: false, cancelable: false }));
      }
      if (this.hiddenInput) {
        this.hiddenInput.focus(options || { preventScroll: true });
      }
    };

    // Mousedown: position cursor and start selection drag.
    this.element.addEventListener('mousedown', this._onMouseDown.bind(this), true);

    // Workspace subscription: when a tab switch makes this editor
    // active, focus the hidden input.
    if (global.atom && global.atom.workspace) {
      this._activeItemSub = global.atom.workspace.onDidChangeActivePaneItem(
        (item) => {
          if (
            item === this.props.model &&
            this.attached &&
            document.activeElement !== this.hiddenInput
          ) {
            // Route via the wrapped element.focus() so the focus event
            // fires on the editor element (autocomplete-plus etc.
            // depend on this); the wrapper then forwards to the hidden
            // input.
            this.element.focus({ preventScroll: true });
          }
        }
      );
    }

    // TextMate grammars tokenize asynchronously. When tokenization
    // completes for a previously-untokenized region, the screen lines
    // already exist (lineText is set) but their `tags` array changes
    // from "single big text run" to "scoped runs". The display layer's
    // `onDidChange` only fires for layout-affecting changes (soft wrap,
    // folds), so without this hook our highlighter would render plain
    // text forever for SQL / shell / plain TextMate languages.
    if (this.props.model.onDidTokenize) {
      this._tokenizeSub = this.props.model.onDidTokenize(() => {
        if (this._notifyDisplayChange) this._notifyDisplayChange();
      });
    }

    // Placeholder text changes when consumers update the editor — e.g.
    // command palette swapping the prompt. Subscribe so the displayed
    // text updates without waiting for the next buffer change.
    if (this.props.model.onDidChangePlaceholderText) {
      this._placeholderSub = this.props.model.onDidChangePlaceholderText(() => {
        if (this._notifyPlaceholderChange) this._notifyPlaceholderChange();
      });
    }

    // Decoration updates: packages (vim-mode-plus, linter, etc.) add and
    // mutate decorations independently of buffer/selection changes. Without
    // this subscription, the cursor decoration merge wouldn't see the
    // vim-mode-plus block-cursor reposition until the next selection change,
    // leaving the cursor lagging by one event.
    if (this.props.model.onDidUpdateDecorations) {
      this._decorationsSub = this.props.model.onDidUpdateDecorations(() => {
        if (this._notifyDecorationsChange) this._notifyDecorationsChange();
        this._syncOverlayDecorations();
        this._syncBlockDecorations();
      });
    }
    // Initial sync — picks up any decorations that already exist on the
    // model when this component is constructed (the constructor of the
    // edit session may have decorated marker layers before we got here).
    this._syncBlockDecorations();
    this._syncOverlayDecorations();

    // When the model is destroyed (tab closed, pane closed, project
    // close), tear the Solid render down. Without this, the resize and
    // mutation observers wired up in `onMount` outlive the model — and
    // the next time they fire, our memos call `bufferRowForScreenRow`
    // on a destroyed display layer, tripping its
    // `Invalid translated buffer row` assertion. Subscribing here keeps
    // teardown ordered: model dies → we dispose the render → observers
    // disconnect → no stale callbacks reach the dead model.
    if (this.props.model.onDidDestroy) {
      this._destroySub = this.props.model.onDidDestroy(() => this.destroy());
    }

    // Stamp data-grammar on the element so CSS and packages that key off
    // `atom-text-editor[data-grammar~="source js"]` etc. work correctly.
    this._updateGrammarDataset();
    if (this.props.model.onDidChangeGrammar) {
      this._grammarSub = this.props.model.onDidChangeGrammar(() => this._updateGrammarDataset());
    }

    // For mini editors, mirror the legacy behavior: stamp a `mini`
    // attribute/class on the host element so the existing
    // `atom-text-editor[mini]` CSS rules apply.
    if (this.props.model.isMini && this.props.model.isMini()) {
      this.element.setAttribute('mini', '');
      this.element.classList.add('mini');
    }

    this.nextUpdatePromise = null;
    this.resolveNextUpdatePromise = null;
  }

  // --- Hidden input handlers --------------------------------------------

  _onHiddenInputInput(event) {
    if (!this.inputEnabled) return;
    const text = event.data;
    if (text != null && text.length > 0) {
      this.props.model.insertText(text);
    }
    this.hiddenInput.value = '';
  }

  _onHiddenInputFocus() {
    if (!this.focused) {
      this.focused = true;
      this.element.classList.add('is-focused');
      if (this._restartBlink) this._restartBlink();
    }
  }

  _onHiddenInputBlur(event) {
    if (event.relatedTarget && this.element.contains(event.relatedTarget)) {
      return;
    }
    if (this.focused) {
      this.focused = false;
      this.element.classList.remove('is-focused');
      // Dispatch a synthetic blur on atom-text-editor so packages listening
      // there (autocomplete-plus blurListener → hideSuggestionList) know the
      // editor has lost focus.
      this.element.dispatchEvent(new FocusEvent('blur', { bubbles: false, cancelable: false }));
    }
  }

  // --- Mouse handling ---------------------------------------------------

  _onMouseDown(event) {
    if (event.button !== 0) return;

    // Always focus the editor on any click inside it. Route through
    // `this.element.focus()` (NOT `hiddenInput.focus()` directly) so the
    // wrapper installed in the constructor runs `originalElementFocus`
    // first — that fires the `focus` event on the editor element, which
    // is what autocomplete-plus and other packages listen to via
    // `view.addEventListener('focus', …)` to know an editor became
    // active and start tracking its buffer changes. Focusing the hidden
    // input directly silently broke autocomplete activation because
    // `focus` events don't bubble — only the input would have fired,
    // and the editor element's listeners would never see anything.
    if (document.activeElement !== this.hiddenInput) {
      this.element.focus({ preventScroll: true });
    }

    if (!this._linesWrapper || !this._lineHeight) return;

    const target = event.target;
    const model = this.props.model;

    // Gutter fold toggle: clicking the chevron icon on a foldable/folded row.
    if (
      target &&
      target.matches('.icon-right') &&
      target.parentElement &&
      (target.parentElement.matches('.foldable') || target.parentElement.matches('.folded'))
    ) {
      const lineNumberEl = target.parentElement;
      const screenRow = parseInt(lineNumberEl.dataset.screenRow, 10);
      if (!isNaN(screenRow)) {
        const bufferRow = model.bufferPositionForScreenPosition([screenRow, 0]).row;
        model.toggleFoldAtBufferRow(bufferRow);
      }
      event.preventDefault();
      return;
    }

    const linesRect = this._linesWrapper.getBoundingClientRect();
    // Only treat clicks inside the lines area as cursor-positioning
    // gestures; clicks in the gutter fall through.
    if (
      event.clientX < linesRect.left ||
      event.clientY < linesRect.top ||
      event.clientX > linesRect.right ||
      event.clientY > linesRect.bottom
    ) {
      return;
    }

    event.preventDefault();
    const screenPosition = this._screenPositionForMouse(event);

    // Clicking a fold-marker in the lines area collapses an active fold.
    if (target && target.matches('.fold-marker')) {
      const bufferPosition = model.bufferPositionForScreenPosition(screenPosition);
      model.destroyFoldsContainingBufferPositions([bufferPosition], false);
      return;
    }

    if (event.shiftKey) {
      model.selectToScreenPosition(screenPosition, { autoscroll: false });
    } else if (event.detail === 2) {
      model.setCursorScreenPosition(screenPosition, { autoscroll: false });
      model.getLastSelection().selectWord({ autoscroll: false });
    } else if (event.detail === 3) {
      model.setCursorScreenPosition(screenPosition, { autoscroll: false });
      model.getLastSelection().selectLine(null, { autoscroll: false });
    } else {
      model.setCursorScreenPosition(screenPosition, { autoscroll: false });
    }

    // Track drag to extend the selection.
    let dragging = false;
    const onMove = (e) => {
      dragging = true;
      model.selectToScreenPosition(
        this._screenPositionForMouse(e),
        { suppressSelectionMerge: true, autoscroll: false }
      );
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp, true);
      if (dragging) {
        model.finalizeSelections();
        model.mergeIntersectingSelections();
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp, true);
  }

  _screenPositionForMouse(event) {
    const linesRect = this._linesWrapper.getBoundingClientRect();
    const lh = this._lineHeight;
    const cw = this._charWidth;
    // getBoundingClientRect().top is the VISUAL top of the element on
    // screen. Subtracting it from clientY gives the distance from the
    // logical top of the lines content, which already accounts for
    // any scroll offset — no need to add scrollTop again.
    const y = event.clientY - linesRect.top;
    const x = event.clientX - linesRect.left;
    const row = this._rowAtPixel ? this._rowAtPixel(y) : Math.max(0, Math.floor(y / lh));
    const clampedRow = Math.min(row, this.props.model.getScreenLineCount() - 1);
    const col = Math.max(0, Math.round(x / cw));
    return this.props.model.clipScreenPosition([clampedRow, col]);
  }

  // --- Update / lifecycle -----------------------------------------------

  update(props) {
    this.props = Object.assign({}, this.props, props);
    return Promise.resolve();
  }

  scheduleUpdate() {}
  updateSync() {}

  getNextUpdatePromise() {
    if (!this.nextUpdatePromise) {
      this.nextUpdatePromise = new Promise((resolve) => {
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

    // When the element is moved in the DOM (e.g. pane split, tab drag),
    // the browser resets the scroller's scrollTop/scrollLeft to 0 but
    // does NOT fire a scroll event. The model still holds the logical
    // scroll position; restore it so the virtual row range stays correct.
    if (this._scroller) {
      const modelTop = this.scrollTop || 0;
      const modelLeft = this.scrollLeft || 0;
      this._scroller.scrollTop = modelTop;
      this._scroller.scrollLeft = modelLeft;
      // Sync signals to the DOM values (browser may clamp if content is
      // shorter than modelTop at this point).
      if (this._setScrollTopSignal) this._setScrollTopSignal(this._scroller.scrollTop);
      if (this._setScrollLeftSignal) this._setScrollLeftSignal(this._scroller.scrollLeft);
      // Retry on the next frame: after SolidJS re-renders the virtual rows
      // the content is tall enough to accept the full modelTop value.
      requestAnimationFrame(() => {
        if (!this._scroller) return;
        this._scroller.scrollTop = modelTop;
        this._scroller.scrollLeft = modelLeft;
        if (this._setScrollTopSignal) this._setScrollTopSignal(this._scroller.scrollTop);
        if (this._setScrollLeftSignal) this._setScrollLeftSignal(this._scroller.scrollLeft);
        if (this._gutterInnerRef) {
          this._gutterInnerRef.style.transform = 'translateY(' + (-this._scroller.scrollTop) + 'px)';
        }
      });
    }
  }

  didDetach() {
    // Detach is not a teardown signal — the workspace re-attaches the
    // same `<atom-text-editor>` element when a pane split, dock toggle,
    // or tab drag rewraps it in a new parent. If we disposed the Solid
    // root here, the editor would come back blank after a split because
    // `connectedCallback` only calls `didAttach()`, which doesn't render.
    // Keep the Solid root, the model/workspace subscriptions, and the
    // scroll/resize observers alive across detach so re-attach is a
    // no-op visually. Final cleanup, if needed, lives in `destroy()`.
    this.attached = false;
    if (PulsarTextEditorComponent.attachedComponents) {
      PulsarTextEditorComponent.attachedComponents.delete(this);
    }
  }

  destroy() {
    this.didDetach();
    if (this._activeItemSub) {
      this._activeItemSub.dispose();
      this._activeItemSub = null;
    }
    if (this._tokenizeSub) {
      this._tokenizeSub.dispose();
      this._tokenizeSub = null;
    }
    if (this._placeholderSub) {
      this._placeholderSub.dispose();
      this._placeholderSub = null;
    }
    if (this._decorationsSub) {
      this._decorationsSub.dispose();
      this._decorationsSub = null;
    }
    if (this._destroySub) {
      this._destroySub.dispose();
      this._destroySub = null;
    }
    if (this._grammarSub) {
      this._grammarSub.dispose();
      this._grammarSub = null;
    }
    if (this._destroyAllBlockDecorations) {
      this._destroyAllBlockDecorations();
    }
    if (this.disposeRender) {
      this.disposeRender();
      this.disposeRender = null;
    }
    this._destroyAllOverlays();
  }

  didShow() { this.visible = true; }
  didHide() { this.visible = false; }

  didFocus(event) {
    // Called by text-editor-element's focus listener (which fires for both
    // the synthetic focus event we dispatch in element.focus() and any
    // native focus events). Just update state — do not forward to the hidden
    // input here, because we are still inside the focus event dispatch and
    // other listeners (autocomplete-plus etc.) haven't run yet.
    if (!this.focused) {
      this.focused = true;
      this.element.classList.add('is-focused');
      if (this._restartBlink) this._restartBlink();
    }
  }

  didBlur(event) {
    // Critical: when focus is just transferring from the editor element
    // to its own hidden input child, treat that as "still focused" and
    // stop the blur from propagating. Without this, downstream blur
    // listeners (e.g. atom-select-list's `didLoseFocus`, which thinks
    // the dialog has been dismissed and re-focuses the element, causing
    // an infinite focus → didFocus → hiddenInput.focus → blur loop)
    // misbehave. This mirrors the legacy editor's `didBlur` behavior.
    if (event && event.relatedTarget === this.hiddenInput) {
      event.stopImmediatePropagation();
      return;
    }
    if (this.focused) {
      this.focused = false;
      this.element.classList.remove('is-focused');
    }
  }

  _updateGrammarDataset() {
    const grammar = this.props.model.getGrammar && this.props.model.getGrammar();
    if (grammar && grammar.scopeName) {
      this.element.dataset.grammar = grammar.scopeName.replace(/\./g, ' ');
    } else {
      delete this.element.dataset.grammar;
    }
  }

  // Called by the static `didUpdateStyles` (which Atom themes invoke
  // when stylesheets change) — re-measure font metrics and force a
  // re-render so cursor/line positions track the new sizes.
  didUpdateStyles() {
    if (this._measure) this._measure();
    if (this._notifyDisplayChange) this._notifyDisplayChange();
  }
  didUpdateScrollbarStyles() {}

  // --- Model callbacks --------------------------------------------------

  didChangeDisplayLayer(_changes) {
    if (this._notifyDisplayChange) this._notifyDisplayChange();
    if (this._notifySelectionChange) this._notifySelectionChange();
  }

  didResetDisplayLayer() {
    if (this._notifyDisplayChange) this._notifyDisplayChange();
    if (this._notifySelectionChange) this._notifySelectionChange();
  }

  didChangeSelectionRange() {
    if (this._notifySelectionChange) this._notifySelectionChange();
    if (this._restartBlink) this._restartBlink();
  }

  didUpdateSelections() {
    if (this._notifySelectionChange) this._notifySelectionChange();
    if (this._restartBlink) this._restartBlink();
  }

  didRequestAutoscroll(autoscroll) {
    if (!autoscroll || !this._scroller || !this._lineHeight) return;
    const { screenRange, options } = autoscroll;
    if (!screenRange) return;
    this._autoscrollVertically(screenRange, options);
    this._autoscrollHorizontally(screenRange, options);
  }

  _autoscrollVertically(screenRange, options) {
    const lh = this._lineHeight;
    // Account for block decorations above each row so autoscroll lands
    // on the visible top of the line, not the unblocked `row * lh`
    // estimate that would leave the line clipped under preceding
    // block-decoration content.
    const startPx = this._pixelTopForRow
      ? this._pixelTopForRow(screenRange.start.row)
      : screenRange.start.row * lh;
    const endPx = (this._pixelTopForRow
      ? this._pixelTopForRow(screenRange.end.row)
      : screenRange.end.row * lh) + lh;

    // SolidJS re-renders asynchronously, so when a new row is added the
    // bottom spacer DOM height may not yet reflect the new row count.
    // The browser silently clamps scrollTop to scrollHeight - clientHeight,
    // so we expand the spacer imperatively before adjusting scrollTop to
    // ensure the full content height is available immediately.
    if (this._bottomSpacer) {
      const totalHeight = this.props.model.getScreenLineCount() * lh;
      if (this._scroller.scrollHeight < totalHeight) {
        const current = parseInt(this._bottomSpacer.style.height || '0', 10);
        const deficit = totalHeight - this._scroller.scrollHeight;
        this._bottomSpacer.style.height = (current + deficit) + 'px';
      }
    }

    const viewH = this._scroller.clientHeight;
    const marginLines = Math.min(
      this.props.model && this.props.model.verticalScrollMargin != null
        ? this.props.model.verticalScrollMargin
        : DEFAULT_VERTICAL_SCROLL_MARGIN,
      Math.max(0, Math.floor((viewH / lh - 1) / 2))
    );
    const margin = marginLines * lh;

    if (options && options.center) {
      const center = (startPx + endPx) / 2;
      this._scroller.scrollTop = center - viewH / 2;
      return;
    }

    if (!options || options.reversed !== false) {
      if (endPx + margin > this._scroller.scrollTop + viewH) {
        this._scroller.scrollTop = endPx + margin - viewH;
      }
      if (startPx - margin < this._scroller.scrollTop) {
        this._scroller.scrollTop = Math.max(0, startPx - margin);
      }
    } else {
      if (startPx - margin < this._scroller.scrollTop) {
        this._scroller.scrollTop = Math.max(0, startPx - margin);
      }
      if (endPx + margin > this._scroller.scrollTop + viewH) {
        this._scroller.scrollTop = endPx + margin - viewH;
      }
    }
  }

  _autoscrollHorizontally(screenRange, options) {
    const cw = this._charWidth;
    if (!cw || !this._scroller) return;
    const startPx = screenRange.start.column * cw;
    const endPx = screenRange.end.column * cw;
    const viewW = this._scroller.clientWidth;
    const marginCols = Math.min(
      this.props.model && this.props.model.horizontalScrollMargin != null
        ? this.props.model.horizontalScrollMargin
        : DEFAULT_HORIZONTAL_SCROLL_MARGIN,
      Math.max(0, Math.floor((viewW / cw - 1) / 2))
    );
    const margin = marginCols * cw;

    if (!options || options.reversed !== false) {
      if (endPx + margin > this._scroller.scrollLeft + viewW) {
        this._scroller.scrollLeft = endPx + margin - viewW;
      }
      if (startPx - margin < this._scroller.scrollLeft) {
        this._scroller.scrollLeft = Math.max(0, startPx - margin);
      }
    } else {
      if (startPx - margin < this._scroller.scrollLeft) {
        this._scroller.scrollLeft = Math.max(0, startPx - margin);
      }
      if (endPx + margin > this._scroller.scrollLeft + viewW) {
        this._scroller.scrollLeft = endPx + margin - viewW;
      }
    }
  }

  // Called by text-editor.js when a `type: 'block'` decoration is
  // created via `editor.decorateMarker(...)`. Forward to the Solid-side
  // tracker so it can render the item between the appropriate lines.
  addBlockDecoration(decoration) {
    if (this._addBlockDecoration) this._addBlockDecoration(decoration);
  }
  // Triggered by callers that change the dimensions of a previously
  // measured block (e.g. autocomplete-plus rebuilding its suggestion
  // list). The ResizeObserver wired up in `_addBlockDecoration` already
  // catches size changes, so this is a no-op — but keep the method
  // around for ABI compatibility.
  invalidateBlockDecorationDimensions(_decoration) {}

  // --- Position / measurement queries -----------------------------------

  pixelPositionForScreenPosition(screenPosition) {
    if (!screenPosition) return { top: 0, left: 0 };
    const row = screenPosition.row || 0;
    // Use the Solid editor's `pixelTopForRow` when available so callers
    // that position UI relative to a row (overlay decorations,
    // autocomplete-plus suggestion list) get the post-block-decoration
    // pixel top. Falls back to a simple `row * lineHeight` if the Solid
    // component hasn't mounted yet.
    const top = this._pixelTopForRow
      ? this._pixelTopForRow(row)
      : row * this._lineHeight;
    return {
      top,
      left: (screenPosition.column || 0) * this._charWidth
    };
  }

  screenPositionForPixelPosition({ top, left }) {
    const lh = this._lineHeight;
    const cw = this._charWidth;
    if (!lh) return this.props.model.clipScreenPosition([0, 0]);
    const row = this._rowAtPixel ? this._rowAtPixel(top) : Math.max(0, Math.floor(top / lh));
    const col = Math.max(0, Math.round(left / (cw || 1)));
    return this.props.model.clipScreenPosition([row, col]);
  }

  pixelRangeForScreenRange(range) {
    return {
      start: this.pixelPositionForScreenPosition(range && range.start),
      end: this.pixelPositionForScreenPosition(range && range.end)
    };
  }

  renderedScreenLineForRow(_row) { return null; }
  measureDimensions() {}

  // --- Dimensions -------------------------------------------------------

  getLineHeight() {
    return this._lineHeight || 0;
  }
  getBaseCharacterWidth() { return this._charWidth || 0; }

  getContentHeight() {
    return this.props.model.getScreenLineCount() * (this._lineHeight || 0);
  }

  getContentWidth() {
    return (
      (this.props.model.getMaxScreenLineLength
        ? this.props.model.getMaxScreenLineLength()
        : 0) * (this._charWidth || 0)
    );
  }

  getClientContainerHeight() {
    return this._scroller ? this._scroller.clientHeight : (this.element ? this.element.clientHeight : 0);
  }

  getClientContainerWidth() {
    return this._scroller ? this._scroller.clientWidth : (this.element ? this.element.clientWidth : 0);
  }

  getScrollContainerHeight() { return this.getClientContainerHeight(); }
  getScrollContainerWidth() { return this.getClientContainerWidth(); }
  getScrollContainerClientHeight() { return this.getClientContainerHeight(); }

  getVerticalScrollbarWidth() { return 0; }
  getHorizontalScrollbarHeight() { return 0; }
  getGutterContainerWidth() { return 0; }

  // --- Scroll -----------------------------------------------------------

  getScrollTop() { return this._scroller ? this._scroller.scrollTop : this.scrollTop; }
  setScrollTop(top) {
    const v = Math.max(0, top || 0);
    this.scrollTop = v;
    if (this._scroller) this._scroller.scrollTop = v;
    return v;
  }

  getScrollLeft() { return this._scroller ? this._scroller.scrollLeft : this.scrollLeft; }
  setScrollLeft(left) {
    const v = Math.max(0, left || 0);
    this.scrollLeft = v;
    if (this._scroller) this._scroller.scrollLeft = v;
    return v;
  }

  getScrollBottom() { return this.getScrollTop() + this.getClientContainerHeight(); }
  setScrollBottom(bottom) { return this.setScrollTop(bottom - this.getClientContainerHeight()); }

  getScrollRight() { return this.getScrollLeft() + this.getClientContainerWidth(); }
  setScrollRight(right) { return this.setScrollLeft(right - this.getClientContainerWidth()); }

  getScrollHeight() { return this.getContentHeight(); }
  getScrollWidth() { return this.getContentWidth(); }

  getMaxScrollTop() {
    return Math.max(0, this.getScrollHeight() - this.getClientContainerHeight());
  }
  getMaxScrollLeft() {
    return Math.max(0, this.getScrollWidth() - this.getClientContainerWidth());
  }

  getScrollTopRow() {
    return this._lineHeight ? Math.floor(this.getScrollTop() / this._lineHeight) : 0;
  }
  setScrollTopRow(row) {
    if (this._lineHeight) this.setScrollTop(row * this._lineHeight);
  }
  getScrollLeftColumn() {
    return this._charWidth ? Math.floor(this.getScrollLeft() / this._charWidth) : 0;
  }
  setScrollLeftColumn(column) {
    if (this._charWidth) this.setScrollLeft(column * this._charWidth);
  }

  // --- Viewport ---------------------------------------------------------

  getFirstVisibleRow() { return this.getScrollTopRow(); }
  getLastVisibleRow() {
    const lh = this._lineHeight;
    if (!lh) return 0;
    return Math.min(
      this.props.model.getScreenLineCount() - 1,
      Math.floor((this.getScrollTop() + this.getClientContainerHeight()) / lh)
    );
  }
  getFirstVisibleColumn() { return this.getScrollLeftColumn(); }

  getRenderedStartRow() { return 0; }
  getRenderedEndRow() { return this.props.model.getScreenLineCount(); }

  // --- Input ------------------------------------------------------------

  setInputEnabled(enabled) { this.inputEnabled = enabled !== false; }
  getHiddenInput() { return this.hiddenInput; }

  // --- Decoration / gutter queries -------------------------------------

  queryGuttersToRender() {
    return this.props.model ? [this.props.model.getLineNumberGutter()] : [];
  }

  queryDecorationsToRender() {}

  // --- Block decorations -------------------------------------------------

  // Discovery loop: scan the model's current decorations for blocks the
  // Editor solid component hasn't tracked yet, register them. Also drop
  // any blocks whose decoration is no longer on the model (in case
  // we missed a destroy event).
  _syncBlockDecorations() {
    const model = this.props.model;
    if (!model || !model.decorationManager) return;
    if (!this._addBlockDecoration) return; // Solid component not mounted yet.
    const all = model.decorationManager.getDecorations
      ? model.decorationManager.getDecorations()
      : [];
    const live = new Set();
    for (const decoration of all) {
      if (!decoration.isType || !decoration.isType('block')) continue;
      live.add(decoration);
      this._addBlockDecoration(decoration);
    }
  }

  // --- Overlay decorations -----------------------------------------------

  _syncOverlayDecorations() {
    const model = this.props.model;
    if (!model || !model.decorationManager) return;

    // Collect all live overlay decorations from the model.
    const liveDecorations = new Set();
    const allDecorations = model.decorationManager.getDecorations
      ? model.decorationManager.getDecorations()
      : [];
    for (const decoration of allDecorations) {
      if (!decoration.isType('overlay')) continue;
      liveDecorations.add(decoration);
      if (!this._overlays.has(decoration)) {
        this._addOverlay(decoration);
      } else {
        this._positionOverlay(decoration);
      }
    }

    // Remove overlays whose decorations no longer exist.
    for (const [decoration, entry] of this._overlays) {
      if (!liveDecorations.has(decoration)) {
        this._removeOverlay(decoration, entry);
      }
    }
  }

  _addOverlay(decoration) {
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
    this.element.appendChild(wrapperEl);

    const resizeObserver = new ResizeObserver(() => {
      this._positionOverlay(decoration);
    });
    resizeObserver.observe(itemEl);

    // Listen for the decoration being destroyed so we remove the overlay.
    let destroySub = null;
    if (decoration.onDidDestroy) {
      destroySub = decoration.onDidDestroy(() => {
        const entry = this._overlays.get(decoration);
        if (entry) this._removeOverlay(decoration, entry);
      });
    }

    // Listen for marker changes so we reposition the overlay.
    let markerSub = null;
    const marker = decoration.getMarker ? decoration.getMarker() : null;
    if (marker && marker.onDidChange) {
      markerSub = marker.onDidChange(() => this._positionOverlay(decoration));
    }

    this._overlays.set(decoration, { wrapperEl, resizeObserver, destroySub, markerSub });
    this._positionOverlay(decoration);
  }

  _positionOverlay(decoration) {
    const entry = this._overlays.get(decoration);
    if (!entry) return;
    const { wrapperEl } = entry;

    const props = decoration.getProperties ? decoration.getProperties() : decoration.properties;
    if (!props) return;
    const marker = decoration.getMarker ? decoration.getMarker() : null;
    if (!marker) return;

    const screenPosition = props.position === 'tail'
      ? marker.getTailScreenPosition()
      : marker.getHeadScreenPosition();

    const lh = this._lineHeight;
    const cw = this._charWidth;
    if (!lh || !cw || !this._scroller) return;

    // `contain: layout` on atom-text-editor makes it the containing block for
    // `position: fixed` children — so coordinates must be relative to the
    // editor element, not the viewport.
    //
    // We use offsetTop/offsetLeft (static geometry, no reflow) to find the
    // scroller's position within the editor, avoiding forced layouts on every
    // scroll event which would fight the browser's pending scrollTop updates.
    const scrollerOffsetTop = this._scroller.offsetTop;
    const scrollerOffsetLeft = this._scroller.offsetLeft;
    const pixelTop = (this._pixelTopForRow
      ? this._pixelTopForRow(screenPosition.row)
      : screenPosition.row * lh) - this._scroller.scrollTop;
    const pixelLeft = screenPosition.column * cw - this._scroller.scrollLeft;

    let top = scrollerOffsetTop + pixelTop + lh;
    let left = scrollerOffsetLeft + pixelLeft;

    // Overflow avoidance: compare absolute viewport positions so we can
    // check against window bounds. getBoundingClientRect() here is fine
    // because it only runs when the overlay is first shown or resized,
    // not on every scroll tick.
    const itemEl = wrapperEl.firstChild;
    if (itemEl) {
      const itemRect = itemEl.getBoundingClientRect();
      const editorRect = this.element.getBoundingClientRect();
      const windowH = window.innerHeight;
      const windowW = window.innerWidth;
      const absTop = editorRect.top + top;
      if (absTop + itemRect.height > windowH) {
        const flippedTop = scrollerOffsetTop + pixelTop - itemRect.height;
        if (editorRect.top + flippedTop >= 0) top = flippedTop;
      }
      const absLeft = editorRect.left + left;
      if (absLeft + itemRect.width > windowW) {
        left = Math.max(-editorRect.left, windowW - editorRect.left - itemRect.width);
      }
      if (absLeft < 0) left = -editorRect.left;
    }

    wrapperEl.style.top = Math.round(top) + 'px';
    wrapperEl.style.left = Math.round(left) + 'px';
  }

  _removeOverlay(decoration, entry) {
    if (!entry) return;
    const { wrapperEl, resizeObserver, destroySub, markerSub } = entry;
    resizeObserver.disconnect();
    if (destroySub) destroySub.dispose();
    if (markerSub) markerSub.dispose();
    if (wrapperEl.parentNode) wrapperEl.parentNode.removeChild(wrapperEl);
    this._overlays.delete(decoration);
  }

  _destroyAllOverlays() {
    for (const [decoration, entry] of this._overlays) {
      this._removeOverlay(decoration, entry);
    }
  }
}

PulsarTextEditorComponent.attachedComponents = null;

module.exports = PulsarTextEditorComponent;
