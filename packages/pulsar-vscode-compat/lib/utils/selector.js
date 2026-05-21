'use strict';

// Convert a VSCode DocumentSelector to an Atom grammar scope selector string.
// VSCode selector can be: string | string[] | {language?, scheme?, pattern?}[]
function toAtomSelector(selector) {
  const entries = Array.isArray(selector) ? selector : [selector];
  const scopes = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      scopes.push(languageToScope(entry));
    } else if (entry && entry.language) {
      scopes.push(languageToScope(entry.language));
    } else {
      scopes.push('*');
    }
  }
  return scopes.join(', ');
}

const LANGUAGE_SCOPE_MAP = {
  javascript: 'source.js, source.js.jsx',
  javascriptreact: 'source.js.jsx',
  typescript: 'source.ts, source.tsx',
  typescriptreact: 'source.tsx',
  python: 'source.python',
  ruby: 'source.ruby',
  go: 'source.go',
  rust: 'source.rust',
  java: 'source.java',
  c: 'source.c',
  cpp: 'source.cpp',
  csharp: 'source.cs',
  php: 'source.php',
  html: 'text.html.basic',
  css: 'source.css',
  scss: 'source.css.scss',
  less: 'source.css.less',
  json: 'source.json',
  yaml: 'source.yaml',
  markdown: 'text.md',
  xml: 'text.xml',
  sql: 'source.sql',
  shellscript: 'source.shell',
  bash: 'source.shell',
  powershell: 'source.powershell',
  dockerfile: 'source.dockerfile',
  lua: 'source.lua',
  perl: 'source.perl',
  r: 'source.r',
  swift: 'source.swift',
  kotlin: 'source.kotlin',
  elixir: 'source.elixir',
  erlang: 'source.erlang',
  haskell: 'source.haskell',
  clojure: 'source.clojure',
  coffeescript: 'source.coffee',
  'objective-c': 'source.objc',
  plaintext: 'text.plain'
};

function languageToScope(language) {
  if (!language || language === '*') return '*';
  return LANGUAGE_SCOPE_MAP[language] || `source.${language}`;
}

// Check if a document's grammar matches a VSCode DocumentSelector.
function matchesSelector(grammarScopeName, selector) {
  const entries = Array.isArray(selector) ? selector : [selector];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      if (entry === '*') return 1;
      const scope = languageToScope(entry);
      if (scope === '*' || scope.split(', ').some(s => grammarScopeName === s || grammarScopeName.startsWith(s))) return 1;
    } else if (entry) {
      if (!entry.language && !entry.pattern) return 1;
      if (entry.language) {
        const scope = languageToScope(entry.language);
        if (scope === '*' || scope.split(', ').some(s => grammarScopeName === s || grammarScopeName.startsWith(s))) return 1;
      }
    }
  }
  return 0;
}

module.exports = { toAtomSelector, languageToScope, matchesSelector };
