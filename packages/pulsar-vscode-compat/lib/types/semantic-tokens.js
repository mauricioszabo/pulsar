'use strict';

class SemanticTokensLegend {
  constructor(tokenTypes, tokenModifiers) {
    this.tokenTypes = tokenTypes || [];
    this.tokenModifiers = tokenModifiers || [];
  }
}

class SemanticTokens {
  constructor(data, resultId) {
    this.data = data;
    this.resultId = resultId;
  }
}

class SemanticTokensEdit {
  constructor(start, deleteCount, data) {
    this.start = start;
    this.deleteCount = deleteCount;
    this.data = data;
  }
}

class SemanticTokensEdits {
  constructor(edits, resultId) {
    this.edits = edits || [];
    this.resultId = resultId;
  }
}

class SemanticTokensBuilder {
  constructor(legend) {
    this._legend = legend;
    this._data = [];
    this._prevLine = 0;
    this._prevChar = 0;
  }

  push(line, startChar, length, tokenType, tokenModifiers) {
    let modifiers = 0;
    if (Array.isArray(tokenModifiers)) {
      for (const mod of tokenModifiers) {
        const idx = this._legend ? this._legend.tokenModifiers.indexOf(mod) : -1;
        if (idx >= 0) modifiers |= (1 << idx);
      }
    } else if (typeof tokenModifiers === 'number') {
      modifiers = tokenModifiers;
    }
    const typeIdx = (this._legend && typeof tokenType === 'string')
      ? this._legend.tokenTypes.indexOf(tokenType)
      : tokenType;

    const deltaLine = line - this._prevLine;
    const deltaStartChar = deltaLine === 0 ? startChar - this._prevChar : startChar;
    this._data.push(deltaLine, deltaStartChar, length, typeIdx >= 0 ? typeIdx : 0, modifiers);
    this._prevLine = line;
    this._prevChar = startChar;
  }

  build(resultId) {
    return new SemanticTokens(new Uint32Array(this._data), resultId);
  }
}

module.exports = { SemanticTokensLegend, SemanticTokens, SemanticTokensEdit, SemanticTokensEdits, SemanticTokensBuilder };
