'use strict';

const { TextDocument } = require('../types/text-document');
const { CancellationTokenSource } = require('../types/cancellation');
const { matchesSelector } = require('../utils/selector');
const { Disposable } = require('../types/disposable');

const codeLensProviders = [];
const editorLensState = new WeakMap();

function registerCodeLensProvider(documentSelector, provider) {
  codeLensProviders.push({ documentSelector, provider });
  setupForExistingEditors();
  return new Disposable(() => {
    const idx = codeLensProviders.findIndex(p => p.provider === provider);
    if (idx >= 0) codeLensProviders.splice(idx, 1);
  });
}

function setupForExistingEditors() {
  atom.workspace.observeTextEditors(editor => {
    if (editorLensState.has(editor)) return;
    const grammar = editor.getGrammar();
    const matching = codeLensProviders.filter(p => matchesSelector(grammar.scopeName, p.documentSelector));
    if (!matching.length) return;

    editorLensState.set(editor, []);

    let debounce = null;
    const refresh = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => renderCodeLenses(editor, matching), 500);
    };

    const d1 = editor.onDidStopChanging(refresh);
    const d2 = editor.onDidChangeGrammar(() => {
      const newGrammar = editor.getGrammar();
      const newMatching = codeLensProviders.filter(p => matchesSelector(newGrammar.scopeName, p.documentSelector));
      if (!newMatching.length) clearLenses(editor);
      else renderCodeLenses(editor, newMatching);
    });
    editor.onDidDestroy(() => { clearLenses(editor); d1.dispose(); d2.dispose(); });

    refresh();
  });
}

async function renderCodeLenses(editor, providers) {
  clearLenses(editor);
  const doc = new TextDocument(editor);
  const decorations = [];

  for (const { provider } of providers) {
    try {
      const tokenSource = new CancellationTokenSource();
      let lenses = await provider.provideCodeLenses(doc, tokenSource.token);
      if (!lenses) continue;

      for (let lens of lenses) {
        if (!lens.isResolved && provider.resolveCodeLens) {
          try {
            const resolved = await provider.resolveCodeLens(lens, new CancellationTokenSource().token);
            if (resolved) lens = resolved;
          } catch (e) {}
        }

        if (!lens.command) continue;
        const lineNum = lens.range.start.line;

        const el = document.createElement('div');
        el.classList.add('vscode-code-lens');
        el.style.cssText = 'font-size:11px;color:#888;cursor:pointer;user-select:none;padding:0 4px;';
        const btn = document.createElement('a');
        btn.textContent = lens.command.title || '';
        btn.style.cssText = 'color:inherit;text-decoration:none;';
        btn.addEventListener('click', () => {
          try {
            const cmd = lens.command;
            if (cmd && cmd.command) {
              atom.commands.dispatch(atom.views.getView(atom.workspace), cmd.command, cmd.arguments);
            }
          } catch (e) {}
        });
        el.appendChild(btn);

        const marker = editor.markBufferRange([[lineNum, 0], [lineNum, 0]], { invalidate: 'touch' });
        const decoration = editor.decorateMarker(marker, { type: 'block', position: 'before', item: el });
        decorations.push({ destroy() { marker.destroy(); } });
      }
    } catch (e) {}
  }

  editorLensState.set(editor, decorations);
}

function clearLenses(editor) {
  const existing = editorLensState.get(editor) || [];
  for (const d of existing) { try { d.destroy(); } catch (e) {} }
  editorLensState.set(editor, []);
}

module.exports = { registerCodeLensProvider };
