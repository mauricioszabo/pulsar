'use strict';

const OPEN_VSX_API = 'https://open-vsx.org/api';
const BROWSER_URI  = 'pulsar-vscode-compat://extensions';

// ─── Pane item ────────────────────────────────────────────────────────────────

class ExtensionBrowserView {
  constructor(state) {
    this.element = document.createElement('div');
    this.element.className = 'pulsar-vsx-browser';
    this._buildUI();
    if (state && state.query) {
      this._searchInput.value = state.query;
    }
  }

  static get URI() { return BROWSER_URI; }

  // Pulsar pane-item protocol
  getTitle()   { return 'VSCode Extensions'; }
  getIconName() { return 'package'; }
  getURI()     { return BROWSER_URI; }
  getElement() { return this.element; }
  destroy()    { this.element.remove(); }
  serialize()  { return { deserializer: 'PulsarVsxBrowser', query: this._searchInput.value }; }

  // ─── UI construction ──────────────────────────────────────────────────────

  _buildUI() {
    this.element.innerHTML = `
      <div class="vsx-toolbar">
        <span class="vsx-title icon icon-package">VSCode Extensions <span class="text-subtle">(Open VSX)</span></span>
        <div class="vsx-search-group">
          <input class="vsx-search input-text native-key-bindings" type="text" placeholder="Search extensions…">
          <button class="vsx-search-btn btn">Search</button>
        </div>
      </div>
      <div class="vsx-body">
        <div class="vsx-list">
          <div class="vsx-hint text-subtle">Search the Open VSX registry above to find and install VSCode extensions.</div>
        </div>
        <div class="vsx-detail hidden"></div>
      </div>
      <div class="vsx-statusbar text-subtle"></div>
    `;

    this._searchInput = this.element.querySelector('.vsx-search');
    this._searchBtn   = this.element.querySelector('.vsx-search-btn');
    this._listEl      = this.element.querySelector('.vsx-list');
    this._detailEl    = this.element.querySelector('.vsx-detail');
    this._statusEl    = this.element.querySelector('.vsx-statusbar');

    this._searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') this._doSearch(); });
    this._searchBtn.addEventListener('click', () => this._doSearch());
  }

  // ─── Search ───────────────────────────────────────────────────────────────

  async _doSearch() {
    const query = this._searchInput.value.trim();
    if (!query) return;

    this._status('Searching Open VSX…');
    this._listEl.innerHTML = '<div class="vsx-loading text-subtle">Searching…</div>';
    this._detailEl.classList.add('hidden');

    try {
      const res  = await fetch(`${OPEN_VSX_API}/-/search?query=${encodeURIComponent(query)}&size=30`);
      const data = await res.json();
      const exts = data.extensions || [];
      this._renderResults(exts);
      this._status(exts.length ? `${data.totalSize || exts.length} result(s)` : 'No results found');
    } catch (e) {
      this._listEl.innerHTML = `<div class="vsx-error text-error">Search failed: ${this._e(e.message)}</div>`;
      this._status('');
    }
  }

  _renderResults(extensions) {
    if (!extensions.length) {
      this._listEl.innerHTML = '<div class="vsx-empty text-subtle">No extensions found.</div>';
      return;
    }
    this._listEl.innerHTML = '';
    for (const ext of extensions) {
      const item = document.createElement('div');
      item.className = 'vsx-result-item';
      item.innerHTML = `
        <div class="vsx-result-icon icon icon-package"></div>
        <div class="vsx-result-body">
          <div class="vsx-result-name">${this._e(ext.displayName || ext.name)}</div>
          <div class="vsx-result-id text-subtle">${this._e(ext.namespace)}.${this._e(ext.name)} &middot; v${this._e(ext.version || '?')}</div>
          <div class="vsx-result-desc text-subtle">${this._e(ext.description || '')}</div>
        </div>
      `;
      item.addEventListener('click', () => this._showDetail(ext));
      this._listEl.appendChild(item);
    }
  }

