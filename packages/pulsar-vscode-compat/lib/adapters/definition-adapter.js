'use strict';

const { Position } = require('../types/position');
const { TextDocument } = require('../types/text-document');
const { CancellationTokenSource } = require('../types/cancellation');
const { matchesSelector } = require('../utils/selector');

// Wraps a VSCode DefinitionProvider as a symbols-view symbol.provider (type: project-find)
function makeSymbolProvider(name, packageName, documentSelector, vscodeProvider) {
  return {
    name,
    packageName,
    isExclusive: false,

    canProvideSymbols(meta) {
      if (meta.type !== 'project-find') return false;
      const grammar = meta.editor.getGrammar();
      return matchesSelector(grammar.scopeName, documentSelector) ? 0.8 : false;
    },

    async getSymbols(meta) {
      const { editor, query, signal } = meta;
      const doc = new TextDocument(editor);
      const cursor = editor.getCursorBufferPosition();
      const pos = new Position(cursor.row, cursor.column);
      const tokenSource = new CancellationTokenSource();

      if (signal) {
        signal.addEventListener('abort', () => tokenSource.cancel(), { once: true });
      }

      try {
        let locations = await vscodeProvider.provideDefinition(doc, pos, tokenSource.token);
        if (signal && signal.aborted) return null;
        if (!locations) return null;

        if (!Array.isArray(locations)) locations = [locations];

        return locations.map(loc => {
          const uri = loc.targetUri || loc.uri;
          const range = loc.targetSelectionRange || loc.targetRange || loc.range;
          return {
            name: query || editor.getWordUnderCursor(),
            path: uri.fsPath,
            position: [range.start.line, range.start.character]
          };
        });
      } catch (e) {
        console.error('[vscode-compat] definition error:', e);
        return null;
      }
    }
  };
}

// Same but for references (returns multiple results)
function makeReferenceProvider(name, packageName, documentSelector, vscodeProvider) {
  return {
    name,
    packageName,
    isExclusive: false,

    canProvideSymbols(meta) {
      if (meta.type !== 'project-find') return false;
      const grammar = meta.editor.getGrammar();
      return matchesSelector(grammar.scopeName, documentSelector) ? 0.5 : false;
    },

    async getSymbols(meta) {
      const { editor, query, signal } = meta;
      const doc = new TextDocument(editor);
      const cursor = editor.getCursorBufferPosition();
      const pos = new Position(cursor.row, cursor.column);
      const tokenSource = new CancellationTokenSource();
      const ctx = { includeDeclaration: true };

      if (signal) signal.addEventListener('abort', () => tokenSource.cancel(), { once: true });

      try {
        let locations = await vscodeProvider.provideReferences(doc, pos, ctx, tokenSource.token);
        if (signal && signal.aborted) return null;
        if (!locations) return null;

        return locations.map(loc => ({
          name: query || editor.getWordUnderCursor(),
          path: loc.uri.fsPath,
          position: [loc.range.start.line, loc.range.start.character]
        }));
      } catch (e) {
        return null;
      }
    }
  };
}

// Wraps a VSCode DocumentSymbolProvider as a symbols-view file provider
function makeFileSymbolProvider(name, packageName, documentSelector, vscodeProvider) {
  return {
    name,
    packageName,
    isExclusive: false,

    canProvideSymbols(meta) {
      if (meta.type !== 'file') return false;
      const grammar = meta.editor.getGrammar();
      return matchesSelector(grammar.scopeName, documentSelector) ? 0.8 : false;
    },

    async getSymbols(meta) {
      const { editor, signal } = meta;
      const doc = new TextDocument(editor);
      const tokenSource = new CancellationTokenSource();
      if (signal) signal.addEventListener('abort', () => tokenSource.cancel(), { once: true });

      try {
        let symbols = await vscodeProvider.provideDocumentSymbols(doc, tokenSource.token);
        if (signal && signal.aborted) return null;
        if (!symbols) return [];

        return flattenDocumentSymbols(symbols, editor.getPath());
      } catch (e) {
        return null;
      }
    }
  };
}

function flattenDocumentSymbols(symbols, filePath) {
  const result = [];
  function flatten(syms, parent) {
    for (const sym of syms) {
      const range = sym.selectionRange || sym.range || sym.location && sym.location.range;
      const p = range ? range.start : { line: 0, character: 0 };
      result.push({
        name: sym.name,
        path: filePath,
        position: [p.line, p.character],
        tag: sym.kind !== undefined ? symbolKindToTag(sym.kind) : undefined,
        context: parent ? parent.name : undefined
      });
      if (sym.children && sym.children.length) flatten(sym.children, sym);
    }
  }
  flatten(symbols, null);
  return result;
}

const SYMBOL_KIND_TAG = ['file','module','namespace','package','class','method','property','field',
  'constructor','enum','interface','function','variable','constant','string','number','boolean',
  'array','object','key','null','enumMember','struct','event','operator','typeParameter'];

function symbolKindToTag(kind) { return SYMBOL_KIND_TAG[kind] || 'variable'; }

// Wraps a VSCode WorkspaceSymbolProvider as a symbols-view project provider
function makeProjectSymbolProvider(name, packageName, vscodeProvider) {
  return {
    name,
    packageName,
    isExclusive: false,

    canProvideSymbols(meta) {
      return meta.type === 'project' ? 0.5 : false;
    },

    async getSymbols(meta) {
      const { query, signal } = meta;
      const tokenSource = new CancellationTokenSource();
      if (signal) signal.addEventListener('abort', () => tokenSource.cancel(), { once: true });

      try {
        let symbols = await vscodeProvider.provideWorkspaceSymbols(query || '', tokenSource.token);
        if (signal && signal.aborted) return null;
        if (!symbols) return [];

        return symbols.map(sym => {
          const loc = sym.location;
          const p = loc.range ? loc.range.start : { line: 0, character: 0 };
          return {
            name: sym.name,
            path: loc.uri.fsPath,
            position: [p.line, p.character],
            tag: symbolKindToTag(sym.kind)
          };
        });
      } catch (e) {
        return null;
      }
    }
  };
}

module.exports = { makeSymbolProvider, makeReferenceProvider, makeFileSymbolProvider, makeProjectSymbolProvider };
