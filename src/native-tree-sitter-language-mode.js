const WASMTreeSitterLanguageMode = require('./wasm-tree-sitter-language-mode');
const { NativeParser, SyntaxNode, TreeSitterGrammar } = require('./native-tree-sitter');

WASMTreeSitterLanguageMode.patchNodePrototype(SyntaxNode.prototype);

// Grammars whose WASM module couldn't be loaded natively; their layers use
// `web-tree-sitter` instead.
const GRAMMARS_WITHOUT_NATIVE_SUPPORT = new WeakSet();

// Experimental: a Tree-sitter language mode that runs the same WASM grammars
// and query files as `WASMTreeSitterLanguageMode`, but through superstring's
// native Tree-sitter, which parses straight from the buffer's native text
// instead of copying it into `web-tree-sitter`'s WASM memory.
//
// Everything else — layers, injections, highlighting, folds, indentation —
// is `WASMTreeSitterLanguageMode`'s code, working on native trees, queries and
// nodes that mirror `web-tree-sitter`'s API.
//
// Enabled by `core.useExperimentalNativeTreeSitter`.
class NativeTreeSitterLanguageMode extends WASMTreeSitterLanguageMode {
  loadLanguageForGrammar(grammar) {
    if (GRAMMARS_WITHOUT_NATIVE_SUPPORT.has(grammar)) {
      return grammar.getLanguage();
    }
    return grammar.getNativeLanguage().catch((error) => {
      if (!GRAMMARS_WITHOUT_NATIVE_SUPPORT.has(grammar)) {
        GRAMMARS_WITHOUT_NATIVE_SUPPORT.add(grammar);
        console.warn(`Native Tree-sitter can't load ${grammar.scopeName}; using web-tree-sitter for it.`, error);
      }
      return grammar.getLanguage();
    });
  }

  getLanguageForGrammarSync(grammar) {
    return GRAMMARS_WITHOUT_NATIVE_SUPPORT.has(grammar) ?
      grammar.getLanguageSync() :
      grammar.getNativeLanguageSync();
  }

  getQueryForGrammar(grammar, queryType) {
    return GRAMMARS_WITHOUT_NATIVE_SUPPORT.has(grammar) ?
      grammar.getQuery(queryType) :
      grammar.getNativeQuery(queryType);
  }

  createParser(language) {
    if (language instanceof TreeSitterGrammar) {
      return new NativeParser(this.buffer);
    }
    return super.createParser(language);
  }
}

module.exports = NativeTreeSitterLanguageMode;
