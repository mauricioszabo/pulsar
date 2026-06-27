let presets = [
  [
    'babel-preset-atomic',
    {
      // transform ES modules to commonjs
      keepModules: false,
      // some of the packages use non-strict JavaScript in ES6 modules! We need to add this for now. Eventually, we should fix those packages and remove these:
      notStrictDirectiveTriggers: ['use babel'],
      notStrictCommentTriggers: ['@babel', '@flow', '* @babel', '* @flow']
    }
  ]
];

let plugins = [];

// Files that opt into the SolidJS JSX transform via `babel-preset-solid`.
// Scoped here (rather than added to the global preset list) so the rest of
// the codebase keeps the existing transform pipeline unchanged. Matches the
// legacy `text-editor-component.js` and anything under `src/pulsar-text-editor/`
// (the new SolidJS implementation, gated by the `core.useNewTextEditor` flag).
//
// `generate: 'dom'` (the preset default, made explicit) selects client-side
// rendering output instead of SSR string generation.
//
// `moduleName: 'solid-js/web/dist/web.cjs'` is the Electron workaround:
// solid-js's `package.json` `exports` field maps the `node` condition (which
// Electron's renderer matches when `require()`ing) to the SSR build, so the
// bare specifier `solid-js/web` would resolve to a `server.cjs` whose
// runtime helpers throw "Client-only API called on the server side" the
// moment a `render()` happens. Pointing the preset at the client `.cjs`
// directly bypasses the conditional resolution and is stable across patch
// releases of solid-js 1.9.x.
let solidOverride = {
  test: [/text-editor-component\.js$/, /[\\/]pulsar-text-editor[\\/]/],
  presets: [
    [
      'babel-preset-solid',
      {
        generate: 'dom',
        moduleName: 'solid-js/web/dist/web.cjs'
      }
    ]
  ]
};

module.exports = {
  presets: presets,
  plugins: plugins,
  overrides: [solidOverride],
  exclude: 'node_modules/**',
  sourceMap: 'inline'
};
