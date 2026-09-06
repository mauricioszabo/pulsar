// Public entry-point for Pulsar's in-process package manager. Used by:
//  * `src/main-process/parse-command-line.js`, which calls `runCli(argv)`
//    when the user invokes `pulsar -p <args>`.
//  * `src/main-process/atom-application.js`, which exposes an IPC handler
//    that calls `runCommand(args, opts)` on behalf of renderers.
//
// `runCli` writes to stdout/stderr (terminal mode). `runCommand` returns
// the captured output as `{ code, stdout, stderr }` for programmatic use.

// Lazy-load the dispatcher so a missing optional dependency in one
// command can never prevent this module from being required. Failures
// surface inside `runCli`/`runCommand` as a non-zero exit code with the
// error on stderr — easy for callers to handle.
let _cli;
function loadCli() {
  if (_cli) return _cli;
  _cli = require('./cli');
  return _cli;
}

async function runCli(argv) {
  let cli;
  try { cli = loadCli(); }
  catch (e) {
    process.stderr.write(`ppm: failed to load package manager: ${e.message}\n`);
    process.stderr.write('Hint: run `yarn install` in the Pulsar source directory to install ppm dependencies.\n');
    return 1;
  }
  return new Promise((resolve) => {
    cli.run(argv, (error) => resolve(error != null ? 1 : 0));
  });
}

async function runCommand(args, opts = {}) {
  // Capture stdout/stderr by patching `process.stdout.write` and
  // `process.stderr.write` for the duration of the command. We can't simply
  // redirect file descriptors because Electron's main process owns the
  // real fds; patching is the cheapest cross-platform shim.
  //
  // While captured, each chunk is also handed to `opts.onProgress` so callers
  // (e.g., the IPC handler) can stream output to a renderer in real time
  // instead of waiting for the whole command to finish.
  const stdoutChunks = [];
  const stderrChunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);

  const wrap = (stream) => (chunk) => {
    const s = typeof chunk === 'string'
      ? chunk
      : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    if (stream === 'stdout') stdoutChunks.push(s);
    else stderrChunks.push(s);
    if (typeof opts.onProgress === 'function') {
      try { opts.onProgress(stream, s); } catch (_) {}
    }
    return true;
  };
  process.stdout.write = wrap('stdout');
  process.stderr.write = wrap('stderr');

  const origCwd = process.cwd();
  if (opts.cwd) {
    try { process.chdir(opts.cwd); } catch (_) {}
  }

  let code = 0;
  let cli;
  try {
    cli = loadCli();
    await new Promise((resolve) => cli.run(args, (error) => {
      code = error != null ? 1 : 0;
      resolve();
    }));
  } catch (e) {
    code = 1;
    const msg = e?.message?.includes('Cannot find module')
      ? `${e.message}\nHint: run \`yarn install\` in the Pulsar source directory to install ppm dependencies.`
      : String(e?.stack || e?.message || e);
    stderrChunks.push(msg);
    if (typeof opts.onProgress === 'function') {
      try { opts.onProgress('stderr', msg); } catch (_) {}
    }
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    if (opts.cwd) {
      try { process.chdir(origCwd); } catch (_) {}
    }
  }

  return { code, stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
}

module.exports = { runCli, runCommand };
