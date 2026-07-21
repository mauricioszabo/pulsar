// Specs for the tree-sitter-optimized editor's windowed tokenizer API
// (ADR 006 / "Tree-Sitter Optimized Text Editor" plan, milestone M2):
//
//   WASMTreeSitterLanguageMode#getScreenLineTokens(row, startColumn, endColumn)
//   WASMTreeSitterLanguageMode#getViewportTokens(startPoint, endPoint)
//
// The central claim these specs pin down: tokenizing a horizontal window of a
// row is bounded to that window. In particular a very long ("minified") line is
// highlightable within a window even though the display-layer/full-line path
// skips it entirely once it passes LINE_LENGTH_LIMIT_FOR_HIGHLIGHTING, and the
// window is NOT tokenized from column 0.

const path = require('path');
const CSON = require('season');
const WASMTreeSitterGrammar = require('../src/wasm-tree-sitter-grammar');
const WASMTreeSitterLanguageMode = require('../src/wasm-tree-sitter-language-mode');

const PATH = path.resolve(path.join(__dirname, '..', 'packages'));
function resolve(modulePath) {
  return require.resolve(`${PATH}/${modulePath}`);
}

const jsGrammarPath = resolve(
  'language-javascript/grammars/modern-tree-sitter-javascript.cson'
);
const jsConfig = CSON.readFileSync(jsGrammarPath);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('WASMTreeSitterLanguageMode viewport tokens (M2)', () => {
  let editor, buffer, grammar, languageMode;

  // Resolve each token's numeric scopeIds to scope names for readable
  // assertions.
  function named(tokens) {
    return tokens.map((t) => ({
      column: t.column,
      text: t.text,
      scopes: t.scopeIds.map((id) => languageMode.scopeNameForScopeId(id))
    }));
  }

  async function setUp(text, highlightsQuery) {
    grammar = new WASMTreeSitterGrammar(atom.grammars, jsGrammarPath, jsConfig);
    await grammar.setQueryForTest('highlightsQuery', highlightsQuery);
    buffer.setText(text);
    languageMode = new WASMTreeSitterLanguageMode({ grammar, buffer });
    buffer.setLanguageMode(languageMode);
    await languageMode.ready;
    await wait(0);
  }

  beforeEach(async () => {
    grammar = null;
    editor = await atom.workspace.open('');
    buffer = editor.getBuffer();
    atom.config.set('core.useTreeSitterParsers', true);
    jasmine.useRealClock();
  });

  afterEach(() => {
    if (grammar) grammar?.subscriptions?.dispose();
  });

  describe('getScreenLineTokens', () => {
    it('returns one flat token per maximal constant-scope run', async () => {
      await setUp('a = 1;', '["="] @keyword ([";"] @punctuation)');

      const tokens = named(languageMode.getScreenLineTokens(0, 0, 6));
      expect(tokens).toEqual([
        { column: 0, text: 'a ', scopes: [] },
        { column: 2, text: '=', scopes: ['keyword'] },
        { column: 3, text: ' 1', scopes: [] },
        { column: 5, text: ';', scopes: ['punctuation'] }
      ]);
    });

    it('clips to the requested [startColumn, endColumn) window', async () => {
      await setUp('aa = bb;', '(identifier) @variable');

      // Only columns 5..7 ("bb"): the leading identifier "aa" is outside the
      // window and must not appear.
      const tokens = named(languageMode.getScreenLineTokens(0, 5, 7));
      expect(tokens).toEqual([
        { column: 5, text: 'bb', scopes: ['variable'] }
      ]);
    });

    it('reports scopes open at the window start (enclosing the window)', async () => {
      // The template literal is one big string node spanning the whole line;
      // a window in its middle must still carry the `string` scope even though
      // the scope opened far to the left of the window.
      await setUp('`aaaaaaaaaa bbbb`', '(template_string) @string');

      const tokens = named(languageMode.getScreenLineTokens(0, 6, 10));
      expect(tokens.length).toBe(1);
      expect(tokens[0].column).toBe(6);
      expect(tokens[0].text).toBe('aaaa');
      expect(tokens[0].scopes).toContain('string');
    });

    it('highlights a window of a very long ("minified") line without tokenizing from column 0', async () => {
      // A single line well over LINE_LENGTH_LIMIT_FOR_HIGHLIGHTING (10000):
      // "a=" repeated 8000 times => 16000 characters, "=" at every odd column.
      const line = 'a='.repeat(8000);
      await setUp(line, '["="] @keyword');

      const start = 12000;
      const end = 12010;
      const tokens = named(languageMode.getScreenLineTokens(0, start, end));

      // We got real, scoped tokens for the window...
      expect(tokens.length).toBeGreaterThan(0);
      expect(tokens.some((t) => t.scopes.includes('keyword'))).toBe(true);

      // ...and NONE of them start before the window: the query did not walk
      // from column 0.
      for (const token of tokens) {
        expect(token.column).toBeGreaterThanOrEqual(start);
        expect(token.column).toBeLessThan(end);
      }

      // Contrast: the full-line highlight path skips this line entirely because
      // its length exceeds the limit, so windowing is what makes it visible.
      const fullLineOpenScopes = languageMode
        .buildHighlightIterator()
        .seek({ row: 0, column: 0 }, 0);
      expect(fullLineOpenScopes).toEqual([]);
    });

    it('returns null before a syntax tree exists', () => {
      const bareMode = new WASMTreeSitterLanguageMode({ grammar: new WASMTreeSitterGrammar(atom.grammars, jsGrammarPath, jsConfig), buffer });
      // No `await ready` — rootLanguageLayer has no tree yet.
      expect(bareMode.getScreenLineTokens(0, 0, 10)).toBe(null);
    });
  });

  describe('getViewportTokens', () => {
    it('tokenizes each row of the rectangle', async () => {
      await setUp('a = 1;\nb = 2;\nc = 3;', '["="] @keyword');

      const rows = languageMode.getViewportTokens(
        { row: 0, column: 0 },
        { row: 2, column: 6 }
      );
      expect(rows.map((r) => r.row)).toEqual([0, 1, 2]);
      for (const { tokens } of rows) {
        const t = named(tokens);
        expect(t.some((tok) => tok.scopes.includes('keyword'))).toBe(true);
      }
    });

    it('clamps the end row to the last buffer row', async () => {
      await setUp('a = 1;\nb = 2;', '["="] @keyword');
      const rows = languageMode.getViewportTokens(
        { row: 0, column: 0 },
        { row: 999, column: 6 }
      );
      expect(rows.map((r) => r.row)).toEqual([0, 1]);
    });
  });
});
