'use babel';

// Creates the measurement infrastructure for deriving line height and
// character width from the browser's font rendering.
//
// Returns `{ measure, MeasureFixture, measureRO }` where:
//   - `measure()` reads the fixture's bounding rects, updates signals and
//     model, and returns true on success.
//   - `MeasureFixture` is a Solid JSX component that renders the hidden
//     off-screen measurement div and wires the ref internally.
//   - `measureRO` is a ResizeObserver already observing the fixture's inner
//     `.measure-line` element so zoom/font changes re-trigger measurement.
//     Caller must call `measureRO.disconnect()` on cleanup.
function createMeasurement({ component, model, setLineHeight, setCharWidth }) {
  let _measureEl = null;

  const measure = () => {
    if (!_measureEl) return false;
    const lineEl = _measureEl.querySelector('.measure-line');
    const spanEl = _measureEl.querySelector('.measure-chars');
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
    if (model.setLineHeightInPixels) model.setLineHeightInPixels(lh);
    if (model.setDefaultCharWidth) model.setDefaultCharWidth(cw, cw, cw, cw);
    return true;
  };

  const measureRO = new ResizeObserver(() => { measure(); });

  function MeasureFixture() {
    return (
      <div
        ref={(el) => {
          _measureEl = el;
          if (el) {
            const lineEl = el.querySelector('.measure-line');
            if (lineEl) measureRO.observe(lineEl);
          }
        }}
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
    );
  }

  return { measure, MeasureFixture, measureRO };
}

module.exports = { createMeasurement };
