// Display-pipeline benchmark: measures the editor rendering hot paths
// (scrolling, typing, soft wrap, very long lines) through the real
// TextEditorComponent. Skipped unless PULSAR_BENCHMARK=1.
//
//   PULSAR_BENCHMARK=1 yarn test:only spec/display-pipeline-benchmark-spec.js
//
// Results are printed and written as JSON to $PULSAR_BENCHMARK_OUT (default:
// <tmpdir>/pulsar-display-pipeline-benchmark.json).

const fs = require('fs');
const os = require('os');
const path = require('path');
const superstring = require('@pulsar-edit/superstring');
const TextEditorComponent = require('../src/text-editor-component');
const TextEditor = require('../src/text-editor');
const TextBuffer = require('@pulsar-edit/text-buffer');

const ENABLED = process.env.PULSAR_BENCHMARK === '1';
const describeBenchmark = ENABLED ? describe : xdescribe;

// Deterministic PRNG so every branch renders exactly the same input.
function createRandom(seed) {
  let state = seed >>> 0;
  return n => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return Math.floor((state / 0x100000000) * n);
  };
}

const JS_LINES = [
  'const value = callback(result, 42);',
  'function display(layer, screen) {',
  '  return layer.translate(screen.row, screen.column); // map it',
  "  const message = 'screen line ' + row + \" of \" + count;",
  '  if (position.row > range.end.row) { return null; }',
  '  for (let i = 0; i < lines.length; i++) { total += lines[i].length; }',
  '}',
  '',
  '/* block comment describing the buffer */',
  'export class Buffer extends Base { constructor() { super(); this.rows = []; } }'
];

function buildJavaScriptText(random, lineCount, longLines = false) {
  const lines = [];
  for (let i = 0; i < lineCount; i++) {
    let line = JS_LINES[random(JS_LINES.length)];
    if (longLines) {
      const repeat = 1 + random(8);
      for (let j = 0; j < repeat; j++) line += ' ' + JS_LINES[random(JS_LINES.length)];
    }
    lines.push(line);
  }
  return lines.join('\n') + '\n';
}

