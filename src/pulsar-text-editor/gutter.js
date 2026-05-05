'use babel';

const { For } = require('solid-js/web');
const { createMemo } = require('solid-js');

const NBSP = ' ';

// One line-number cell in the gutter.
function LineNumber(props) {
  const cls = () => {
    let c = 'line-number';
    if (props.foldable) c += ' foldable';
    const decoClass = props.lineNumberDecoClasses
      ? props.lineNumberDecoClasses().get(props.row)
      : null;
    if (decoClass) c += ' ' + decoClass;
    return c;
  };
  const label = () => {
    if (!props.showLineNumbers) return '';
    const raw = props.softWrapped ? '•' : String(props.bufferRow + 1);
    return NBSP.repeat(Math.max(0, props.maxDigits - raw.length)) + raw;
  };
  return (
    <div class={cls()} data-screen-row={props.row}>
      <span class="line-number-text">{label()}</span>
      <div class="icon-right" />
    </div>
  );
}

// The line-number gutter. Lives OUTSIDE the scroll-view so it never scrolls
// horizontally. Vertical sync is done by applying translateY(-scrollTop) to
// the inner `.gutter` div while the outer wrapper clips with overflow:hidden —
// this keeps the gutter fixed in the flex layout while its content scrolls.
//
// `gutterRef` is attached to the inner div so the scroll handler can update
// the transform imperatively (same frame as the scroll event, no SolidJS lag).
function GutterContainer(props) {
  const gutterItems = createMemo(() => {
    const rows = props.visibleRows();
    const blocks = props.sortedBlocks();
    const items = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      for (let j = 0; j < blocks.length; j++) {
        const b = blocks[j];
        if (b.row === row.screenRow && b.position === 'before') {
          items.push({ type: 'block', height: b.height, key: b });
        }
      }
      items.push({ type: 'line', ...row });
      for (let j = 0; j < blocks.length; j++) {
        const b = blocks[j];
        if (b.row === row.screenRow && b.position === 'after') {
          items.push({ type: 'block', height: b.height, key: b });
        }
      }
    }
    return items;
  });

  return (
    <div style="overflow: hidden; flex-shrink: 0;">
      <div
        ref={props.gutterRef}
        class="gutter line-numbers"
        gutter-name="line-number"
        style={'will-change: transform; transform: translateY(' + (-props.scrollTop()) + 'px);'}
      >
        <div style={`height: ${props.topSpacer()}px; display: block;`} />
        <For each={gutterItems()}>
          {(item) => (
            item.type === 'block'
              ? <div style={`height: ${item.height}px; display: block;`} />
              : <LineNumber
                  row={item.screenRow}
                  bufferRow={item.bufferRow}
                  softWrapped={item.softWrapped}
                  foldable={item.foldable}
                  lineNumberDecoClasses={props.lineNumberDecoClasses}
                  showLineNumbers={props.showLineNumbers()}
                  maxDigits={props.maxDigits()}
                />
          )}
        </For>
        <div style={`height: ${props.bottomSpacer()}px; display: block;`} />
      </div>
    </div>
  );
}

// One custom gutter (anything that isn't the line-number gutter).
function CustomGutter(props) {
  return (
    <div
      class={'gutter' + (props.gutter.className ? ' ' + props.gutter.className : '')}
      gutter-name={props.gutter.name}
    >
      <div
        class="custom-decorations"
        style={'position: relative; height: ' + props.contentHeight() + 'px;'}
      >
        <For each={props.decorations()}>
          {(d) => (
            <CustomGutterDecoration
              decoration={d}
              topForRow={props.topForRow}
              lineHeight={props.lineHeight}
            />
          )}
        </For>
      </div>
    </div>
  );
}

function CustomGutterDecoration(props) {
  const style = () => {
    const lh = props.lineHeight();
    if (!lh) return 'display: none;';
    const range = props.decoration.range;
    const top = props.topForRow(range.start.row);
    const bottom = props.topForRow(range.end.row + 1);
    const height = Math.max(lh, bottom - top);
    return (
      'position: absolute; left: 0; right: 0; ' +
      'top: ' + top + 'px; ' +
      'height: ' + height + 'px;'
    );
  };
  const cls = () => 'decoration' + (props.decoration.class ? ' ' + props.decoration.class : '');
  return (
    <div
      class={cls()}
      style={style()}
      ref={(el) => {
        const item = props.decoration.item;
        if (!item || !el) return;
        const node = item.element || item;
        if (node && node.nodeType === 1 && node.parentNode !== el) {
          el.appendChild(node);
        }
      }}
    />
  );
}

module.exports = { GutterContainer, CustomGutter };
