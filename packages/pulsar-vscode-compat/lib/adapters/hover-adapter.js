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
        await showTooltip(hover, event, editor);
        return;
      }
    } catch (e) {}
  }
}

async function showTooltip(hover, event, editor) {
  removeTooltip();

  const el = document.createElement('div');
  el.classList.add('vscode-hover-tooltip');

  const editorFontSize = atom.config.get('editor.fontSize') || 13;
  const editorFontFamily = atom.config.get('editor.fontFamily') || 'inherit';
  el.style.cssText = `
    position: fixed;
    z-index: 9999;
    background: var(--base-background-color, #2d2d2d);
    color: var(--text-color, inherit);
    border: 1px solid var(--base-border-color, #555);
    border-radius: 4px;
    padding: 8px 10px;
    max-width: min(640px, calc(100vw - 24px));
    max-height: min(420px, calc(100vh - 24px));
    overflow: auto;
    font-size: ${Number(editorFontSize) || 13}px;
    line-height: 1.45;
    font-family: ${cssFontFamily(editorFontFamily)};
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    white-space: normal;
    overflow-wrap: anywhere;
    pointer-events: none;
  `;

  const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
  for (const content of contents) {
    const child = await contentToElement(content, editor);
    if (child && hasMeaningfulContent(child)) el.appendChild(child);
  }

  if (!hasMeaningfulContent(el)) return;

  document.body.appendChild(el);
  _activeTooltipEl = el;

  positionTooltip(el, event);
}

async function contentToElement(content, editor) {
  if (isBlankHoverContent(content)) return null;

  // VSCode MarkedString: { language, value }. Rendering this as a fenced code block lets
  // Pulsar's markdown service handle code block markup and highlighting consistently.
  if (content.language && content.value !== undefined) {
    const language = String(content.language || '').trim();
    const value = String(content.value);
    const fence = '`'.repeat(longestBacktickRun(value) + 1);
    return markdownToElement(`${fence}${language}\n${value}\n${fence}`, editor);
  }

  const value = content.value !== undefined ? content.value : content;
  if (isBlankHoverContent(value)) return null;
  return markdownToElement(String(value), editor);
}

async function markdownToElement(markdown, editor) {
  const wrapper = document.createElement('div');
  wrapper.classList.add('vscode-hover-content', 'markdown');

  const markdownApi = atom.ui && atom.ui.markdown;
  if (!markdownApi || typeof markdownApi.render !== 'function') {
    wrapper.textContent = markdown;
    return wrapper;
  }

  try {
    const html = markdownApi.render(markdown, {
      renderMode: 'fragment',
      breaks: false,
      useDefaultEmoji: true
    });
    const dom = typeof markdownApi.convertToDOM === 'function'
      ? markdownApi.convertToDOM(html)
      : htmlToFragment(html);
    wrapper.appendChild(dom);

    if (typeof markdownApi.applySyntaxHighlighting === 'function') {
      await markdownApi.applySyntaxHighlighting(wrapper, {
        renderMode: 'fragment',
        grammar: editor && editor.getGrammar ? editor.getGrammar() : null,
        syntaxScopeNameFunc(lang) {
          return lang ? `source.${String(lang).toLowerCase()}` : 'source.clojure';
        }
      });
    }
  } catch (e) {
    wrapper.textContent = markdown;
  }

  return wrapper;
}

function htmlToFragment(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content.cloneNode(true);
}

function longestBacktickRun(text) {
  const matches = String(text).match(/`+/g);
  return matches ? Math.max(...matches.map(match => match.length)) : 2;
}

function isBlankHoverContent(content) {
  if (content == null) return true;
  if (typeof content === 'string') return content.trim().length === 0;
  if (content.value !== undefined) return isBlankHoverContent(content.value);
  return false;
}

function hasMeaningfulContent(element) {
  if (!element) return false;
  if ((element.textContent || '').trim().length > 0) return true;

  // Some Markdown can be represented primarily by media or structured elements.
  // Count those as meaningful, but ignore empty wrappers/paragraphs that only
  // produce tooltip chrome.
  return !!element.querySelector('img, svg, video, audio, table, atom-text-editor');
}

function positionTooltip(el, event) {
  const rect = el.getBoundingClientRect();
  const x = Math.max(8, Math.min(event.clientX + 10, window.innerWidth - rect.width - 8));
  const y = Math.max(8, Math.min(event.clientY + 10, window.innerHeight - rect.height - 8));
  el.style.left = x + 'px';
  el.style.top = y + 'px';
}

function removeTooltip() {
  if (_activeTooltipEl && _activeTooltipEl.parentNode) {
    _activeTooltipEl.parentNode.removeChild(_activeTooltipEl);
  }
  _activeTooltipEl = null;
}

function cssFontFamily(value) {
  const text = String(value || 'inherit').trim();
  if (!text || text === 'inherit') return 'inherit';
  return text.replace(/[;{}]/g, '');
}

module.exports = { registerHoverProvider };
