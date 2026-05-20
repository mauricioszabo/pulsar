const { Emitter, CompositeDisposable, Disposable } = require('event-kit');

// Registry for "code editors" — TextEditors created outside the pane system
// via `atom.workspace.createTextEditor()`. Lifecycle is DOM-driven: an editor
// becomes active when its element attaches to the document, and inactive when
// it detaches.
module.exports = class CodeEditorRegistry {
  constructor() {
    this.emitter = new Emitter();
    this.editors = new Set();
    this.activeEditors = new Set();
    // Only used to deduplicate did-change-active-editor emissions.
    this._prevActive = null;
    this._focusHandler = () => this._handleFocusin();
  }

  destroy() {
    if (this.activeEditors.size > 0) {
      document.removeEventListener('focusin', this._focusHandler, true);
    }
    this.emitter.dispose();
  }

  // Register an editor and subscribe to its element's DOM lifecycle.
  // Returns a {Disposable} — call dispose() to unregister and clean up.
  add(editor) {
    this.editors.add(editor);
    const element = editor.getElement();
    const subscriptions = new CompositeDisposable();

    subscriptions.add(
      element.onDidAttach(() => {
        this.activeEditors.add(editor);
        if (this.activeEditors.size === 1) {
          document.addEventListener('focusin', this._focusHandler, true);
        }
        this.emitter.emit('did-attach-editor', editor);
      })
    );

    subscriptions.add(
      element.onDidDetach(() => {
        this.activeEditors.delete(editor);
        if (this.activeEditors.size === 0) {
          document.removeEventListener('focusin', this._focusHandler, true);
        }
        // If this editor was the last one we emitted as active, re-check now
        // that it's gone (getActiveEditor will no longer find it).
        if (this._prevActive === editor) {
          const nowActive = this.getActiveEditor();
          this._prevActive = nowActive;
          this.emitter.emit('did-change-active-editor', nowActive);
        }
        this.emitter.emit('did-detach-editor', editor);
      })
    );

    subscriptions.add(
      editor.onDidDestroy(() => {
        this.remove(editor);
        subscriptions.dispose();
      })
    );

    return new Disposable(() => {
      this.remove(editor);
      subscriptions.dispose();
    });
  }

  remove(editor) {
    this.editors.delete(editor);
    if (this.activeEditors.delete(editor)) {
      if (this.activeEditors.size === 0) {
        document.removeEventListener('focusin', this._focusHandler, true);
      }
      if (this._prevActive === editor) {
        const nowActive = this.getActiveEditor();
        this._prevActive = nowActive;
        this.emitter.emit('did-change-active-editor', nowActive);
      }
    }
  }

  _handleFocusin() {
    const focused = this.getActiveEditor();
    if (focused !== this._prevActive) {
      this._prevActive = focused;
      this.emitter.emit('did-change-active-editor', focused);
    }
  }

  // Returns the code editor whose element currently contains DOM focus, or null.
  // Computed directly from document.activeElement — no cached state.
  getActiveEditor() {
    for (const editor of this.activeEditors) {
      const el = editor.getElement();
      if (el === document.activeElement || el.contains(document.activeElement)) {
        return editor;
      }
    }
    return null;
  }

  // Returns all editors currently attached to the DOM.
  getActiveEditors() {
    return Array.from(this.activeEditors);
  }

  // Invoke callback for each currently-attached editor and for all future
  // editors when they attach. Returns a {Disposable}.
  observe(callback) {
    this.activeEditors.forEach(callback);
    return this.emitter.on('did-attach-editor', callback);
  }

  // Subscribe to future attach events only. Returns a {Disposable}.
  onDidAttachEditor(callback) {
    return this.emitter.on('did-attach-editor', callback);
  }

  // Subscribe to detach events. Returns a {Disposable}.
  onDidDetachEditor(callback) {
    return this.emitter.on('did-detach-editor', callback);
  }

  // Subscribe to active (focused) editor changes among code editors.
  // Callback receives the newly focused editor, or null when none has focus.
  // Returns a {Disposable}.
  onDidChangeActiveEditor(callback) {
    return this.emitter.on('did-change-active-editor', callback);
  }
};
