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
// the codebase keeps the existing transform pipeline unchanged.
let solidOverride = {
  test: [/text-editor-component\.js$/],
  presets: ['babel-preset-solid']
};

module.exports = {
  presets: presets,
  plugins: plugins,
  overrides: [solidOverride],
  exclude: 'node_modules/**',
  sourceMap: 'inline'
};
