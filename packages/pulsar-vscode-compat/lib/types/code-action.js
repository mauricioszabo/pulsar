'use strict';

class CodeActionKind {
  constructor(value) { this.value = value; }

  append(parts) {
    return new CodeActionKind(this.value ? `${this.value}.${parts}` : parts);
  }

  intersects(other) {
    return this.value === other.value ||
      this.value.startsWith(other.value + '.') ||
      other.value.startsWith(this.value + '.');
  }

  contains(other) {
    return this.value === other.value || other.value.startsWith(this.value + '.');
  }

  toString() { return this.value; }
}

CodeActionKind.Empty = new CodeActionKind('');
CodeActionKind.QuickFix = new CodeActionKind('quickfix');
CodeActionKind.Refactor = new CodeActionKind('refactor');
CodeActionKind.RefactorExtract = new CodeActionKind('refactor.extract');
CodeActionKind.RefactorInline = new CodeActionKind('refactor.inline');
CodeActionKind.RefactorMove = new CodeActionKind('refactor.move');
CodeActionKind.RefactorRewrite = new CodeActionKind('refactor.rewrite');
CodeActionKind.Source = new CodeActionKind('source');
CodeActionKind.SourceOrganizeImports = new CodeActionKind('source.organizeImports');
CodeActionKind.SourceFixAll = new CodeActionKind('source.fixAll');
CodeActionKind.Notebook = new CodeActionKind('notebook');

const CodeActionTriggerKind = Object.freeze({ Invoke: 1, Automatic: 2 });

class CodeAction {
  constructor(title, kind) {
    this.title = title;
    this.kind = kind;
    this.diagnostics = undefined;
    this.isPreferred = undefined;
    this.disabled = undefined;
    this.edit = undefined;
    this.command = undefined;
    this.data = undefined;
  }
}

module.exports = { CodeActionKind, CodeActionTriggerKind, CodeAction };
