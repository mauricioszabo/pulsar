'use strict';

const SignatureHelpTriggerKind = Object.freeze({ Invoke: 1, TriggerCharacter: 2, ContentChange: 3 });

class ParameterInformation {
  constructor(label, documentation) {
    this.label = label;
    this.documentation = documentation;
  }
}

class SignatureInformation {
  constructor(label, documentation) {
    this.label = label;
    this.documentation = documentation;
    this.parameters = [];
    this.activeParameter = undefined;
  }
}

class SignatureHelp {
  constructor() {
    this.signatures = [];
    this.activeSignature = 0;
    this.activeParameter = 0;
  }
}

module.exports = { SignatureHelpTriggerKind, ParameterInformation, SignatureInformation, SignatureHelp };
