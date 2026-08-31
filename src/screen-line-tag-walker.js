// Walks the tag stream of a screen line and emits scope/text events.
//
// Behavioral note vs. the previous (Etch) implementation: scopes whose
// content is entirely invisible (either because they fall outside the
// supplied `visibleColumnRange` or simply because they contain no text)
// are not emitted. The previous implementation eagerly created an empty
// `<span class="syntax--…">` for every open tag regardless of content;
// CSS that targets `:empty` syntax spans would observe the change.
//
// The display layer encodes a screen line as a `tags` array interleaving
// scope-open IDs (negative), scope-close IDs (negative), and positive
// integers representing the character length of the next text run. This
// walker drives DOM emission for `LineComponent` (Etch) and the future
// SolidJS `<Line>` from a single implementation, and adds optional
// column-range trimming so very long lines (e.g. minified JS) only emit
// DOM nodes for the columns currently visible in the viewport.
//
// Inputs:
//   tags, lineText      - from `screenLine` (or from a windowed-token hook,
//                         see below)
//   displayLayer        - exposes `isOpenTag`, `isCloseTag`, `classNameForTag`
//   textDecorations     - optional array of {column, className, style}
//   visibleColumnRange  - optional [startCol, endCol]; when set, text runs
//                         outside the range are not emitted and partially-
//                         visible runs are clipped. Scope opens/closes are
//                         always emitted so the surrounding span structure
//                         remains valid around the visible text.
//   initialScopes       - optional array of scope tag IDs that are already
//                         open at column 0 of the supplied tag stream.
//                         Used together with the optional `getScreenLineTokens`
//                         hook described below.
//
// Callbacks (any may be omitted):
//   onOpenScope(className)
//   onCloseScope()
//   onTextRun(text, decorationClassName, decorationStyle)
//
// Optional display-layer hook contract:
//
//   displayLayer.getScreenLineTokens(screenRow, startColumn, endColumn)
//     -> { tags, lineText, openScopes } | null
//
//   When present, returns a tag stream covering only columns
//   [startColumn, endColumn] of the given screen row, plus the array of
//   scope tag IDs that are open at startColumn. The consumer feeds these
//   into the walker via `tags`, `lineText`, and `initialScopes` and omits
//   `visibleColumnRange`. Returning null tells the consumer to fall back
//   to the full screen line and the in-walker column trim. The hook is
//   optional; language modes that can produce pre-windowed tokens (e.g.
//   to skip parsing the entire 100k-character line) should implement it.
function walkScreenLineTags(options) {
  const {
    tags,
    lineText,
    displayLayer,
    textDecorations,
    visibleColumnRange,
    initialScopes,
    onOpenScope,
    onCloseScope,
    onTextRun
  } = options;

  const visStart = visibleColumnRange ? visibleColumnRange[0] : 0;
  const visEnd = visibleColumnRange ? visibleColumnRange[1] : Infinity;

  // Two stacks: `logical` holds every scope that is logically open at the
  // current column. `physicalDepth` is how many of those have actually been
  // emitted to the consumer. When a text run inside the visible range is
  // about to be emitted we lazily flush any pending opens; when a logical
  // scope closes we only emit a close if it had been physically emitted.
  // For invisible regions of a long line this means we touch O(visible)
  // DOM nodes, not O(line length).
  const logical = [];
  let physicalDepth = 0;

  if (initialScopes) {
    for (let i = 0; i < initialScopes.length; i++) {
      const className = displayLayer.classNameForTag(initialScopes[i]);
      logical.push(className);
      if (onOpenScope) onOpenScope(className);
      physicalDepth++;
    }
  }

  const flushPendingOpens = () => {
    if (!onOpenScope) {
      physicalDepth = logical.length;
      return;
    }
    while (physicalDepth < logical.length) {
      onOpenScope(logical[physicalDepth]);
      physicalDepth++;
    }
  };

  let column = 0;
  let decorationIndex = 0;
  let nextDecoration = textDecorations
    ? textDecorations[decorationIndex]
    : null;
  let activeClassName = null;
  let activeStyle = null;
  if (nextDecoration && nextDecoration.column === 0) {
    activeClassName = nextDecoration.className;
    activeStyle = nextDecoration.style;
    nextDecoration = textDecorations[++decorationIndex];
  }

  const emitClipped = (from, to, className, style) => {
    if (!onTextRun) return;
    const clippedFrom = from < visStart ? visStart : from;
    const clippedTo = to > visEnd ? visEnd : to;
    if (clippedFrom >= clippedTo) return;
    flushPendingOpens();
    const text =
      clippedFrom === from && clippedTo === to
        ? lineText.substring(from, to)
        : lineText.substring(clippedFrom, clippedTo);
    onTextRun(text, className, style);
  };

  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i];
    if (tag === 0) continue;

    if (displayLayer.isCloseTag(tag)) {
      logical.pop();
      if (physicalDepth > logical.length) {
        if (onCloseScope) onCloseScope();
        physicalDepth--;
      }
    } else if (displayLayer.isOpenTag(tag)) {
      logical.push(displayLayer.classNameForTag(tag));
    } else {
      const nextTokenColumn = column + tag;

      // Skip text runs entirely past the visible end. We still continue
      // walking so any remaining close-scope tags can pop the stack, but
      // text emission stops contributing visible nodes.
      if (column >= visEnd) {
        column = nextTokenColumn;
        while (nextDecoration && nextDecoration.column <= nextTokenColumn) {
          activeClassName = nextDecoration.className;
          activeStyle = nextDecoration.style;
          nextDecoration = textDecorations[++decorationIndex];
        }
        continue;
      }

      while (nextDecoration && nextDecoration.column <= nextTokenColumn) {
        emitClipped(
          column,
          nextDecoration.column,
          activeClassName,
          activeStyle
        );
        column = nextDecoration.column;
        activeClassName = nextDecoration.className;
        activeStyle = nextDecoration.style;
        nextDecoration = textDecorations[++decorationIndex];
      }

      if (column < nextTokenColumn) {
        emitClipped(column, nextTokenColumn, activeClassName, activeStyle);
        column = nextTokenColumn;
      }
    }
  }

  // Close any scopes still physically open. (Well-formed tag streams should
  // close everything they open, but be defensive.)
  while (physicalDepth > 0) {
    if (onCloseScope) onCloseScope();
    physicalDepth--;
  }

  return column;
}

module.exports = { walkScreenLineTags };
