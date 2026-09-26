// Specs that construct Tree-sitter language modes directly use this, so that
// PULSAR_NATIVE_TREE_SITTER=1 runs them against the experimental native
// implementation (see also `jasmine2-spies.js`).
if (process.env.PULSAR_NATIVE_TREE_SITTER) {
  // Specs use the query `setQueryForTest` returns on the language mode's
  // trees, so return the native one.
  const WASMTreeSitterGrammar = require('../../src/wasm-tree-sitter-grammar');
  const setQueryForTest = WASMTreeSitterGrammar.prototype.setQueryForTest;
  WASMTreeSitterGrammar.prototype.setQueryForTest = async function (queryType, contents) {
    await setQueryForTest.call(this, queryType, contents);
    return this.getNativeQuery(queryType);
  };
  module.exports = require('../../src/native-tree-sitter-language-mode');
} else {
  module.exports = require('../../src/wasm-tree-sitter-language-mode');
}
