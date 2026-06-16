// Emits this window's startup timing for the benchmark harness
// (script/benchmark-startup.js). Not a behavioural test — it boots a real
// AtomEnvironment (which is what we want to time) and prints a machine-parseable
// line with the window load time and all startup markers.

describe('startup benchmark', () => {
  it('reports startup timing', () => {
    // The --test path exercises only a fraction of the editor-core require graph
    // that production startEditorWindow loads, so on its own it barely touches
    // the snapshot. To make the comparison representative, explicitly require the
    // heavy editor-core modules the snapshot targets and time that work — this is
    // the cost the snapshot is meant to eliminate. With the snapshot active these
    // come from the heap; without it they parse+compile from disk.
    const CORE = [
      '../src/text-editor',
      '../src/text-editor-component',
      '../src/workspace',
      '../src/pane',
      '../src/selection',
      '../src/cursor',
      '../src/decoration',
      '../src/gutter',
      '../src/dock',
      '../src/panel',
      '../src/project',
      '../src/config'
    ];
    // These modules are already in require.cache from boot, so a plain require
    // would measure nothing. Drop them from the cache first; then with the
    // snapshot active the Module._load hook re-serves them from the heap (fast),
    // while without it they re-parse/compile from disk (slow) — isolating the
    // snapshot's effect. (The snapshot's customRequire memoizes, so heap serves
    // stay cheap even after the disk cache is cleared.)
    const path = require('path');
    const Module = require('module');
    const staticDir = path.join(atom.getLoadSettings().resourcePath, 'static');
    for (const m of CORE) {
      try {
        delete Module._cache[require.resolve(path.resolve(staticDir, m))];
      } catch (e) {}
    }
    const t0 = Date.now();
    for (const m of CORE) {
      try {
        require(path.resolve(staticDir, m));
      } catch (e) {}
    }
    const coreRequireTime = Date.now() - t0;

    const markers = atom.getStartupMarkers();
    const loadTime = atom.getWindowLoadTime();
    const snapshotMarker = markers.find(m =>
      m.label.startsWith('window:snapshot-wired:')
    );
    const snapshotModules = snapshotMarker
      ? parseInt(snapshotMarker.label.split(':').pop(), 10)
      : 0;

    console.log(
      `STARTUP_BENCH ${JSON.stringify({
        loadTime,
        coreRequireTime,
        snapshotModules,
        markers: markers.map(m => [m.label, m.time])
      })}`
    );

    expect(typeof loadTime === 'number' || loadTime === null).toBe(true);
  });
});
