'use strict';

const CompletionItemKind = Object.freeze({
  Text: 1, Method: 2, Function: 3, Constructor: 4, Field: 5,
  Variable: 6, Class: 7, Interface: 8, Module: 9, Property: 10,
  Unit: 11, Value: 12, Enum: 13, Keyword: 14, Snippet: 15,
  Color: 16, File: 17, Reference: 18, Folder: 19, EnumMember: 20,
  Constant: 21, Struct: 22, Event: 23, Operator: 24, TypeParameter: 25
});

const CompletionItemTag = Object.freeze({ Deprecated: 1 });

const CompletionTriggerKind = Object.freeze({
  Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2
});

class CompletionItem {
  constructor(label, kind) {
    this.label = label;
    this.kind = kind;
    this.tags = undefined;
    this.detail = undefined;
    this.documentation = undefined;
    this.sortText = undefined;
    this.filterText = undefined;
    this.preselect = undefined;
    this.insertText = undefined;
    this.insertTextRules = undefined;
    this.range = undefined;
    this.commitCharacters = undefined;
    this.additionalTextEdits = undefined;
    this.command = undefined;
    this.keepWhitespace = undefined;
  }
}

class CompletionList {
  constructor(items, isIncomplete) {
    this.items = items || [];
    this.isIncomplete = isIncomplete || false;
  }
}

const CompletionItemInsertTextRule = Object.freeze({
  None: 0,
  KeepWhitespace: 1,
  InsertAsSnippet: 4
});

module.exports = { CompletionItemKind, CompletionItemTag, CompletionTriggerKind, CompletionItem, CompletionList, CompletionItemInsertTextRule };