  // ─── Detail panel ─────────────────────────────────────────────────────────

  async _showDetail(ext) {
    this._detailEl.classList.remove('hidden');
    this._detailEl.innerHTML = '<div class="vsx-loading text-subtle">Loading…</div>';

    try {
      const res  = await fetch(`${OPEN_VSX_API}/${ext.namespace}/${ext.name}/${ext.version || 'latest'}`);
      const data = await res.json();

      const pkgName     = `vscode-${data.namespace}-${data.name}`;
      const isInstalled = !!atom.packages.getLoadedPackage(pkgName);

      this._detailEl.innerHTML = `
        <div class="vsx-detail-header">
          <div class="vsx-detail-name">${this._e(data.displayName || data.name)}</div>
          <div class="vsx-detail-id text-subtle">${this._e(data.namespace)}.${this._e(data.name)} &middot; v${this._e(data.version)}</div>
          <div class="vsx-detail-desc">${this._e(data.description || '')}</div>
          <div class="vsx-detail-actions">
            <button class="btn btn-primary vsx-btn-install">${isInstalled ? 'Reinstall' : 'Install'}</button>
            ${isInstalled ? `<button class="btn vsx-btn-configure">Configure</button>` : ''}
          </div>
          <div class="vsx-progress text-subtle hidden"></div>
        </div>
        <hr>
        <div class="vsx-readme-pane">
          <div class="text-subtle vsx-readme-loading">Loading README…</div>
        </div>
      `;

      const installBtn   = this._detailEl.querySelector('.vsx-btn-install');
      const configureBtn = this._detailEl.querySelector('.vsx-btn-configure');
      const progressEl   = this._detailEl.querySelector('.vsx-progress');

      installBtn.addEventListener('click', () => this._install(data, installBtn, progressEl));
      if (configureBtn) {
        configureBtn.addEventListener('click', () => {
          atom.workspace.open(`atom://config/packages/${pkgName}`);
        });
      }

      // Load README asynchronously
      const readmeUrl = data.files && data.files.readme;
      if (readmeUrl) {
        fetch(readmeUrl).then(r => r.text()).then(text => {
          const pane = this._detailEl.querySelector('.vsx-readme-pane');
          if (pane) pane.innerHTML = `<pre class="vsx-readme">${this._e(text)}</pre>`;
        }).catch(() => {
          const pane = this._detailEl.querySelector('.vsx-readme-pane');
          if (pane) pane.innerHTML = '';
        });
      } else {
        const pane = this._detailEl.querySelector('.vsx-readme-pane');
        if (pane) pane.innerHTML = '';
      }
    } catch (e) {
      this._detailEl.innerHTML = `<div class="vsx-error text-error">Failed to load details: ${this._e(e.message)}</div>`;
    }
  }

  // ─── Install ──────────────────────────────────────────────────────────────

  async _install(data, btn, progressEl) {
    btn.disabled = true;
    btn.textContent = 'Installing…';
    progressEl.classList.remove('hidden');

    try {
      const { installFromOpenVsx } = require('./install-vsx');
      await installFromOpenVsx(data.namespace, data.name, data.version, msg => {
        progressEl.textContent = msg;
        this._status(msg);
      });

      btn.textContent = 'Installed ✓';
      this._status(`Installed ${data.displayName || data.name}`);

      atom.confirm(
        {
          message: `${data.displayName || data.name} installed`,
          detail: 'Reload Pulsar to activate the extension.',
          buttons: ['Reload Now', 'Later'],
        },
        response => { if (response === 0) atom.reload(); }
      );
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Retry';
      progressEl.textContent = `Error: ${e.message}`;
      atom.notifications.addError('Extension install failed', { detail: e.message, dismissable: true });
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  _e(str) {
    return String(str == null ? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  _status(msg) {
    if (this._statusEl) this._statusEl.textContent = msg;
  }
}

module.exports = { ExtensionBrowserView, BROWSER_URI };
