'use strict';

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
    Object.freeze(this);
  }

  isBefore(other) { return this.line < other.line || (this.line === other.line && this.character < other.character); }
  isBeforeOrEqual(other) { return this.isBefore(other) || this.isEqual(other); }
  isAfter(other) { return other.isBefore(this); }
  isAfterOrEqual(other) { return other.isBeforeOrEqual(this); }
  isEqual(other) { return this.line === other.line && this.character === other.character; }

  translate(lineDeltaOrChange, characterDelta) {
    if (typeof lineDeltaOrChange === 'object') {
      const { lineDelta = 0, characterDelta: cd = 0 } = lineDeltaOrChange;
      return new Position(this.line + lineDelta, this.character + cd);
    }
    return new Position(this.line + (lineDeltaOrChange || 0), this.character + (characterDelta || 0));
  }

  with(lineOrChange, character) {
    if (typeof lineOrChange === 'object') {
      const { line = this.line, character: ch = this.character } = lineOrChange || {};
      return new Position(line, ch);
    }
    return new Position(lineOrChange !== undefined ? lineOrChange : this.line, character !== undefined ? character : this.character);
  }

  compareTo(other) {
    if (this.line < other.line) return -1;
    if (this.line > other.line) return 1;
    return this.character - other.character;
  }

  toJSON() { return { line: this.line, character: this.character }; }

  static fromAtomPoint(point) {
    return new Position(point.row, point.column);
  }

  toAtomPoint() {
    return [this.line, this.character];
  }
}

module.exports = { Position };
