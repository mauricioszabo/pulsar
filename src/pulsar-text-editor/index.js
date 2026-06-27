'use strict';

// Plain-JS entry that runs the Solid loader shim BEFORE requiring the
// JSX-bearing `./component` file. This split is load-order critical:
//
// `babel-preset-solid` hoists its runtime imports (the
// `var _web = require("solid-js/web/dist/web.cjs"); var _tmpl$ = ...`
// pair you can see in the compiled cache) to the very top of the
// transformed file, ABOVE any source-level `require()`. If the shim
// were a `require()` inside `./component` itself, the preset's
// hoisted import would load `web.cjs` first, `web.cjs` would
// internally do `require('solid-js')` against the unpatched
// resolver and cache the SSR core, and the shim would then patch
// resolution too late to matter.
//
// Loading the shim from this outer file — which has no `'use babel'`
// header, so Pulsar's per-file Babel pipeline does not touch it and
// nothing gets hoisted — guarantees the resolver patch is in place
// before `./component` is even read.
//
// Do not move the shim require into `./component`, and do not delete
// this wrapper.

require('./solid-loader-shim');

module.exports = require('./component');
