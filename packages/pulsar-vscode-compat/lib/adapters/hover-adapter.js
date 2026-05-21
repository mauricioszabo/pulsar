'use strict';

const { Position } = require('../types/position');
const { TextDocument } = require('../types/text-document');
const { CancellationTokenSource } = require('../types/cancellation');
const { matchesSelector } = require('../utils/selector');

// Registry of hover providers: {documentSelector, provider}
const hoverProviders = [];
let hoverSetup = false;
let _activeTooltipEl = null;
let _hoverDebounce = null;

function registerHoverProvider(documentSelector, provider) {
  hoverProviders.push({ documentSelector, provider });
  if (!hoverSetup) setupHoverHandling();
}

function setupHoverHandling() {
  hoverSetup = true;

  atom.workspace.observeTextEditors(editor => {
    const el = atom.views.getView(editor);
    if (!el) return;

    const onMouseMove = (event) => {
      clearTimeout(_hoverDebounce);
      _hoverDebounce = setTimeout(() => handleHover(event, editor, el), 400);
    };

    const onMouseLeave = () => {
      clearTimeout(_hoverDebounce);
      removeTooltip();
    };

    el.addEventListener('mousemove', onMouseMove);
    el.addEventListener('mouseleave', onMouseLeave);

    editor.onDidDestroy(() => {
      el.removeEventListener('mousemove', onMouseMove);
      el.removeEventListener('mouseleave', onMouseLeave);
    });
  });
}

async function handleHover(event, editor, editorEl) {
  const grammar = editor.getGrammar();
  const matching = hoverProviders.filter(h => matchesSelector(grammar.scopeName, h.documentSelector));
  if (!matching.length) return;

  let screenPos;
  try {
    if (editorEl.component && editorEl.component.screenPositionForMouseEvent) {
      screenPos = editorEl.component.screenPositionForMouseEvent(event);
    } else {
      return;
    }
  } catch (e) { return; }

  const bufferPos = editor.bufferPositionForScreenPosition(screenPos);
  const pos = new Position(bufferPos.row, bufferPos.column);
  const doc = new TextDocument(editor);

  for (const { provider } of matching) {
    try {
      const tokenSource = new CancellationTokenSource();
      const hover = await provider.provideHover(doc, pos, tokenSource.token);
      if (hover) {
        showTooltip(hover, event, editor);
        return;
      }
    } catch (e) {}
  }
}

function showTooltip(hover, event, editor) {
  removeTooltip();

  const el = document.createElement('div');
  el.classList.add('vscode-hover-tooltip');
  el.style.cssText = `
    position: fixed;
    z-index: 9999;
    background: var(--base-background-color, #2d2d2d);
    border: 1px solid var(--base-border-color, #555);
    border-radius: 4px;
    padding: 6px 10px;
    max-width: 500px;
    max-height: 300px;
    overflow: auto;
    font-size: 12px;
    line-height: 1.5;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    white-space: pre-wrap;
    word-wrap: break-word;
    pointer-events: none;
  `;

  const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
  const html = contents.map(c => {
    if (!c) return '';
    const text = typeof c === 'string' ? c : c.value || '';
    return `<div>${escapeHtml(text)}</div>`;
  }).join('');
  el.innerHTML = html;

  document.body.appendChild(el);
  _activeTooltipEl = el;

  const x = Math.min(event.clientX + 10, window.innerWidth - 520);
  const y = Math.min(event.clientY + 10, window.innerHeight - 320);
  el.style.left = x + 'px';
  el.style.top = y + 'px';
}

function removeTooltip() {
  if (_activeTooltipEl && _activeTooltipEl.parentNode) {
    _activeTooltipEl.parentNode.removeChild(_activeTooltipEl);
  }
  _activeTooltipEl = null;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { registerHoverProvider };
