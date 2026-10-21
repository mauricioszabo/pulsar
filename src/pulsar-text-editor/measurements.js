'use strict';

// Creates the measurement infrastructure for deriving line height and
// character width from the browser's font rendering. Unlike the Solid version,
// this returns a plain DOM builder (`appendFixtureToEl`) instead of a JSX
// component, so it can be called anywhere without a Solid render context.
//
// Returns `{ measure, appendFixtureToEl, measureRO }` where:
//   - `measure()` reads the fixture's bounding rects, updates the component
//     and model, calls `onMeasure(lh, cw)`, and returns true on success.
//   - `appendFixtureToEl(parentEl)` creates the hidden off-screen measurement
//     div, appends it to parentEl, and wires the ResizeObserver.
//   - `measureRO` is the ResizeObserver already observing the fixture's inner
//     `.measure-line` element. Caller must call `measureRO.disconnect()` on
//     cleanup.
function createMeasurement({ component, model, onMeasure }) {
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
    component._lineHeight = lh;
    component._charWidth = cw;
    if (model.setLineHeightInPixels) model.setLineHeightInPixels(lh);
    if (model.setDefaultCharWidth) model.setDefaultCharWidth(cw, cw, cw, cw);
    if (onMeasure) onMeasure(lh, cw);
    return true;
  };

  const measureRO = new ResizeObserver(() => { measure(); });

  const appendFixtureToEl = (parentEl) => {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('aria-hidden', 'true');
    wrapper.style.cssText =
      'position: absolute; left: -9999px; top: 0; ' +
      'visibility: hidden; pointer-events: none;';
    const measureLine = document.createElement('div');
    measureLine.className = 'measure-line';
    measureLine.style.cssText = 'display: block; white-space: pre;';
    const measureChars = document.createElement('span');
    measureChars.className = 'measure-chars';
    measureChars.textContent = 'x'.repeat(100);
    measureLine.appendChild(measureChars);
    wrapper.appendChild(measureLine);
    parentEl.appendChild(wrapper);
    _measureEl = wrapper;
    measureRO.observe(measureLine);
  };

  return { measure, appendFixtureToEl, measureRO };
}

module.exports = { createMeasurement };
