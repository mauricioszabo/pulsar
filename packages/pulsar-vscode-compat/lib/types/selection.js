'use strict';

const { Range } = require('./range');
const { Position } = require('./position');

const selectionState = new WeakMap();

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
    selectionState.set(this, { anchor, active });
  }

  get anchor() { return selectionState.get(this).anchor; }
  get active() { return selectionState.get(this).active; }
  get isReversed() { return this.active.isBefore(this.anchor); }
}

module.exports = { Selection };
