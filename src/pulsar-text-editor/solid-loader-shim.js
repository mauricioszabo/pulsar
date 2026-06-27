'use strict';

// Force every `solid-js` and `solid-js/web` lookup — ours, the
// JSX-runtime imports `babel-preset-solid` injects, AND solid-js/web's
// own internal `require('solid-js')` — to resolve to Solid's CLIENT
// build instead of its server build.
//
// Why this is necessary
// ---------------------
// Solid 1.9 ships separate client and SSR builds and selects between
// them via `package.json` `exports` conditions. Electron's renderer
// process matches Node's `node` condition when `require()` runs, and
// Solid's `exports` map points the `node` condition at `server.cjs`.
//
// That alone wouldn't be a problem for the JSX runtime imports — we
// already work around it for `solid-js/web` by configuring
// `babel-preset-solid` with `moduleName: 'solid-js/web/dist/web.cjs'`.
// But the client `web.cjs` itself still does `require('solid-js')`
// internally, which goes through the same conditional resolution and
// loads `solid-js/dist/server.cjs`. Solid's *reactive scheduler* (the
// piece that subscribes effects to signal reads) lives in core, so
// the scheduler we end up with is the server stub: it invokes effects
// once and never re-runs them. Signals update, the DOM does not.
//
// Symptoms before this shim: `createSignal`'s setter visibly updates
// the underlying value (a `tick()` getter returns increasing numbers
// when polled from `setInterval`), but the JSX expression `{tick()}`
// renders the initial value once and never refreshes.
//
// What this shim does
// -------------------
// Installs an interceptor on `Module._resolveFilename` that rewrites
// the bare specifiers `solid-js` and `solid-js/web` to the absolute
// paths of the client `.cjs` files inside `node_modules/solid-js/`.
// Deep paths (anyone who already qualifies the `.cjs` themselves) are
// left alone so behavior is idempotent.
//
// IMPORTANT: this file must be `require()`d before any solid module
// is loaded — directly or transitively. The entry at
// `src/pulsar-text-editor/index.js` requires it as its very first
// statement, before any `import`/`require` of `solid-js*`.

const Module = require('module');

if (!global.__pulsarSolidLoaderShim) {
  const solidCorePath = require.resolve('solid-js/dist/solid.cjs');
  const solidWebPath = require.resolve('solid-js/web/dist/web.cjs');

  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function(request, parent, ...rest) {
    if (request === 'solid-js') return solidCorePath;
    if (request === 'solid-js/web') return solidWebPath;
    return originalResolveFilename.call(this, request, parent, ...rest);
  };

  global.__pulsarSolidLoaderShim = {
    solidCorePath: solidCorePath,
    solidWebPath: solidWebPath
  };
}

module.exports = global.__pulsarSolidLoaderShim;
