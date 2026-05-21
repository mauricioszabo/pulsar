'use strict';

class MarkdownString {
  constructor(value, supportThemeIcons) {
    this.value = value || '';
    this.isTrusted = undefined;
    this.supportThemeIcons = supportThemeIcons || false;
    this.supportHtml = false;
    this.baseUri = undefined;
  }

  appendText(value) {
    this.value += value.replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&');
    return this;
  }

  appendMarkdown(value) {
    this.value += value;
    return this;
  }

  appendCodeblock(value, language) {
    this.value += '\n```' + (language || '') + '\n' + value + '\n```\n';
    return this;
  }
}

module.exports = { MarkdownString };
