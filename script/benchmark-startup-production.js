'use strict';

// Production-path startup benchmark.
//
// Unlike script/benchmark-startup.js (which uses the --test spec runner and so
// exercises only a fraction of the editor-core require graph), this launches the
// REAL windowed app through startEditorWindow — the path the snapshot actually
// targets — and reads atom.getWindowLoadTime(). It does so by planting a tiny
// init.js in a throwaway ATOM_HOME that reports the load time and quits.
//
// Measures snapshot-off vs snapshot-on by swapping the packaged Electron's
// v8_context_snapshot.bin (originals always restored).
//
// Requires a display (DISPLAY / xvfb). Usage:
//   node script/benchmark-startup-production.js [--runs 8] [--snapshot <blob>] [--keep-first]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const ELECTRON =
  process.platform === 'win32'
    ? path.join(ROOT, 'node_modules', '.bin', 'electron.cmd')
    : path.join(ROOT, 'node_modules', '.bin', 'electron');

const INIT_SCRIPT = `
// Benchmark init script: report window load time once the window has loaded,
// then quit. Runs on the real startEditorWindow path.
const { remote } = (() => { try { return { remote: require('@electron/remote') }; } catch (e) { return {}; } })();
function report() {
  try {
    const loadTime = atom.getWindowLoadTime();
    const markers = atom.getStartupMarkers();
    const snap = markers.find(m => m.label.startsWith('window:snapshot-wired:'));
    const snapshotModules = snap ? parseInt(snap.label.split(':').pop(), 10) : 0;
    console.log('PROD_BENCH ' + JSON.stringify({ loadTime, snapshotModules }));
  } catch (e) {
    console.log('PROD_BENCH ' + JSON.stringify({ error: String(e) }));
  }
  setTimeout(() => { try { atom.close(); } catch (e) {} }, 50);
}
// loadTime is finalized just after startEditorWindow resolves; defer a tick.
if (atom.getWindowLoadTime() != null) report();
else atom.workspace.onDidStopChangingActivePaneItem
  ? setTimeout(report, 300)
  : setTimeout(report, 300);
`;

function parseArgs(argv) {
  const args = { runs: 8, snapshot: null, keepFirst: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runs') args.runs = parseInt(argv[++i], 10);
    else if (argv[i] === '--snapshot') args.snapshot = argv[++i];
    else if (argv[i] === '--keep-first') args.keepFirst = true;
  }
  return args;
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
function percentile(xs, p) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pulsar-prodbench-'));
  fs.writeFileSync(path.join(home, 'init.js'), INIT_SCRIPT);
  return home;
}

function runOnce(home) {
  const result = spawnSync(
    ELECTRON,
    ['--no-sandbox', '--enable-logging', ROOT, '-f'],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 2 * 60 * 1000,
      env: { ...process.env, ATOM_HOME: home }
    }
  );
  const out = `${result.stdout || ''}\n${result.stderr || ''}`;
  const m = out.match(/PROD_BENCH (\{.*\})/);
  return m ? JSON.parse(m[1]) : null;
}

function measure(runs, keepFirst) {
  const home = makeHome();
  const samples = [];
  let snapshotModules = 0;
  try {
    for (let i = 0; i < runs; i++) {
      const r = runOnce(home);
      if (r && typeof r.snapshotModules === 'number') {
        snapshotModules = r.snapshotModules;
      }
      if (i === 0 && !keepFirst) {
        process.stdout.write('.');
        continue;
      }
      if (r && typeof r.loadTime === 'number') samples.push(r.loadTime);
      process.stdout.write(r && typeof r.loadTime === 'number' ? '.' : 'x');
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  process.stdout.write('\n');
  return { samples, snapshotModules };
}

function summarize(label, { samples, snapshotModules }) {
  if (!samples.length) {
    console.log(`${label}: no samples (did the window load + init.js run?)`);
    return null;
  }
  const med = median(samples);
  const p90 = percentile(samples, 90);
  console.log(
    `${label}: median ${med}ms, p90 ${p90}ms, n=${samples.length}` +
      (snapshotModules ? `, snapshot modules=${snapshotModules}` : '')
  );
  return { med, p90 };
}

function withSnapshot(blobPath, fn) {
  const target = path.join(DIST, 'v8_context_snapshot.bin');
  const backup = path.join(os.tmpdir(), `pulsar-v8ctx-${process.pid}.bin`);
  fs.copyFileSync(target, backup);
  try {
    fs.copyFileSync(blobPath, target);
    return fn();
  } finally {
    fs.copyFileSync(backup, target);
    fs.unlinkSync(backup);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let blob = args.snapshot;
  if (!blob) {
    const outDir = path.join(ROOT, 'out', 'snapshot');
    blob = path.join(outDir, 'v8_context_snapshot.bin');
    if (!fs.existsSync(blob)) {
      console.log('Generating snapshot blobs…');
      await require('./generate-startup-snapshot')({ out: outDir, mksnapshot: true });
    }
  }

  console.log(`\n=== PRODUCTION snapshot OFF (${args.runs} runs) ===`);
  const off = summarize('snapshot-off', measure(args.runs, args.keepFirst));

  console.log(`\n=== PRODUCTION snapshot ON (${args.runs} runs) ===`);
  const on = withSnapshot(blob, () =>
    summarize('snapshot-on', measure(args.runs, args.keepFirst))
  );

  if (off && on) {
    const d = off.med - on.med;
    const pct = ((d / off.med) * 100).toFixed(1);
    console.log(
      `\n=== RESULT ===\nmedian: ${off.med}ms → ${on.med}ms  (${
        d >= 0 ? '-' : '+'
      }${Math.abs(d)}ms, ${pct}% ${d >= 0 ? 'faster' : 'slower'})`
    );
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
