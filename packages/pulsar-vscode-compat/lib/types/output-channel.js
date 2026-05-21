'use strict';

const LogLevel = Object.freeze({ Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5, Notset: 6 });

class OutputChannel {
  constructor(name, languageId) {
    this.name = name;
    this._languageId = languageId;
    this._content = '';
    this._panel = null;
    this._editorElement = null;
    this._visible = false;
  }

  _ensurePanel() {
    if (this._panel) return;
    const div = document.createElement('div');
    div.style.cssText = 'height:200px;overflow:auto;background:#1e1e1e;color:#d4d4d4;padding:4px;font-family:monospace;font-size:12px;white-space:pre-wrap;';
    div.classList.add('pulsar-output-channel');
    div.dataset.name = this.name;
    this._el = div;
    this._panel = atom.workspace.addBottomPanel({ item: div, visible: false, priority: 100 });
  }

  append(value) {
    this._content += value;
    if (this._el) this._el.textContent = this._content;
  }

  appendLine(value) { this.append(value + '\n'); }

  replace(value) {
    this._content = value;
    if (this._el) this._el.textContent = this._content;
  }

  clear() {
    this._content = '';
    if (this._el) this._el.textContent = '';
  }

  show(preserveFocus) {
    this._ensurePanel();
    this._panel.show();
    this._visible = true;
  }

  hide() {
    if (this._panel) {
      this._panel.hide();
      this._visible = false;
    }
  }

  dispose() {
    if (this._panel) {
      this._panel.destroy();
      this._panel = null;
    }
  }
}

class LogOutputChannel extends OutputChannel {
  constructor(name, options) {
    super(name);
    this.logLevel = LogLevel.Info;
  }

  _log(level, ...args) {
    const msg = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    const prefix = ['', 'TRACE', 'DEBUG', 'INFO ', 'WARN ', 'ERROR'][level] || '';
    const timestamp = new Date().toISOString();
    this.appendLine(`${timestamp} [${prefix}] ${msg}`);
  }

  trace(...args) { if (this.logLevel <= LogLevel.Trace) this._log(LogLevel.Trace, ...args); }
  debug(...args) { if (this.logLevel <= LogLevel.Debug) this._log(LogLevel.Debug, ...args); }
  info(...args) { if (this.logLevel <= LogLevel.Info) this._log(LogLevel.Info, ...args); }
  warn(...args) { if (this.logLevel <= LogLevel.Warning) this._log(LogLevel.Warning, ...args); }
  error(...args) { if (this.logLevel <= LogLevel.Error) this._log(LogLevel.Error, ...args); }
}

module.exports = { OutputChannel, LogOutputChannel, LogLevel };
