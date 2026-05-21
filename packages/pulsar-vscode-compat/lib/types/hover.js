'use strict';

class Hover {
  constructor(contents, range) {
    if (Array.isArray(contents)) {
      this.contents = contents;
    } else {
      this.contents = [contents];
    }
    this.range = range;
  }
}

module.exports = { Hover };
