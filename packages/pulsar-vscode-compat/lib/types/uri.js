'use strict';

const path = require('path');

class Uri {
  constructor(scheme, authority, uriPath, query, fragment) {
    this.scheme = scheme || '';
    this.authority = authority || '';
    this.path = uriPath || '';
    this.query = query || '';
    this.fragment = fragment || '';
    Object.freeze(this);
  }

  get fsPath() {
    if (this.scheme !== 'file') return this.path;
    let p = this.path;
    if (process.platform === 'win32' && p.startsWith('/')) p = p.slice(1);
    return p.replace(/\//g, path.sep);
  }

  with(change) {
    return new Uri(
      change.scheme !== undefined ? change.scheme : this.scheme,
      change.authority !== undefined ? change.authority : this.authority,
      change.path !== undefined ? change.path : this.path,
      change.query !== undefined ? change.query : this.query,
      change.fragment !== undefined ? change.fragment : this.fragment
    );
  }

  toString(skipEncoding) {
    let result = '';
    if (this.scheme) result += this.scheme + ':';
    if (this.authority || this.scheme === 'file') result += '//' + (this.authority || '');
    result += this.path;
    if (this.query) result += '?' + this.query;
    if (this.fragment) result += '#' + this.fragment;
    return result;
  }

  toJSON() {
    return {
      scheme: this.scheme,
      authority: this.authority,
      path: this.path,
      query: this.query,
      fragment: this.fragment,
      fsPath: this.fsPath
    };
  }

  static file(filePath) {
    let normalized = filePath.replace(/\\/g, '/');
    if (!normalized.startsWith('/')) normalized = '/' + normalized;
    return new Uri('file', '', normalized, '', '');
  }

  static parse(value, strict) {
    const match = /^(([^:/?#]+):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/.exec(value);
    if (!match) {
      if (strict) throw new Error(`Invalid URI: ${value}`);
      return new Uri('', '', value, '', '');
    }
    return new Uri(
      match[2] || '',
      match[4] || '',
      match[5] || '',
      match[7] || '',
      match[9] || ''
    );
  }

  static joinPath(base, ...pathSegments) {
    const joined = [base.path, ...pathSegments].join('/').replace(/\/+/g, '/');
    return base.with({ path: joined });
  }

  static from(components) {
    return new Uri(
      components.scheme || '',
      components.authority || '',
      components.path || '',
      components.query || '',
      components.fragment || ''
    );
  }
}

module.exports = { Uri };
