'use strict';

class Disposable {
  constructor(callOnDispose) {
    this._callOnDispose = callOnDispose;
    this._disposed = false;
  }

  dispose() {
    if (!this._disposed) {
      this._disposed = true;
      if (typeof this._callOnDispose === 'function') {
        this._callOnDispose();
      }
    }
  }

  static from(...disposableLikes) {
    return new Disposable(() => {
      for (const d of disposableLikes) {
        if (d && typeof d.dispose === 'function') {
          try { d.dispose(); } catch (e) {}
        }
      }
    });
  }

  static isDisposable(thing) {
    return thing && typeof thing.dispose === 'function';
  }
}

module.exports = { Disposable };
