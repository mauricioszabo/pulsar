'use strict';

// Startup benchmark harness.
//
// Boots Pulsar headlessly N times via spec/startup-benchmark-spec.js, which
// prints each run's window load time and startup markers. Aggregates
// median/p90, and (with --compare) measures both with and without the custom V8
// snapshot active so the snapshot's effect is isolated.
//
// The snapshot is toggled by swapping `node_modules/electron/dist/
// v8_context_snapshot.bin`. The originals are always restored, even on error.
//
// Usage:
//   node script/benchmark-startup.js [--runs 12] [--compare] [--keep-first]
//
//   --compare     run both snapshot-off and snapshot-on and print the delta
//   --runs N      iterations per condition (default 12)
//   --keep-first  include the first (cold-cache) run; by default it's discarded

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
const SPEC = path.join(ROOT, 'spec', 'startup-benchmark-spec.js');

function parseArgs(argv) {
  const args = { runs: 12, compare: false, keepFirst: false, snapshot: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runs') args.runs = parseInt(argv[++i], 10);
    else if (argv[i] === '--compare') args.compare = true;
    else if (argv[i] === '--keep-first') args.keepFirst = true;
    else if (argv[i] === '--snapshot') args.snapshot = argv[++i];
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

// The snapshot accelerates renderer module parse/eval, which happens between
// these two markers. `loadTime` is null in the --test path, so we measure this
// delta instead (and fall back to loadTime when it's present, e.g. production).
const WINDOW_START = 'window:start';
const WINDOW_END = 'window:initialize:start';

function metricFromMarkers(bench) {
  // Primary metric: time to require the editor-core modules the snapshot targets
  // (parse+compile from disk vs. served from the heap). This is the cost the
  // snapshot is designed to eliminate and is measurable in the --test path.
  if (typeof bench.coreRequireTime === 'number') return bench.coreRequireTime;
  // Fallbacks: production loadTime, then the renderer module-load window.
  if (typeof bench.loadTime === 'number') return bench.loadTime;
  const byLabel = new Map(bench.markers);
  const start = byLabel.get(WINDOW_START);
  const end = byLabel.get(WINDOW_END);
  if (typeof start === 'number' && typeof end === 'number') return end - start;
  return null;
}

function runOnce() {
  const result = spawnSync(
    ELECTRON,
    ['--no-sandbox', '--enable-logging', ROOT, '-f', '--test', SPEC],
    {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 5 * 60 * 1000,
      env: { ...process.env }
    }
  );
  const out = `${result.stdout || ''}\n${result.stderr || ''}`;
  const m = out.match(/STARTUP_BENCH (\{.*\})/);
  if (!m) return null;
  return JSON.parse(m[1]);
}

function measure(runs, keepFirst) {
  const samples = [];
  let snapshotModules = 0;
  for (let i = 0; i < runs; i++) {
    const r = runOnce();
    if (!r) {
      process.stdout.write('x');
      continue;
    }
    snapshotModules = r.snapshotModules;
    if (i === 0 && !keepFirst) {
      process.stdout.write('.');
      continue; // discard cold run
    }
    const metric = metricFromMarkers(r);
    if (typeof metric === 'number') samples.push(metric);
    process.stdout.write('.');
  }
  process.stdout.write('\n');
  return { samples, snapshotModules };
}

function summarize(label, { samples, snapshotModules }) {
  if (!samples.length) {
    console.log(`${label}: no samples collected`);
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
  const backup = path.join(os.tmpdir(), `pulsar-v8ctx-backup-${process.pid}.bin`);
  fs.copyFileSync(target, backup);
  try {
    fs.copyFileSync(blobPath, target);
    return fn();
  } finally {
    fs.copyFileSync(backup, target);
    fs.unlinkSync(backup);
  }
}

function ensureSnapshotBlob() {
  // Generate fresh blobs into out/snapshot if not already present.
  const outDir = path.join(ROOT, 'out', 'snapshot');
  const blob = path.join(outDir, 'v8_context_snapshot.bin');
  if (fs.existsSync(blob)) return blob;
  console.log('Generating snapshot blobs for benchmark…');
  const generate = require('./generate-startup-snapshot');
  return generate({ out: outDir, mksnapshot: true }).then(() => blob);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.compare) {
    console.log(`Measuring ${args.runs} runs (snapshot as currently installed)…`);
    summarize('current', measure(args.runs, args.keepFirst));
    return;
  }

  const blob = args.snapshot || (await ensureSnapshotBlob());

  console.log(`\n=== snapshot OFF (${args.runs} runs) ===`);
  const off = summarize('snapshot-off', measure(args.runs, args.keepFirst));

  console.log(`\n=== snapshot ON (${args.runs} runs) ===`);
  const on = withSnapshot(blob, () =>
    summarize('snapshot-on', measure(args.runs, args.keepFirst))
  );

  if (off && on) {
    const deltaMed = off.med - on.med;
    const pct = ((deltaMed / off.med) * 100).toFixed(1);
    console.log(
      `\n=== RESULT ===\n` +
        `median: ${off.med}ms → ${on.med}ms  (${deltaMed >= 0 ? '-' : '+'}${Math.abs(
          deltaMed
        )}ms, ${pct}% ${deltaMed >= 0 ? 'faster' : 'slower'})`
    );
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
