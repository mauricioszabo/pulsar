/* global runGrammarTests, runFoldsTests */
const path = require('path');

function setConfigForLanguageMode(mode) {
  let useTreeSitterParsers = mode !== 'textmate';
  let useExperimentalModernTreeSitter = mode === 'modern-tree-sitter';
  atom.config.set('core.useTreeSitterParsers', useTreeSitterParsers);
  atom.config.set('core.useExperimentalModernTreeSitter', useExperimentalModernTreeSitter);
}

describe('Clojure grammars', () => {

  beforeEach(async () => {
    await atom.packages.activatePackage('language-clojure');
  });

  it('tokenizes the editor using TextMate parser', async () => {
    setConfigForLanguageMode('textmate');
    await runGrammarTests(path.join(__dirname, 'fixtures', 'textmate-tokens.clj'), /;/)
  });

  it('tokenizes the editor using modern tree-sitter parser', async () => {
    setConfigForLanguageMode('modern-tree-sitter');
    atom.config.set('language-clojure.dismissTag', true);
    atom.config.set('language-clojure.commentTag', false);
    atom.config.set('language-clojure.markDeprecations', true);
    await runGrammarTests(path.join(__dirname, 'fixtures', 'tokens.clj'), /;/)
  });

  it('tokenizes the editor using modern tree-sitter, but with all default configs toggled', async () => {
    setConfigForLanguageMode('modern-tree-sitter');
    atom.config.set('language-clojure.dismissTag', false);
    atom.config.set('language-clojure.commentTag', true);
    atom.config.set('language-clojure.markDeprecations', false);
    await runGrammarTests(path.join(__dirname, 'fixtures', 'config-toggle.clj'), /;/)
  });

  it('folds Clojure code', async () => {
    setConfigForLanguageMode('modern-tree-sitter');
    await runFoldsTests(path.join(__dirname, 'fixtures', 'tree-sitter-folds.clj'), /;/)
  });
});
