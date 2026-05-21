'use strict';

const { Range } = require('./range');
const { Position } = require('./position');

class Selection extends Range {
  constructor(anchorOrLine, activeOrChar, activeLine, activeChar) {
    let anchor, active;
    if (anchorOrLine instanceof Position) {
      anchor = anchorOrLine;
      active = activeOrChar;
    } else {
      anchor = new Position(anchorOrLine, activeOrChar);
      active = new Position(activeLine, activeChar);
    }
    super(anchor, active);
    this.anchor = anchor;
    this.active = active;
  }

  get isReversed() { return this.active.isBefore(this.anchor); }
}

module.exports = { Selection };
