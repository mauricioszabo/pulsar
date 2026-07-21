'use strict';

// Resolves which text-editor implementation to instantiate, based on the
// `core.textEditorImplementation` config (see ADR 006). Three values:
//
//   'atom'               – legacy Etch TextEditorComponent (default, stable)
//   'pulsar'             – experimental vanilla-JS component
//                          (`src/pulsar-text-editor`)
//   'pulsar-tree-sitter' – experimental tree-sitter-optimized component
//                          (`src/pulsar-text-editor/tree-sitter-component`)
//
// For backward compatibility, the older boolean `core.useNewTextEditor === true`
// is migrated to 'pulsar' when the new setting is still at its default.
//
// This is read once per component construction, so toggling the setting only
// affects newly-created editors; existing ones keep whichever implementation
// they were constructed with (reopen the file to switch).
module.exports = function getTextEditorImplementation() {
  const config = global.atom && global.atom.config;
  if (!config) return 'atom';

  const implementation = config.get('core.textEditorImplementation');

  // Legacy migration from the previous boolean flag. Only kicks in while the
  // new setting is still at its 'atom' default so an explicit choice always
  // wins.
  if (
    (!implementation || implementation === 'atom') &&
    config.get('core.useNewTextEditor') === true
  ) {
    return 'pulsar';
  }

  return implementation || 'atom';
};
