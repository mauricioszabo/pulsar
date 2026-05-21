'use strict';

const { Position } = require('../types/position');
const { Range } = require('../types/range');
const { TextDocument } = require('../types/text-document');
const { CancellationTokenSource } = require('../types/cancellation');
const { CompletionItemKind, CompletionTriggerKind } = require('../types/completion');
const { matchesSelector } = require('../utils/selector');

const KIND_MAP = {
  [CompletionItemKind.Text]: 'text',
  [CompletionItemKind.Method]: 'method',
  [CompletionItemKind.Function]: 'function',
  [CompletionItemKind.Constructor]: 'function',
  [CompletionItemKind.Field]: 'field',
  [CompletionItemKind.Variable]: 'variable',
  [CompletionItemKind.Class]: 'class',
  [CompletionItemKind.Interface]: 'type',
  [CompletionItemKind.Module]: 'module',
  [CompletionItemKind.Property]: 'property',
  [CompletionItemKind.Unit]: 'value',
  [CompletionItemKind.Value]: 'value',
  [CompletionItemKind.Enum]: 'enum',
  [CompletionItemKind.Keyword]: 'keyword',
  [CompletionItemKind.Snippet]: 'snippet',
  [CompletionItemKind.Color]: 'value',
  [CompletionItemKind.File]: 'import',
  [CompletionItemKind.Reference]: 'reference',
  [CompletionItemKind.Folder]: 'import',
  [CompletionItemKind.Constant]: 'constant',
  [CompletionItemKind.Struct]: 'type',
  [CompletionItemKind.Event]: 'function',
  [CompletionItemKind.Operator]: 'keyword',
  [CompletionItemKind.TypeParameter]: 'type'
};

function makeAutocompleteProvider(documentSelector, vscodeProvider, triggerChars) {
  const selector = buildAtomSelector(documentSelector);
  return {
    selector,
    triggerCharacters: triggerChars || [],
    inclusionPriority: 1,
    excludeLowerPriority: false,

    async getSuggestions({ editor, bufferPosition, triggerCharacter, activatedManually }) {
      const grammar = editor.getGrammar();
      if (!matchesSelector(grammar.scopeName, documentSelector)) return null;

      const doc = new TextDocument(editor);
      const pos = new Position(bufferPosition.row, bufferPosition.column);
      const tokenSource = new CancellationTokenSource();
      const context = {
        triggerKind: activatedManually ? CompletionTriggerKind.Invoke : CompletionTriggerKind.TriggerCharacter,
        triggerCharacter
      };

      try {
        let result = await vscodeProvider.provideCompletionItems(doc, pos, tokenSource.token, context);
        if (!result) return null;

        const items = Array.isArray(result) ? result : result.items || [];
        return items.map(item => convertItem(item, editor, bufferPosition));
      } catch (e) {
        console.error('[vscode-compat] completion error:', e);
        return null;
      }
    },

    async resolveCompletionItem(suggestion) {
      if (!vscodeProvider.resolveCompletionItem || !suggestion._vscodeItem) return suggestion;
      try {
        const tokenSource = new CancellationTokenSource();
        const resolved = await vscodeProvider.resolveCompletionItem(suggestion._vscodeItem, tokenSource.token);
        if (resolved) {
          return convertItem(resolved, suggestion._editor, suggestion._bufferPosition);
        }
      } catch (e) {}
      return suggestion;
    },

    onDidInsertSuggestion({ editor, suggestion }) {
      if (suggestion._vscodeItem && suggestion._vscodeItem.command) {
        executeVSCodeCommand(suggestion._vscodeItem.command);
      }
    }
  };
}

function convertItem(item, editor, bufferPosition) {
  const label = typeof item.label === 'string' ? item.label : (item.label && item.label.label) || '';
  let insertText;
  if (item.insertText) {
    insertText = typeof item.insertText === 'string' ? item.insertText : item.insertText.value;
  } else {
    insertText = label;
  }

  const isSnippet = item.insertText && typeof item.insertText !== 'string';

  let description = '';
  if (item.documentation) {
    description = typeof item.documentation === 'string' ? item.documentation : item.documentation.value;
  }

  return {
    text: isSnippet ? undefined : insertText,
    snippet: isSnippet ? insertText : undefined,
    displayText: label,
    type: KIND_MAP[item.kind] || 'value',
    description: description,
    rightLabel: item.detail || '',
    _vscodeItem: item,
    _editor: editor,
    _bufferPosition: bufferPosition
  };
}

function buildAtomSelector(documentSelector) {
  const entries = Array.isArray(documentSelector) ? documentSelector : [documentSelector];
  const scopes = [];
  for (const entry of entries) {
    if (entry === '*') return '*';
    const lang = typeof entry === 'string' ? entry : (entry && entry.language);
    if (!lang || lang === '*') return '*';
    const { languageToScope } = require('../utils/selector');
    const scope = languageToScope(lang);
    scopes.push(...scope.split(', '));
  }
  return scopes.map(s => `.${s.replace(/\./g, '\\.')}`).join(', ');
}

function executeVSCodeCommand(command) {
  if (!command) return;
  try {
    atom.commands.dispatch(atom.views.getView(atom.workspace), command.command, command.arguments);
  } catch (e) {}
}

module.exports = { makeAutocompleteProvider };
