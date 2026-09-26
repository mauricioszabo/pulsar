// Experimental native Tree-sitter, provided by superstring: the same WASM
// grammars and queries as `web-tree-sitter`, parsed straight from the
// buffer's native text. Used by `NativeTreeSitterLanguageMode` when
// `core.useExperimentalNativeTreeSitter` is enabled.
//
// The classes mirror the parts of `web-tree-sitter`'s API that Pulsar uses,
// so the rest of the language mode code works with either.

const TextBuffer = require('@pulsar-edit/text-buffer');

// Must be the superstring instance the buffer's native `TextBuffer` comes
// from.
const {
  TreeSitterGrammar,
  TreeSitterQuery,
  TreeSitterParser,
  TreeSitterTree,
  SyntaxNode
} = TextBuffer.superstring;

// A `web-tree-sitter` `Parser` look-alike for one buffer. `parse` ignores the
// text-reading callback it is given and parses the buffer's native text.
class NativeParser {
  constructor(buffer) {
    this.buffer = buffer;
    this.parser = null;
  }

  setLanguage(language) {
    this.language = language;
    this.parser = new TreeSitterParser(language);
  }

  parse(_input, oldTree = null, options = {}) {
    return this.parser.parse(
      this.buffer.buffer,
      oldTree ?? null,
      options?.includedRanges ?? null
    );
  }

  // Parsing is synchronous and never interrupted, so there's no timeout to
  // set and no partial parse to reset.
  setTimeoutMicros() {}

  reset() {}

  delete() {
    this.parser = null;
  }
}

module.exports = {
  NativeParser,
  SyntaxNode,
  TreeSitterGrammar,
  TreeSitterQuery,
  TreeSitterTree
};
