// Specs for the tree-sitter-optimized line view's incremental repaint (M4):
// on an edit, only the token spans that actually changed are rebuilt, and
// unchanged tokens keep their exact DOM nodes (their data-ts-col is patched
// when the edit shifts their column). Runs against the real DOM in the Pulsar
// spec environment.

const { _test } = require('../src/pulsar-text-editor/lines-view');
const { planTokenReconcile, buildTokensLineHtml, reconcileTokenDom } = _test;

// Fake language mode: numeric scope id -> class name.
const LM = {
  classNameForScopeId(id) {
    return {
      1: 'syntax--keyword',
      2: 'syntax--type',
      3: 'syntax--kw2',
      5: 'syntax--num'
    }[id] || '';
  }
};
const T = (column, text, scopeIds) => ({ column, text, scopeIds });

describe('tree-sitter incremental token repaint', () => {
  describe('planTokenReconcile (pure diff)', () => {
    it('keeps a common prefix and suffix around the changed middle', () => {
      // `class Foo` -> `cla Foo`: first token changes; space + Foo unchanged.
      const oldT = [T(0, 'class', [1]), T(5, ' ', []), T(6, 'Foo', [2])];
      const newT = [T(0, 'cla', [3]), T(3, ' ', []), T(4, 'Foo', [2])];
      const r = planTokenReconcile(oldT, newT);
      expect(r.p).toBe(0);
      expect(r.s).toBe(2);
    });

    it('matches suffix by content, ignoring column shifts', () => {
      const oldT = [T(0, 'a', [1]), T(1, 'b', [2])];
      const newT = [T(0, 'a', [1]), T(2, 'b', [2])]; // b shifted only
      const r = planTokenReconcile(oldT, newT);
      expect(r.p).toBe(r.oldLen); // everything content-equal
    });

    it('isolates an inserted token', () => {
      const oldT = [T(0, 'a', [1]), T(1, 'b', [2])];
      const newT = [T(0, 'a', [1]), T(1, 'X', [3]), T(2, 'b', [2])];
      const r = planTokenReconcile(oldT, newT);
      expect(r.p).toBe(1);
      expect(r.s).toBe(1);
    });
  });

  describe('reconcileTokenDom (DOM mutation)', () => {
    let el;
    beforeEach(() => { el = document.createElement('div'); });

    it('rebuilds only the changed token and reuses the rest, shifting their data-ts-col', () => {
      const oldT = [T(0, 'class', [1]), T(5, ' ', []), T(6, 'Foo', [2])];
      el.innerHTML = buildTokensLineHtml(oldT, LM, 0);
      const classNode = el.children[0];
      const spaceNode = el.children[1];
      const fooNode = el.children[2];

      const newT = [T(0, 'cla', [3]), T(3, ' ', []), T(4, 'Foo', [2])];
      reconcileTokenDom(el, oldT, newT, LM, 0);

      // Only the first token was rebuilt.
      expect(el.children[0]).not.toBe(classNode);
      expect(el.children[0].textContent).toBe('cla');
      expect(el.children[0].getAttribute('class')).toBe('syntax--kw2');

      // Unchanged tokens keep their exact nodes...
      expect(el.children[1]).toBe(spaceNode);
      expect(el.children[2]).toBe(fooNode);
      // ...with their data-ts-col patched to the new position.
      expect(el.children[2].getAttribute('data-ts-col')).toBe('4');
      const inner = el.children[2].querySelectorAll('[data-ts-col]');
      for (const n of inner) expect(n.getAttribute('data-ts-col')).toBe('4');

      expect(Array.from(el.children).map((c) => c.textContent))
        .toEqual(['cla', ' ', 'Foo']);
    });

    it('repaints a scope-only recolor without touching text or neighbors', () => {
      const oldT = [T(0, 'a', [1]), T(1, 'b', [2])];
      el.innerHTML = buildTokensLineHtml(oldT, LM, 0);
      const aNode = el.children[0];

      reconcileTokenDom(el, oldT, [T(0, 'a', [1]), T(1, 'b', [5])], LM, 0);

      expect(el.children[0]).toBe(aNode);
      expect(el.children[1].textContent).toBe('b');
      expect(el.children[1].getAttribute('class')).toBe('syntax--num');
    });

    it('inserts and deletes tokens while reusing the stable ones', () => {
      const oldT = [T(0, 'a', [1]), T(1, 'b', [2])];
      el.innerHTML = buildTokensLineHtml(oldT, LM, 0);
      const aNode = el.children[0];
      const bNode = el.children[1];

      reconcileTokenDom(el, oldT, [T(0, 'a', [1]), T(1, 'X', [3]), T(2, 'b', [2])], LM, 0);
      expect(el.children[0]).toBe(aNode);
      expect(el.children[1].textContent).toBe('X');
      expect(el.children[2]).toBe(bNode);
      expect(el.children[2].getAttribute('data-ts-col')).toBe('2');
      expect(el.children.length).toBe(3);
    });
  });
});
