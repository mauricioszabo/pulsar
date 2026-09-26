const WASMTreeSitterLanguageMode = require('./wasm-tree-sitter-language-mode');
const WASMTreeSitterGrammar = require('./wasm-tree-sitter-grammar');
const {
  NativeParser,
  SyntaxNode,
  TreeSitterGrammar,
  TreeSitterQuery
} = require('./native-tree-sitter');

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

  // Native queries resolve their captures into scope boundaries natively,
  // the way `ScopeResolver#store` does, in one call.
  //
  // Scope ids are looked up once per scope name, so this relies on
  // `idForScope` ignoring the leaf node text that `ScopeResolver` passes it.
  // If a grammar overrides it, keep using `ScopeResolver`.
  resolveHighlights(layer, from, to) {
    let query = layer.queries.highlightsQuery;
    if (!(query instanceof TreeSitterQuery) || !this.hasStockIdForScope()) {
      return super.resolveHighlights(layer, from, to);
    }

    let { scopeResolver } = layer;
    scopeResolver.reset();
    let { boundaries, invalidatedNodeIds, scopeNameCount } = query.highlights(
      layer.tree.rootNode,
      {
        startPosition: from,
        endPosition: to,
        injection: layer.depth > 0,
        config: (key) => scopeResolver.getConfig(key)
      }
    );
    for (let id of invalidatedNodeIds) {
      layer.nodesToInvalidateOnChange.add(id);
    }

    let scopeIds = this.scopeIdsForHighlightsQuery(query, scopeNameCount);
    for (let i = 0; i < boundaries.length;) {
      let point = scopeResolver._keyForPoint({ row: boundaries[i], column: boundaries[i + 1] });
      let closeCount = boundaries[i + 2];
      let openCount = boundaries[i + 3];
      i += 4;
      let close = [];
      for (let end = i + closeCount; i < end; i++) close.push(scopeIds[boundaries[i]]);
      let open = [];
      for (let end = i + openCount; i < end; i++) open.push(scopeIds[boundaries[i]]);
      scopeResolver.boundaries.set(point, { open, close });
    }
  }

  hasStockIdForScope() {
    return this.idForScope === WASMTreeSitterLanguageMode.prototype.idForScope &&
      this.grammar.idForScope === WASMTreeSitterGrammar.prototype.idForScope;
  }

  // The scope ids of the scope names a native highlights query's boundaries
  // refer to (by index). Scope ids belong to the language mode's grammar, and
  // an injection's query can serve several of them.
  scopeIdsForHighlightsQuery(query, scopeNameCount) {
    let idsByQuery = SCOPE_IDS_FOR_GRAMMARS.get(this.grammar);
    if (!idsByQuery) {
      idsByQuery = new WeakMap();
      SCOPE_IDS_FOR_GRAMMARS.set(this.grammar, idsByQuery);
    }
    let scopeIds = idsByQuery.get(query);
    if (!scopeIds) {
      scopeIds = [];
      idsByQuery.set(query, scopeIds);
    }
    if (scopeIds.length < scopeNameCount) {
      for (let name of query.highlightScopeNames(scopeIds.length)) {
        scopeIds.push(this.idForScope(name));
      }
    }
    return scopeIds;
  }
}

const SCOPE_IDS_FOR_GRAMMARS = new WeakMap();

module.exports = NativeTreeSitterLanguageMode;
