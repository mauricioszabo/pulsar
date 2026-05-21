'use strict';

const StatusBarAlignment = Object.freeze({ Left: 1, Right: 2 });

class StatusBarItem {
  constructor(alignment, priority, statusBarService) {
    this.alignment = alignment || StatusBarAlignment.Left;
    this.priority = priority !== undefined ? priority : 0;
    this._statusBar = statusBarService;
    this._tile = null;
    this._el = document.createElement('span');
    this._el.classList.add('vscode-status-bar-item');
    this._el.style.cssText = 'margin: 0 4px; cursor: pointer;';
    this._visible = false;

    this._text = '';
    this._tooltip = '';
    this._color = undefined;
    this._backgroundColor = undefined;
    this._command = undefined;

    this._el.addEventListener('click', () => {
      if (this._command) {
        if (typeof this._command === 'string') {
          atom.commands.dispatch(atom.views.getView(atom.workspace), this._command);
        } else if (this._command.command) {
          atom.commands.dispatch(atom.views.getView(atom.workspace), this._command.command);
        }
      }
    });
  }

  get text() { return this._text; }
  set text(v) {
    this._text = v || '';
    this._el.textContent = this._text.replace(/\$\(.+?\)/g, ''); // strip icon refs for now
  }

  get tooltip() { return this._tooltip; }
  set tooltip(v) {
    this._tooltip = typeof v === 'string' ? v : (v && v.value) || '';
    this._el.title = this._tooltip;
  }

  get color() { return this._color; }
  set color(v) {
    this._color = v;
    this._el.style.color = typeof v === 'string' ? v : '';
  }

  get backgroundColor() { return this._backgroundColor; }
  set backgroundColor(v) {
    this._backgroundColor = v;
    this._el.style.backgroundColor = typeof v === 'string' ? v : '';
  }

  get command() { return this._command; }
  set command(v) { this._command = v; }

  get name() { return this._name; }
  set name(v) { this._name = v; }

  get accessibilityInformation() { return this._a11y; }
  set accessibilityInformation(v) {
    this._a11y = v;
    if (v && v.label) this._el.setAttribute('aria-label', v.label);
  }

  show() {
    if (this._tile || !this._statusBar) return;
    const opts = { item: this._el, priority: this.priority };
    this._tile = this.alignment === StatusBarAlignment.Left
      ? this._statusBar.addLeftTile(opts)
      : this._statusBar.addRightTile(opts);
    this._visible = true;
  }

  hide() {
    if (this._tile) {
      this._tile.destroy();
      this._tile = null;
      this._visible = false;
    }
  }

  dispose() { this.hide(); }
}

module.exports = { StatusBarItem, StatusBarAlignment };