// Count calls into superstring's native classes.
const nativeCalls = { count: 0 };
let instrumented = false;
function instrumentNativeCalls() {
  if (instrumented) return;
  instrumented = true;
  for (const exportName of Object.keys(superstring)) {
    const klass = superstring[exportName];
    if (typeof klass !== 'function' || !klass.prototype) continue;
    for (const key of Object.getOwnPropertyNames(klass.prototype)) {
      if (key === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(klass.prototype, key);
      if (!descriptor || typeof descriptor.value !== 'function') continue;
      const original = descriptor.value;
      klass.prototype[key] = function() {
        nativeCalls.count++;
        return original.apply(this, arguments);
      };
    }
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function round(n) {
  return Math.round(n * 100) / 100;
}

describeBenchmark('Display pipeline benchmark', () => {
  const results = [];
  const editors = [];

  beforeEach(async () => {
    jasmine.getEnv().defaultTimeoutInterval = 600000;
    await atom.packages.activatePackage('language-javascript');
    instrumentNativeCalls();
  });

  afterEach(() => {
    for (const editor of editors) editor.destroy();
    editors.length = 0;
  });

  // Write results once all scenarios ran (Jasmine 1.3 has no afterAll).
  function report() {
    const outPath =
      process.env.PULSAR_BENCHMARK_OUT ||
      path.join(os.tmpdir(), 'pulsar-display-pipeline-benchmark.json');
    fs.writeFileSync(
      outPath,
      JSON.stringify({ date: new Date().toISOString(), results }, null, 2)
    );
    console.log('Display pipeline benchmark:\n' + JSON.stringify(results, null, 2));
    console.log('Wrote ' + outPath);
  }

  async function buildComponent({ text, softWrapped = false, width = 800, height = 600 }) {
    const buffer = new TextBuffer({ text });
    atom.grammars.assignLanguageMode(buffer, 'source.js');
    const languageMode = buffer.getLanguageMode();
    if (languageMode.ready && typeof languageMode.ready.then === 'function') {
      await languageMode.ready;
    }
    const editor = new TextEditor({ buffer, softWrapped, autoHeight: false });
    editors.push(editor);
    const component = new TextEditorComponent({ model: editor, updatedSynchronously: false });
    const { element } = component;
    element.style.height = height + 'px';
    element.style.width = width + 'px';
    jasmine.attachToDOM(element);
    await component.getNextUpdatePromise();
    if (languageMode.atTransactionEnd) await languageMode.atTransactionEnd();
    component.updateSync();
    return { buffer, editor, component, element };
  }

  // Runs `step(i)` followed by a synchronous render for each frame and
  // collects per-frame timings, DOM mutations, heap growth and native calls.
  function measureFrames(name, component, frameCount, step) {
    const observer = new MutationObserver(() => {});
    observer.observe(component.element, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true
    });
    const frameTimes = [];
    let mutations = 0;
    const heapBefore = performance.memory ? performance.memory.usedJSHeapSize : 0;
    const callsBefore = nativeCalls.count;
    const start = performance.now();
    for (let i = 0; i < frameCount; i++) {
      const t0 = performance.now();
      step(i);
      component.updateSync();
      frameTimes.push(performance.now() - t0);
      mutations += observer.takeRecords().length;
    }
    const total = performance.now() - start;
    observer.disconnect();
    const sorted = frameTimes.slice().sort((a, b) => a - b);
    const result = {
      name,
      frames: frameCount,
      totalMs: round(total),
      meanFrameMs: round(total / frameCount),
      p50FrameMs: round(percentile(sorted, 0.5)),
      p95FrameMs: round(percentile(sorted, 0.95)),
      maxFrameMs: round(sorted[sorted.length - 1]),
      domMutations: mutations,
      nativeCalls: nativeCalls.count - callsBefore,
      heapDeltaKB: performance.memory
        ? Math.round((performance.memory.usedJSHeapSize - heapBefore) / 1024)
        : null
    };
    results.push(result);
    return result;
  }

  it('measures the display pipeline', async () => {
    const random = createRandom(42);

    {
      const { component } = await buildComponent({
        text: buildJavaScriptText(random, 20000)
      });
      const lineHeight = component.getLineHeight();
      measureFrames('scroll-smooth', component, 600, i => {
        component.setScrollTop(i * lineHeight * 3);
      });
      measureFrames('scroll-jumps', component, 200, i => {
        component.setScrollTop(((i * 97) % 19000) * lineHeight);
      });
    }

    {
      const { editor, component } = await buildComponent({
        text: buildJavaScriptText(random, 20000)
      });
      editor.setCursorBufferPosition([5000, 0]);
      component.updateSync();
      const typed = 'const value = callback(result) + 42; ';
      measureFrames('typing', component, 500, i => {
        editor.insertText(typed[i % typed.length]);
      });
      measureFrames('typing-newlines', component, 200, () => {
        editor.insertText('\n');
      });
    }

    {
      const { component } = await buildComponent({
        text: buildJavaScriptText(random, 5000, true),
        softWrapped: true
      });
      const lineHeight = component.getLineHeight();
      measureFrames('soft-wrap-scroll', component, 400, i => {
        component.setScrollTop(i * lineHeight * 3);
      });
    }

    {
      const longLine = buildJavaScriptText(random, 6000).replace(/\n/g, ' ') + '\n';
      const { editor, component } = await buildComponent({ text: longLine });
      measureFrames('long-line-scroll-left', component, 100, i => {
        component.setScrollLeft(i * 200);
      });
      editor.setCursorBufferPosition([0, 1000]);
      component.updateSync();
      measureFrames('long-line-typing', component, 100, () => {
        editor.insertText('x');
      });
    }

    report();
  });
});
