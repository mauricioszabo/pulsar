// Dedicated entry point for the V8 startup snapshot.
//
// Unlike `initialize-application-window.js` (which CONSTRUCTS the full
// AtomEnvironment and preloads packages at module-eval time — eager I/O the
// snapshot context can't satisfy), this entry only *requires* the expensive-to-
// parse core modules so their compiled code is baked into the snapshot heap. It
// instantiates nothing. At runtime, `customRequire` serves these modules from
// the snapshot; the real environment construction still runs live via
// `initialize-application-window.js`.
//
// Keep this list to modules that are (a) large/parse-heavy and (b) safe to
// merely `require` (define classes/functions) without touching the DOM, native
// bindings, or Node core I/O at module-eval time. The snapshot generator
// (script/generate-startup-snapshot.js) walks the require graph from here.

require('./text-editor');
require('./text-editor-component');
require('./workspace');
require('./pane');
require('./pane-axis');
require('./selection');
require('./cursor');
require('./decoration');
require('./layer-decoration');
require('./gutter');
require('./gutter-container');
require('./dock');
require('./panel');
require('./panel-container');
require('./project');
require('./config');
require('./color');

// The snapshot needs a `snapshotResult` global to exist (see the electron-link
// blueprint). This module deliberately exports nothing — its value is the
// side effect of populating the snapshot's module cache.
module.exports = {};
