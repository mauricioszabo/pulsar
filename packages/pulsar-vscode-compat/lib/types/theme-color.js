'use strict';

class ThemeColor {
  constructor(id) { this.id = id; }
}

class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }

  static File = new ThemeIcon('file');
  static Folder = new ThemeIcon('folder');
}

module.exports = { ThemeColor, ThemeIcon };
