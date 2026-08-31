const {
  walkScreenLineTags
} = require('../src/screen-line-tag-walker');

// A toy display layer mirroring the @pulsar-edit/text-buffer encoding:
//   tag < 0 and odd  -> open scope
//   tag < 0 and even -> close scope
//   tag > 0          -> text run length
const SCOPE_CLASS_NAMES = {
  '-1': 'syntax--keyword',
  '-3': 'syntax--string'
};
const fakeDisplayLayer = {
  isOpenTag: tag => tag < 0 && tag % 2 !== 0,
  isCloseTag: tag => tag < 0 && tag % 2 === 0,
  classNameForTag: tag => SCOPE_CLASS_NAMES[String(tag)] || ''
};

function collect(opts) {
  const events = [];
  const totalColumn = walkScreenLineTags({
    displayLayer: fakeDisplayLayer,
    onOpenScope: cls => events.push(['open', cls]),
    onCloseScope: () => events.push(['close']),
    onTextRun: (text, cls, style) =>
      events.push(['text', text, cls || null, style || null]),
    ...opts
  });
  return { events, totalColumn };
}

describe('walkScreenLineTags', () => {
  // "let x = 'hi';" with a keyword scope on "let" and a string scope on "'hi'"
  const tags = [-1, 3, -2, 5, -3, 4, -4, 1];
  const lineText = "let x = 'hi';";

  it('emits the full scope/text sequence when no range is supplied', () => {
    const { events, totalColumn } = collect({ tags, lineText });
    expect(events).toEqual([
      ['open', 'syntax--keyword'],
      ['text', 'let', null, null],
      ['close'],
      ['text', ' x = ', null, null],
      ['open', 'syntax--string'],
      ['text', "'hi'", null, null],
      ['close'],
      ['text', ';', null, null]
    ]);
    expect(totalColumn).toBe(lineText.length);
  });

  it('clips text runs to a partial visible column range', () => {
    const { events } = collect({
      tags,
      lineText,
      visibleColumnRange: [9, 11]
    });
    // Only "hi" inside the string scope is visible. Scopes whose content
    // is invisible are not physically emitted (lazy scope emission).
    expect(events).toEqual([
      ['open', 'syntax--string'],
      ['text', 'hi', null, null],
      ['close']
    ]);
  });

  it('emits nothing when the range falls past the end of the line', () => {
    const { events, totalColumn } = collect({
      tags,
      lineText,
      visibleColumnRange: [20, 30]
    });
    expect(events).toEqual([]);
    expect(totalColumn).toBe(lineText.length);
  });

  it('returns column 0 for an empty screen line', () => {
    const { events, totalColumn } = collect({ tags: [], lineText: '' });
    expect(events).toEqual([]);
    expect(totalColumn).toBe(0);
  });

  it('opens initialScopes before walking a windowed tag stream', () => {
    // Caller supplies a windowed slice covering only " x = 'hi';" (cols 3..13)
    // along with the open scope stack at column 3 (none, since the keyword
    // closed at column 3). For demonstration we instead window cols 8..13
    // where the string scope is already open.
    const windowedTags = [4, -4, 1];
    const windowedText = "'hi';";
    const { events } = collect({
      tags: windowedTags,
      lineText: windowedText,
      initialScopes: [-3]
    });
    expect(events).toEqual([
      ['open', 'syntax--string'],
      ['text', "'hi'", null, null],
      ['close'],
      ['text', ';', null, null]
    ]);
  });

  it('clips around text decorations within the visible range', () => {
    // Two text runs: 5 chars then 5 chars; mark a decoration at column 7.
    const t = [10];
    const text = '0123456789';
    const decorations = [
      { column: 0, className: null, style: null },
      { column: 7, className: 'sel', style: null }
    ];
    const { events } = collect({
      tags: t,
      lineText: text,
      textDecorations: decorations,
      visibleColumnRange: [5, 9]
    });
    // Visible: cols 5..9. Decoration boundary at 7 splits the run at the
    // boundary — left half "56" no class, right half "78" with class "sel".
    expect(events).toEqual([
      ['text', '56', null, null],
      ['text', '78', 'sel', null]
    ]);
  });

  it('processes very long single-line input in O(visible window) text events', () => {
    const big = 'a'.repeat(200000);
    const bigTags = [-1, big.length, -2];
    const events = [];
    walkScreenLineTags({
      tags: bigTags,
      lineText: big,
      displayLayer: fakeDisplayLayer,
      visibleColumnRange: [10000, 10100],
      onOpenScope: cls => events.push(['open', cls]),
      onCloseScope: () => events.push(['close']),
      onTextRun: text => events.push(['text', text.length])
    });
    const textEvents = events.filter(e => e[0] === 'text');
    expect(textEvents.length).toBe(1);
    // 100 visible columns out of 200,000 — node count should match.
    expect(textEvents[0][1]).toBe(100);
  });
});
