'use strict';

const InlayHintKind = Object.freeze({ Type: 1, Parameter: 2 });

class InlayHintLabelPart {
  constructor(value) {
    this.value = value;
    this.tooltip = undefined;
    this.location = undefined;
    this.command = undefined;
  }
}

class InlayHint {
  constructor(position, label, kind) {
    this.position = position;
    this.label = label;
    this.kind = kind;
    this.textEdits = undefined;
    this.tooltip = undefined;
    this.paddingLeft = undefined;
    this.paddingRight = undefined;
  }
}

module.exports = { InlayHintKind, InlayHint, InlayHintLabelPart };
