'use strict';

const { Uri } = require('./uri');
const { Position } = require('./position');
const { Range } = require('./range');

const TextDocumentSaveReason = Object.freeze({ Manual: 1, AfterDelay: 2, FocusOut: 3 });
const EndOfLine = Object.freeze({ LF: 1, CRLF: 2 });

class TextLine {
  constructor(lineNumber, text, range, rangeWithEnd) {
    this.lineNumber = lineNumber;
    this.text = text;
    this.range = range;
    this.rangeIncludingLineBreak = rangeWithEnd;
    this.firstNonWhitespaceCharacterIndex = text.search(/\S/);
    if (this.firstNonWhitespaceCharacterIndex < 0) this.firstNonWhitespaceCharacterIndex = text.length;
    this.isEmptyOrWhitespace = this.firstNonWhitespaceCharacterIndex === text.length;
  }
}

const textDocumentsByEditor = new WeakMap();

function rememberTextDocument(atomEditor, document) {
  if (!atomEditor || !document) return document;
  textDocumentsByEditor.set(atomEditor, document);
  return document;
}

function isClosedTextDocument(document) {
  if (!document) return false;
  try {
    return !!document.isClosed;
  } catch (e) {
    return true;
  }
}

function forgetTextDocument(atomEditor, document) {
  if (!atomEditor) return;
  textDocumentsByEditor.delete(atomEditor);
}

function getTextDocument(atomEditor) {
  if (!atomEditor) return undefined;

  const byEditor = textDocumentsByEditor.get(atomEditor);
  if (byEditor && !isClosedTextDocument(byEditor)) return byEditor;
  if (byEditor) textDocumentsByEditor.delete(atomEditor);

  return rememberTextDocument(atomEditor, new TextDocument(atomEditor));
}

class TextDocument {
  constructor(atomEditor) {
    if (!atomEditor) {
      this._editor = atomEditor;
      return;
    }

    const byEditor = textDocumentsByEditor.get(atomEditor);
    if (byEditor && !isClosedTextDocument(byEditor)) return byEditor;
    if (byEditor) textDocumentsByEditor.delete(atomEditor);

    this._editor = atomEditor;
    rememberTextDocument(atomEditor, this);
  }

  get uri() {
    // Cache the Uri instance and invalidate only when the path changes.
    // Extensions sometimes compare uris with `==` (object identity), so
    // returning a fresh Uri on every access breaks those code paths — e.g.
    // Calva's onDidChangeTextDocument handler bails out unless
    // activeEditor.document.uri == event.document.uri.
    const p = this._editor.getPath();
    const title = p ? null : this._editor.getTitle();
    if (this._cachedUri && this._cachedUriPath === p && this._cachedUriTitle === title) {
      return this._cachedUri;
    }
    this._cachedUri = p ? Uri.file(p) : Uri.from({ scheme: 'untitled', path: title });
    this._cachedUriPath = p;
    this._cachedUriTitle = title;
    return this._cachedUri;
  }

  get fileName() { return this._editor.getPath() || ''; }
  get isUntitled() { return !this._editor.getPath(); }
  get languageId() { return grammarToLanguageId(this._editor.getGrammar()); }

  get version() {
    const buffer = this._editor.getBuffer && this._editor.getBuffer();
    const changeCount = buffer && buffer.changeCount;

    // VS Code TextDocument versions are positive numbers. vscode-languageclient's
    // code2ProtocolConverter also treats a falsy version as "not a document" when
    // it needs to send a full textDocument/didChange notification, so Atom's
    // initial changeCount of 0 would make full-sync didChange conversion throw
    // "Unsupported text document change parameter" before the notification even
    // reaches the language server.
    if (typeof changeCount === 'number' && Number.isFinite(changeCount)) {
      return changeCount + 1;
    }

    return 1;
  }

  get isDirty() { return this._editor.isModified(); }
  get isClosed() { return this._editor.isDestroyed(); }
  get lineCount() { return this._editor.getLineCount(); }

  get eol() {
    const preferred = this._editor.getBuffer().getPreferredLineEnding && this._editor.getBuffer().getPreferredLineEnding();
    return (preferred === '\r\n') ? EndOfLine.CRLF : EndOfLine.LF;
  }

  getText(range) {
    if (range) return this._editor.getTextInBufferRange(range.toAtomRange());

    if (this._editor.getBuffer) {
      const buffer = this._editor.getBuffer();
      if (buffer && typeof buffer.getText === 'function') {
        return buffer.getText();
      }
    }

    return this._editor.getText();
  }

  lineAt(lineOrPosition) {
    const lineNum = lineOrPosition instanceof Position ? lineOrPosition.line : lineOrPosition;
    const text = this._editor.lineTextForBufferRow(lineNum) || '';
    const range = new Range(new Position(lineNum, 0), new Position(lineNum, text.length));
    const rangeWithBreak = new Range(new Position(lineNum, 0), new Position(lineNum + 1, 0));
    return new TextLine(lineNum, text, range, rangeWithBreak);
  }

  offsetAt(position) {
    return this._editor.getBuffer().characterIndexForPosition([position.line, position.character]);
  }

  positionAt(offset) {
    const point = this._editor.getBuffer().positionForCharacterIndex(offset);
    return new Position(point.row, point.column);
  }

  getWordRangeAtPosition(position, regex) {
    const re = regex || /\w+/;
    const line = this.lineAt(position).text;
    let start = position.character;
    let end = position.character;
    const fullLine = line;

    // find word boundaries
    const testRe = new RegExp(re.source, re.flags || 'g');
    let match;
    testRe.lastIndex = 0;
    while ((match = testRe.exec(fullLine)) !== null) {
      if (match.index <= position.character && position.character <= match.index + match[0].length) {
        start = match.index;
        end = match.index + match[0].length;
        break;
      }
    }

    if (start === end) return undefined;
    return new Range(new Position(position.line, start), new Position(position.line, end));
  }

  validatePosition(position) {
    const line = Math.max(0, Math.min(position.line, this.lineCount - 1));
    const lineText = this._editor.lineTextForBufferRow(line) || '';
    const character = Math.max(0, Math.min(position.character, lineText.length));
    return new Position(line, character);
  }

  validateRange(range) {
    return new Range(this.validatePosition(range.start), this.validatePosition(range.end));
  }

  save() {
    return this._editor.getBuffer().save();
  }
}

function grammarToLanguageId(grammar) {
  if (!grammar) return 'plaintext';
  const scope = grammar.scopeName || '';
  const nameMap = {
    'source.js': 'javascript',
    'source.js.jsx': 'javascriptreact',
    'source.ts': 'typescript',
    'source.tsx': 'typescriptreact',
    'source.python': 'python',
    'source.ruby': 'ruby',
    'source.go': 'go',
    'source.rust': 'rust',
    'source.java': 'java',
    'source.c': 'c',
    'source.cpp': 'cpp',
    'source.cs': 'csharp',
    'source.php': 'php',
    'text.html.basic': 'html',
    'source.css': 'css',
    'source.css.scss': 'scss',
    'source.css.less': 'less',
    'source.json': 'json',
    'source.yaml': 'yaml',
    'text.md': 'markdown',
    'source.gfm': 'markdown',
    'text.xml': 'xml',
    'source.sql': 'sql',
    'source.shell': 'shellscript',
    'text.plain': 'plaintext'
  };
  return nameMap[scope] || scope.replace(/^(source|text)\./, '').replace(/\./g, '-');
}

module.exports = { TextDocument, TextLine, TextDocumentSaveReason, EndOfLine, grammarToLanguageId, getTextDocument, forgetTextDocument };
