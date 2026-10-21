---
status: accepted
date: 2026-05-02
deciders: mauricioszabo
---
# Replace Etch-based TextEditorComponent with SolidJS, via runtime-swappable coexistence

## Context and Problem Statement

`src/text-editor-component.js` is a 5,672-line file written against [Etch](https://github.com/atom/etch), a virtual-DOM library that has been unmaintained since ~2018 and pinned at `etch@0.14.1`. Pulsar is its only large production consumer. The original authors of `text-editor-component.js` are no longer on the team and the code is, in practical terms, lost knowledge — nobody currently maintaining Pulsar can reliably reason about it line-by-line.

This creates two problems:

1. We carry an indefinitely-deferred maintenance debt for a defunct dependency.
2. A specific user-visible bug — minified-JS lines (single-line files of 100k+ characters) freeze the editor — is wedged inside this code, with no API surface available for language modes to participate in fixing it.

## Decision Drivers

- The Etch dependency must eventually be removed; staying on it is not viable.
- We have **no capacity to review a 5,700-line component port line-by-line** because the existing code is not understood in detail by any current maintainer. Any migration plan that depends on bug-for-bug parity verification by humans is unrealistic.
- A migration that produces a half-broken editor *we cannot opt into* delivers nothing usable until the very end. Worse, it forces the team to choose between "ship something broken to everyone" and "wait years."
- Pulsar packages depend on the public API of `TextEditorComponent`. The contract must hold across the migration.
- Long-line syntax highlighting is a real performance bug that is independently valuable to fix and should not be gated on the migration.

## Considered Options

1. **Atomic in-place rewrite.** Replace `text-editor-component.js` wholesale in one PR.
2. **Sub-component-by-sub-component port** within the same file, one Etch class at a time.
3. **Parallel scaffold + cutover.** Build a SolidJS implementation in a new file alongside the Etch one, switch the `require()` once it's "done."
4. **Coexistence via runtime config flag** *(this ADR's choice).* Build a SolidJS implementation under `src/pulsar-text-editor/`, gated behind a `core.useNewTextEditor` config key. Both implementations ship; users opt in per install. The Etch implementation stays intact and unmodified during the migration.

## Decision Outcome

**Chosen: option 4 (runtime-swappable coexistence).**

Justification:

- It is the only option where intermediate progress is *runnable and reversible*. A user who flips the flag and hits a bug switches it back; no revert needed.
- It treats the Etch component as **dead, read-only code**. Nothing the migration does can break what is currently working.
- It accepts that bug-for-bug parity is not a goal. The bar for the new editor is "tests pass + you can edit and save a file," not "behavior identical to Etch in every edge case."
- It collapses the false dilemma between "ship broken to everyone" and "wait years" by introducing a third state: "ship working code; ship broken-but-improving code behind a flag."

### Consequences

- **Good:** Zero risk to current users until the flag flips. No emergency reverts.
- **Good:** Each commit after the MVP is *individually testable* by switching the flag, opening a file, and feeling the difference.
- **Good:** The Etch file is never touched, which means no merge conflicts with unrelated work and no risk of breaking what works.
- **Bad:** Two implementations exist in the repo simultaneously for a period (likely months). Maintenance overhead, but only the new one is changing.
- **Bad:** Final cleanup (removing Etch) is its own commit later, requiring confidence that the Solid implementation is good enough to be the default and then the only.
- **Neutral:** External packages calling editor APIs see the *new* implementation when the flag is on. API stubs prevent crashes; affected features may not work fully until subsequent commits flesh them out.

## Sequencing constraint (important)

A commit on this migration is "useful" **only when it produces a switchable editor** — even one that is broken in obvious ways. This is non-negotiable for a specific reason: we cannot validate "scrolling works" or "syntax highlighting works" in isolation if the editor cannot be opened. There is no test surface for a half-component.

This means:

- **Commit A (foundation, *no behavior change*):** Scaffold `src/pulsar-text-editor/`. Add `core.useNewTextEditor` config (default `false`). Wire the swap point in `src/text-editor-element.js`. New implementation is a class with the **full public API surface** (constructor, `update`, `pixelPositionForScreenPosition`, scroll/dimension getters, viewport getters, `getNextUpdatePromise`, `setInputEnabled`, `getHiddenInput`, the static methods, etc.) but every method is a stub returning a reasonable default. With the flag on, you'd see a blank box and nothing crashes. With the flag off (default), nothing changes. **Important:** the Babel `overrides` regex in `src/babel.config.js` currently matches `/text-editor-component\.js$/` only and **must be widened** to also match files under `src/pulsar-text-editor/` so the SolidJS JSX transform applies there. The handing-off agent flagged this; do not skip it.

- **Commit B (the MVP, expected to span multiple sessions):** A *whole text editor attempt*. Renders text. Syntax-highlights using the existing `src/screen-line-tag-walker.js` helper (already in place from the long-line fix). Scrolls vertically. Hidden input captures keystrokes and feeds the model. Visible (non-blinking is fine) cursor. Save works (lives on the model, not the component, so it's free). When this commit lands, flipping the flag opens a usable but rough editor. Things expected to be missing or broken on day one: gutters, mouse interaction, decorations, block decorations, IME, cursor blinking, overlays, soft wrap, find-and-replace UI integration. That is acceptable — fix in subsequent commits.

- **Commits C+ (fill in the rough edges):** Each commit makes the new editor more livable. Order is opportunistic — fix what is most painful next.

- **Cutover (much later):** When the spec parity is high enough and dogfooding has shown the new editor is dependable, flip the default to `true`. After more soak time, delete `src/text-editor-component.js` and `etch` from `package.json`.

## Validation

- `spec/text-editor-component-spec.js` (148 `it` blocks) is run against **both** implementations as the migration progresses. Track green/red ratio per implementation. Cutover is gated on the new implementation reaching substantial parity.
- The migration is also validated by hand: with the flag on, can you open a file, edit it, save it? Each commit moves "yes, with these caveats" forward.

## Library and authoring choices (already settled)

- **SolidJS** for the rendering layer. Fine-grained reactivity, no virtual DOM, MIT, ~7 KB, actively maintained. Detailed comparison vs. SonnetJS (rejected — unmaintained, virtual-DOM, hobby project) and other alternatives lives in the conversation that produced this ADR.
- **JSX via `babel-preset-solid`** (already added to `package.json`, already wired into `src/babel.config.js` as a scoped override). The Pulsar Babel pipeline is opt-in per file via the `'use babel'` / `/** @babel */` header (see `src/babel.js`). Files under `src/pulsar-text-editor/` will need that header to participate in the JSX transform.
- **Authoring not chosen:** hyperscript (`solid-js/h`, ~15% slower per Solid's maintainer) and tagged templates (`solid-js/html`, slightly slower than JSX, larger non-treeshakeable runtime).

## Already-landed prerequisites (do not redo)

- `c519735` "Virtualize long-line syntax highlighting" — extracted `src/screen-line-tag-walker.js` (a pure helper that walks a screen line's tag stream and emits scope/text events, with column-range trimming and lazy scope emission). Used by the existing Etch `LineComponent` today; will be reused unchanged by the SolidJS `<Line>` component.
- `1905746` "Add solid-js and babel-preset-solid for the upcoming TextEditorComponent rewrite" — `solid-js@1.9.3` and `babel-preset-solid@1.9.3` declared; `src/babel.config.js` has the scoped `overrides` entry. **Note for the next agent:** the override regex matches `/text-editor-component\.js$/` only; widen it to also cover `src/pulsar-text-editor/` when starting Commit A.

## Public API surface to preserve (the contract)

The new implementation must expose, at minimum, the following public methods/properties that external callers (`text-editor.js`, `text-editor-element.js`, packages) rely on. Stubs are acceptable in Commit A; correct behavior fills in across Commit B+.

- Constructor: `new Component(props)` where props include `model`, `element`, `mini`, `readOnly`, `updatedSynchronously`, `cursorBlinkResumeDelay`, `initialScrollTopRow`, `initialScrollLeftColumn`.
- `update(props)`
- `pixelPositionForScreenPosition()`, `renderedScreenLineForRow()`
- Scroll: `setScrollTop`, `getScrollTop`, `setScrollLeft`, `getScrollLeft`, `setScrollBottom`, `getScrollRight`
- Dimensions: `getLineHeight`, `getBaseCharacterWidth`, `getContentHeight`, `getContentWidth`, `getClientContainerHeight`, `getClientContainerWidth`, `getVerticalScrollbarWidth`, `getHorizontalScrollbarHeight`
- Viewport: `getFirstVisibleRow`, `getLastVisibleRow`, `getRenderedStartRow`, `getRenderedEndRow`
- `getNextUpdatePromise`, `setInputEnabled`, `getHiddenInput`, `queryGuttersToRender`, `queryDecorationsToRender`
- Static: `setScheduler`, `getScheduler` (kept as deprecated no-ops — Solid has no central scheduler), `didUpdateStyles`, `didUpdateScrollbarStyles`

## More Information

- The Etch component is at `src/text-editor-component.js` (5,672 lines, 12 sub-component classes). It is to be treated as **dead, read-only code** during this migration.
- The `screen-line-tag-walker.js` helper is the single piece of internal API the new editor will share with the old. Its docblock describes both the basic walk and the optional `displayLayer.getScreenLineTokens(row, startColumn, endColumn)` hook that language modes may eventually implement to skip producing tags outside the visible range. The hook is currently unimplemented in any language mode; the in-walker column-range trim is the default.
- The 148-test `spec/text-editor-component-spec.js` is the authoritative behavioral oracle. It uses Pulsar's Atom-environment Jasmine runner and cannot easily be run outside Pulsar's Electron build.
