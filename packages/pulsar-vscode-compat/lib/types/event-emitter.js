'use strict';

const { Disposable } = require('./disposable');

class EventEmitter {
  constructor() {
    this._listeners = [];
    this.event = (listener, thisArgs, disposables) => {
      const wrapped = thisArgs ? listener.bind(thisArgs) : listener;
      this._listeners.push(wrapped);
      const d = new Disposable(() => {
        const idx = this._listeners.indexOf(wrapped);
        if (idx >= 0) this._listeners.splice(idx, 1);
      });
      if (Array.isArray(disposables)) disposables.push(d);
      return d;
    };
  }

  fire(data) {
    const listeners = this._listeners.slice();
    for (const l of listeners) {
      try { l(data); } catch (e) { console.error(e); }
    }
  }

  dispose() {
    this._listeners = [];
  }
}

module.exports = { EventEmitter };
