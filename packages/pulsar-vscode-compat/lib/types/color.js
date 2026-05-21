'use strict';

class Color {
  constructor(red, green, blue, alpha) {
    this.red = red;
    this.green = green;
    this.blue = blue;
    this.alpha = alpha !== undefined ? alpha : 1;
  }
}

class ColorInformation {
  constructor(range, color) {
    this.range = range;
    this.color = color;
  }
}

class ColorPresentation {
  constructor(label) {
    this.label = label;
    this.textEdit = undefined;
    this.additionalTextEdits = undefined;
  }
}

module.exports = { Color, ColorInformation, ColorPresentation };
