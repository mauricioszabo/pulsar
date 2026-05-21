'use strict';

const { Range } = require('./range');
const { Position } = require('./position');

class TextEdit {
  constructor(range, newText) {
    this.range = range;
    this.newText = newText;
  }

  static replace(range, newText) { return new TextEdit(range, newText); }
  static insert(position, newText) { return new TextEdit(new Range(position, position), newText); }
  static delete(range) { return new TextEdit(range, ''); }
  static setEndOfLine(eol) {
    const edit = new TextEdit(new Range(new Position(0, 0), new Position(0, 0)), '');
    edit._eol = eol;
    return edit;
  }
}

class SnippetString {
  constructor(value) {
    this.value = value || '';
  }

  appendText(str) {
    this.value += str.replace(/\$|\\/g, '\\$&');
    return this;
  }

  appendTabstop(number) {
    this.value += typeof number === 'number' ? `$${number}` : '$0';
    return this;
  }

  appendPlaceholder(value, number) {
    if (typeof value === 'function') {
      const nested = new SnippetString();
      value(nested);
      this.value += `\${${number !== undefined ? number : 1}:${nested.value}}`;
    } else {
      this.value += `\${${number !== undefined ? number : 1}:${value}}`;
    }
    return this;
  }

  appendChoice(values, number) {
    this.value += `\${${number !== undefined ? number : 1}|${values.join(',')}|}`;
    return this;
  }

  appendVariable(name, defaultValue) {
    if (typeof defaultValue === 'function') {
      const nested = new SnippetString();
      defaultValue(nested);
      this.value += `\${${name}:${nested.value}}`;
    } else if (defaultValue) {
      this.value += `\${${name}:${defaultValue}}`;
    } else {
      this.value += `\$${name}`;
    }
    return this;
  }
}

module.exports = { TextEdit, SnippetString };
