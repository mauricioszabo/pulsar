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
  }

  destroy() {
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
        this.emitter.emit('did-attach-editor', editor);
      })
    );

    subscriptions.add(
      element.onDidDetach(() => {
        this.activeEditors.delete(editor);
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
    this.activeEditors.delete(editor);
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
};
