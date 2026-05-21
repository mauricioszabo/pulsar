'use strict';

const { Range } = require('./range');
const { Position } = require('./position');

const SymbolKind = Object.freeze({
  File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4,
  Method: 5, Property: 6, Field: 7, Constructor: 8, Enum: 9,
  Interface: 10, Function: 11, Variable: 12, Constant: 13, String: 14,
  Number: 15, Boolean: 16, Array: 17, Object: 18, Key: 19,
  Null: 20, EnumMember: 21, Struct: 22, Event: 23, Operator: 24,
  TypeParameter: 25
});

const SymbolTag = Object.freeze({ Deprecated: 1 });

class Location {
  constructor(uri, rangeOrPosition) {
    this.uri = uri;
    if (rangeOrPosition instanceof Range) {
      this.range = rangeOrPosition;
    } else {
      this.range = new Range(rangeOrPosition, rangeOrPosition);
    }
  }
}

class LocationLink {
  constructor(originSelectionRange, targetUri, targetRange, targetSelectionRange) {
    this.originSelectionRange = originSelectionRange;
    this.targetUri = targetUri;
    this.targetRange = targetRange;
    this.targetSelectionRange = targetSelectionRange || targetRange;
  }
}

class SymbolInformation {
  constructor(name, kind, containerNameOrRange, locationOrUri, containerName) {
    this.name = name;
    this.kind = kind;
    this.tags = undefined;
    if (containerNameOrRange instanceof Range || containerNameOrRange instanceof Object && 'start' in containerNameOrRange) {
      this.location = new Location(locationOrUri, containerNameOrRange);
      this.containerName = containerName;
    } else {
      this.containerName = containerNameOrRange;
      this.location = locationOrUri instanceof Location ? locationOrUri : new Location(locationOrUri, new Range(new Position(0,0), new Position(0,0)));
    }
  }
}

class DocumentSymbol {
  constructor(name, detail, kind, range, selectionRange) {
    this.name = name;
    this.detail = detail;
    this.kind = kind;
    this.tags = undefined;
    this.range = range;
    this.selectionRange = selectionRange;
    this.children = [];
  }
}

module.exports = { SymbolKind, SymbolTag, Location, LocationLink, SymbolInformation, DocumentSymbol };
