'use strict';

class DocumentLink {
  constructor(range, target) {
    this.range = range;
    this.target = target;
    this.tooltip = undefined;
  }
}

module.exports = { DocumentLink };
