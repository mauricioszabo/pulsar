'use strict';

const { Position } = require('./position');

class Range {
  constructor(startOrLine, endOrChar, endLine, endChar) {
    if (startOrLine instanceof Position) {
      this.start = startOrLine;
      this.end = endOrChar;
    } else {
      this.start = new Position(startOrLine, endOrChar);
      this.end = new Position(endLine, endChar);
    }
    if (this.end.isBefore(this.start)) {
      [this.start, this.end] = [this.end, this.start];
    }
    Object.freeze(this);
  }

  get isEmpty() { return this.start.isEqual(this.end); }
  get isSingleLine() { return this.start.line === this.end.line; }

  contains(positionOrRange) {
    if (positionOrRange instanceof Range) {
      return this.contains(positionOrRange.start) && this.contains(positionOrRange.end);
    }
    return positionOrRange.isAfterOrEqual(this.start) && positionOrRange.isBeforeOrEqual(this.end);
  }

  isEqual(other) {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end);
  }

  intersection(other) {
    const start = this.start.isAfter(other.start) ? this.start : other.start;
    const end = this.end.isBefore(other.end) ? this.end : other.end;
    if (start.isAfter(end)) return undefined;
    return new Range(start, end);
  }

  union(other) {
    const start = this.start.isBefore(other.start) ? this.start : other.start;
    const end = this.end.isAfter(other.end) ? this.end : other.end;
    return new Range(start, end);
  }

  with(startOrChange, end) {
    if (typeof startOrChange === 'object' && !(startOrChange instanceof Position)) {
      const { start = this.start, end: e = this.end } = startOrChange || {};
      return new Range(start, e);
    }
    return new Range(startOrChange || this.start, end || this.end);
  }

  toJSON() { return { start: this.start.toJSON(), end: this.end.toJSON() }; }

  static fromAtomRange(range) {
    return new Range(
      new Position(range.start.row, range.start.column),
      new Position(range.end.row, range.end.column)
    );
  }

  toAtomRange() {
    return [[this.start.line, this.start.character], [this.end.line, this.end.character]];
  }
}

module.exports = { Range };
