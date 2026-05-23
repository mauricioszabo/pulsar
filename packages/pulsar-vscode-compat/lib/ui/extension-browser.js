'use strict';

const OPEN_VSX_API = 'https://open-vsx.org/api';
const BROWSER_URI  = 'pulsar-vscode-compat://extensions';
const DEFAULT_RESULT_COUNT = 30;

// ─── Pane item ────────────────────────────────────────────────────────────────

class ExtensionBrowserView {
  constructor(state) {
    this.element = document.createElement('div');
    this.element.className = 'pulsar-vsx-browser';
    this._requestSerial = 0;
    this._selectedItem = null;
    this._buildUI();
    if (state && state.query) {
      this._searchInput.value = state.query;
      this._doSearch();
    } else {
      this._loadRecommended();
    }
  }

  static get URI() { return BROWSER_URI; }

  // Pulsar pane-item protocol
  getTitle()    { return 'VSCode Extensions'; }
  getIconName() { return 'package'; }
  getURI()      { return BROWSER_URI; }
  getElement()  { return this.element; }
  destroy()     { this.element.remove(); }
  serialize()   { return { deserializer: 'PulsarVsxBrowser', query: this._searchInput.value }; }

  // ─── UI construction ──────────────────────────────────────────────────────

  _buildUI() {
    this.element.innerHTML = `
      <div class="vsx-toolbar">
        <div class="vsx-heading">
          <span class="vsx-title icon icon-package">VSCode Extensions</span>
          <span class="vsx-subtitle text-subtle">Browse and install from Open VSX</span>
        </div>
        <div class="vsx-search-group">
          <input class="vsx-search input-text native-key-bindings" type="text" placeholder="Search extensions…">
          <button class="vsx-search-btn btn btn-primary">Search</button>
        </div>
      </div>
      <div class="vsx-body">
        <div class="vsx-list">
          ${this._loadingMarkup('Loading recommended extensions…')}
        </div>
        <div class="vsx-detail">
          <div class="vsx-welcome">
            <div class="vsx-welcome-icon icon icon-package"></div>
            <h2>Find VSCode extensions for Pulsar</h2>
            <p class="text-subtle">Recommended Open VSX extensions are loading. Select an extension to inspect details and install it.</p>
          </div>
        </div>
      </div>
      <div class="vsx-statusbar text-subtle">Loading recommended extensions…</div>
    `;

    this._searchInput = this.element.querySelector('.vsx-search');
    this._searchBtn   = this.element.querySelector('.vsx-search-btn');
    this._listEl      = this.element.querySelector('.vsx-list');
    this._detailEl    = this.element.querySelector('.vsx-detail');
    this._statusEl    = this.element.querySelector('.vsx-statusbar');

    this._searchInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') this._doSearch();
    });
    this._searchBtn.addEventListener('click', () => this._doSearch());
  }

  // ─── Search/default listings ──────────────────────────────────────────────

  async _loadRecommended() {
    return this._loadExtensions({
      title: 'Recommended extensions',
      status: 'Loading recommended extensions…',
      url: `${OPEN_VSX_API}/-/search?size=${DEFAULT_RESULT_COUNT}`,
      emptyMessage: 'No recommended extensions were returned by Open VSX.'
    });
  }

  async _doSearch() {
    const query = this._searchInput.value.trim();
    if (!query) return this._loadRecommended();

    const params = new URLSearchParams({ query, size: String(DEFAULT_RESULT_COUNT) });
    return this._loadExtensions({
      title: `Search results for “${query}”`,
      status: `Searching Open VSX for “${query}”…`,
      url: `${OPEN_VSX_API}/-/search?${params.toString()}`,
      emptyMessage: `No extensions found for “${query}”.`
    });
  }

  async _loadExtensions({ title, status, url, emptyMessage }) {
    const requestId = ++this._requestSerial;
    this._setListLoading(status);
    this._setSearchBusy(true);
    this._status(status);

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Open VSX returned HTTP ${res.status}`);

      const data = await res.json();
      if (requestId !== this._requestSerial) return;

      const exts = data.extensions || [];
      this._renderResults(exts, { title, total: data.totalSize, emptyMessage });
      this._status(exts.length ? `${data.totalSize || exts.length} extension(s)` : emptyMessage);
    } catch (e) {
      if (requestId !== this._requestSerial) return;
      this._renderListMessage('Search failed', e.message, 'error');
      this._status('Failed to load extensions');
    } finally {
      if (requestId === this._requestSerial) this._setSearchBusy(false);
    }
  }

  _renderResults(extensions, { title, total, emptyMessage }) {
    if (!extensions.length) {
      this._renderListMessage(title, emptyMessage, 'empty');
      return;
    }

    this._selectedItem = null;
    this._listEl.innerHTML = `
      <div class="vsx-list-header">
        <div class="vsx-list-title">${this._e(title)}</div>
        <div class="vsx-list-count text-subtle">${this._formatCount(total || extensions.length)} result(s)</div>
      </div>
    `;

    for (const ext of extensions) {
      const item = document.createElement('div');
      item.className = 'vsx-result-item';
      item.innerHTML = `
        <div class="vsx-result-icon-wrap">
          ${this._iconMarkup(ext)}
        </div>
        <div class="vsx-result-body">
          <div class="vsx-result-name">${this._e(ext.displayName || ext.name)}</div>
          <div class="vsx-result-id text-subtle">${this._e(ext.namespace)}.${this._e(ext.name)} &middot; v${this._e(ext.version || '?')}</div>
          <div class="vsx-result-desc text-subtle">${this._e(ext.description || '')}</div>
          <div class="vsx-result-meta text-subtle">
            <span class="icon icon-cloud-download">${this._formatCount(ext.downloadCount || 0)}</span>
            ${ext.averageRating ? `<span class="icon icon-star">${this._e(this._formatRating(ext.averageRating))}</span>` : ''}
            ${ext.verified ? '<span class="icon icon-verified">Verified</span>' : ''}
          </div>
        </div>
      `;
      item.addEventListener('click', () => {
        if (this._selectedItem) this._selectedItem.classList.remove('selected');
        this._selectedItem = item;
        item.classList.add('selected');
        this._showDetail(ext);
      });
      this._listEl.appendChild(item);
    }
  }

  // ─── Detail panel ─────────────────────────────────────────────────────────

  async _showDetail(ext) {
    const requestId = ++this._requestSerial;
    this._detailEl.classList.remove('hidden');
    this._detailEl.innerHTML = this._loadingMarkup('Loading extension details…');
    this._status(`Loading ${ext.namespace}.${ext.name}…`);

    try {
      const res  = await fetch(`${OPEN_VSX_API}/${ext.namespace}/${ext.name}/${ext.version || 'latest'}`);
      if (!res.ok) throw new Error(`Open VSX returned HTTP ${res.status}`);

      const data = await res.json();
      if (requestId !== this._requestSerial) return;

      const pkgName     = `vscode-${data.namespace}-${data.name}`;
      const isInstalled = !!atom.packages.getLoadedPackage(pkgName);

      this._detailEl.innerHTML = `
        <div class="vsx-detail-header">
          <div class="vsx-detail-icon-wrap">${this._iconMarkup(data)}</div>
          <div class="vsx-detail-title-block">
            <div class="vsx-detail-name">${this._e(data.displayName || data.name)}</div>
            <div class="vsx-detail-id text-subtle">${this._e(data.namespace)}.${this._e(data.name)} &middot; v${this._e(data.version)}</div>
            <div class="vsx-detail-desc">${this._e(data.description || '')}</div>
            <div class="vsx-detail-meta text-subtle">
              <span class="icon icon-cloud-download">${this._formatCount(data.downloadCount || 0)} downloads</span>
              ${data.averageRating ? `<span class="icon icon-star">${this._e(this._formatRating(data.averageRating))} rating</span>` : ''}
              ${data.verified ? '<span class="icon icon-verified">Verified publisher</span>' : ''}
            </div>
            <div class="vsx-detail-actions">
              <button class="btn btn-primary vsx-btn-install">${isInstalled ? 'Reinstall' : 'Install'}</button>
              ${isInstalled ? `<button class="btn vsx-btn-configure">Configure</button>` : ''}
            </div>
            <div class="vsx-progress text-subtle hidden"></div>
          </div>
        </div>
        <hr>
        <div class="vsx-readme-pane">
          ${this._loadingMarkup('Loading README…')}
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

      this._status(`Loaded ${data.displayName || data.name}`);
      this._loadReadme(data, requestId);
    } catch (e) {
      if (requestId !== this._requestSerial) return;
      this._detailEl.innerHTML = `<div class="vsx-error text-error">Failed to load details: ${this._e(e.message)}</div>`;
      this._status('Failed to load extension details');
    }
  }

  async _loadReadme(data, requestId) {
    const readmeUrl = data.files && data.files.readme;
    const pane = this._detailEl.querySelector('.vsx-readme-pane');
    if (!pane) return;

    if (!readmeUrl) {
      pane.innerHTML = '<div class="vsx-empty text-subtle">No README available.</div>';
      return;
    }

    try {
      const res = await fetch(readmeUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (requestId !== this._requestSerial) return;
      const currentPane = this._detailEl.querySelector('.vsx-readme-pane');
      if (currentPane) await this._renderReadmeMarkdown(currentPane, text, data, readmeUrl);
    } catch (_) {
      if (requestId !== this._requestSerial) return;
      const currentPane = this._detailEl.querySelector('.vsx-readme-pane');
      if (currentPane) currentPane.innerHTML = '<div class="vsx-empty text-subtle">README could not be loaded.</div>';
    }
  }

  async _renderReadmeMarkdown(pane, text, data, readmeUrl) {
    pane.innerHTML = '';

    const readme = document.createElement('div');
    readme.className = 'vsx-readme markdown-body native-key-bindings';
    readme.tabIndex = -1;

    const markdownApi = atom.ui && atom.ui.markdown;
    if (!markdownApi || typeof markdownApi.render !== 'function') {
      readme.innerHTML = `<pre>${this._e(text)}</pre>`;
      pane.appendChild(readme);
      return;
    }

    try {
      const html = markdownApi.render(text || '### No README.', {
        renderMode: 'fragment',
        rootDomain: this._readmeRootDomain(data, readmeUrl),
        breaks: false,
        taskCheckboxDisabled: true,
        useDefaultEmoji: true
      });

      if (typeof markdownApi.convertToDOM === 'function') {
        readme.appendChild(markdownApi.convertToDOM(html));
      } else {
        readme.innerHTML = html;
      }

      pane.appendChild(readme);

      if (typeof markdownApi.applySyntaxHighlighting === 'function') {
        await markdownApi.applySyntaxHighlighting(readme, {
          renderMode: 'fragment',
          syntaxScopeNameFunc: fence => fence ? `source.${String(fence).toLowerCase()}` : 'text.plain'
        });
      }
    } catch (err) {
      readme.innerHTML = `<h3>Error parsing README</h3><pre>${this._e(text)}</pre>`;
      pane.appendChild(readme);
    }
  }

  _readmeRootDomain(data, readmeUrl) {
    if (data && data.repository) return data.repository;
    if (data && data.homepage) return data.homepage;
    return String(readmeUrl || '').replace(/\/[^/]*$/, '');
  }

  // ─── Install ──────────────────────────────────────────────────────────────

  async _install(data, btn, progressEl) {
    btn.disabled = true;
    btn.textContent = 'Installing…';
    progressEl.classList.remove('hidden');
    progressEl.innerHTML = this._inlineLoadingMarkup('Installing extension…');

    try {
      const { installFromOpenVsx } = require('./install-vsx');
      await installFromOpenVsx(data.namespace, data.name, data.version, msg => {
        progressEl.innerHTML = this._inlineLoadingMarkup(msg);
        this._status(msg);
      });

      btn.textContent = 'Installed ✓';
      progressEl.textContent = 'Installed. Reload Pulsar to activate this extension.';
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

  _setListLoading(message) {
    this._listEl.innerHTML = this._loadingMarkup(message);
  }

  _setSearchBusy(isBusy) {
    this._searchBtn.disabled = isBusy;
    this._searchInput.disabled = isBusy;
    this._searchBtn.textContent = isBusy ? 'Loading…' : 'Search';
  }

  _renderListMessage(title, message, type) {
    const icon = type === 'error' ? 'alert' : 'package';
    const cls = type === 'error' ? 'vsx-error text-error' : 'vsx-empty text-subtle';
    this._listEl.innerHTML = `
      <div class="${cls}">
        <div class="vsx-message-icon icon icon-${icon}"></div>
        <div class="vsx-message-title">${this._e(title)}</div>
        <div>${this._e(message)}</div>
      </div>
    `;
  }

  _loadingMarkup(message) {
    return `
      <div class="vsx-loading text-subtle">
        <span class="vsx-spinner"></span>
        <span>${this._e(message)}</span>
      </div>
    `;
  }

  _inlineLoadingMarkup(message) {
    return `<span class="vsx-inline-loading"><span class="vsx-spinner"></span>${this._e(message)}</span>`;
  }

  _iconMarkup(ext) {
    const iconUrl = ext.files && ext.files.icon;
    if (iconUrl) {
      return `<img class="vsx-extension-icon" src="${this._e(iconUrl)}" alt="">`;
    }
    return '<div class="vsx-extension-icon-fallback icon icon-package"></div>';
  }

  _formatCount(count) {
    const value = Number(count) || 0;
    if (value >= 1000000) return `${(value / 1000000).toFixed(value >= 10000000 ? 0 : 1)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}K`;
    return String(value);
  }

  _formatRating(rating) {
    return Number(rating).toFixed(1);
  }

  _e(str) {
    return String(str == null ? '' : str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  _status(msg) {
    if (this._statusEl) this._statusEl.textContent = msg;
  }
}

module.exports = { ExtensionBrowserView, BROWSER_URI };
