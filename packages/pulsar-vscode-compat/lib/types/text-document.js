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

class TextDocument {
  constructor(atomEditor) {
    this._editor = atomEditor;
  }

  get uri() {
    const p = this._editor.getPath();
    return p ? Uri.file(p) : Uri.from({ scheme: 'untitled', path: this._editor.getTitle() });
  }

  get fileName() { return this._editor.getPath() || ''; }
  get isUntitled() { return !this._editor.getPath(); }
  get languageId() { return grammarToLanguageId(this._editor.getGrammar()); }
  get version() { return this._editor.getBuffer().changeCount; }
  get isDirty() { return this._editor.isModified(); }
  get isClosed() { return this._editor.isDestroyed(); }
  get lineCount() { return this._editor.getLineCount(); }

  get eol() {
    const preferred = this._editor.getBuffer().getPreferredLineEnding && this._editor.getBuffer().getPreferredLineEnding();
    return (preferred === '\r\n') ? EndOfLine.CRLF : EndOfLine.LF;
  }

  getText(range) {
    if (!range) return this._editor.getText();
    return this._editor.getTextInBufferRange(range.toAtomRange());
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

module.exports = { TextDocument, TextLine, TextDocumentSaveReason, EndOfLine, grammarToLanguageId };
