'use strict';

const FoldingRangeKind = Object.freeze({ Comment: 'comment', Imports: 'imports', Region: 'region' });

class FoldingRange {
  constructor(start, end, kind) {
    this.start = start;
    this.end = end;
    this.kind = kind;
    this.collapsedText = undefined;
  }
}

module.exports = { FoldingRange, FoldingRangeKind };
