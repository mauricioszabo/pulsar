'use strict';

class CodeLens {
  constructor(range, command) {
    this.range = range;
    this.command = command;
  }

  get isResolved() { return !!this.command; }
}

module.exports = { CodeLens };
