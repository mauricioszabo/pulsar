'use strict';

class CancellationToken {
  constructor() {
    this._cancelled = false;
    this._listeners = [];
  }

  get isCancellationRequested() { return this._cancelled; }

  onCancellationRequested(listener) {
    if (this._cancelled) {
      listener();
      return { dispose() {} };
    }
    this._listeners.push(listener);
    return {
      dispose: () => {
        const idx = this._listeners.indexOf(listener);
        if (idx >= 0) this._listeners.splice(idx, 1);
      }
    };
  }

  _cancel() {
    if (!this._cancelled) {
      this._cancelled = true;
      this._listeners.forEach(l => { try { l(); } catch (e) {} });
      this._listeners = [];
    }
  }
}

CancellationToken.None = Object.freeze({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
CancellationToken.Cancelled = Object.freeze({ isCancellationRequested: true, onCancellationRequested: (l) => { l(); return { dispose() {} }; } });

class CancellationTokenSource {
  constructor() {
    this._token = new CancellationToken();
  }

  get token() { return this._token; }

  cancel() { this._token._cancel(); }

  dispose() { this.cancel(); }
}

class CancellationError extends Error {
  constructor() {
    super('Canceled');
    this.name = 'Canceled';
  }
}

module.exports = { CancellationToken, CancellationTokenSource, CancellationError };
