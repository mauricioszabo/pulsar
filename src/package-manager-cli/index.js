// Public entry-point for Pulsar's in-process package manager. Used by:
//  * `src/main-process/parse-command-line.js`, which calls `runCli(argv)`
//    when the user invokes `pulsar -p <args>`.
//  * `src/main-process/atom-application.js`, which exposes an IPC handler
//    that calls `runCommand(args, opts)` on behalf of renderers.
//
// `runCli` writes to stdout/stderr (terminal mode). `runCommand` returns
// the captured output as `{ code, stdout, stderr }` for programmatic use.

const cli = require('./cli');

async function runCli(argv) {
  return new Promise((resolve) => {
    cli.run(argv, (error) => resolve(error != null ? 1 : 0));
  });
}

async function runCommand(args, opts = {}) {
  // Capture stdout/stderr by patching `process.stdout.write` and
  // `process.stderr.write` for the duration of the command. We can't simply
  // redirect file descriptors because Electron's main process owns the
  // real fds; patching is the cheapest cross-platform shim.
  const stdoutChunks = [];
  const stderrChunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString()); return true; };
  process.stderr.write = (chunk) => { stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString()); return true; };

  const origCwd = process.cwd();
  if (opts.cwd) {
    try { process.chdir(opts.cwd); } catch (_) {}
  }

  let code = 0;
  try {
    await new Promise((resolve) => cli.run(args, (error) => {
      code = error != null ? 1 : 0;
      resolve();
    }));
  } catch (e) {
    code = 1;
    stderrChunks.push(String(e?.stack || e?.message || e));
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
