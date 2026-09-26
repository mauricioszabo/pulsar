// Compares the experimental native Tree-sitter language mode with the JS
// implementation it replaces, on files the bundled grammars highlight.

const fs = require('fs');
const path = require('path');
const { Point } = require('@pulsar-edit/text-buffer');
const WASMTreeSitterLanguageMode = require('../src/wasm-tree-sitter-language-mode');
const NativeTreeSitterLanguageMode = require('../src/native-tree-sitter-language-mode');

const PACKAGES_PATH = path.join(__dirname, '..', 'packages');
const MAX_FILE_SIZE = 60 * 1024;
const FILES_PER_EXTENSION = 4;
const ROWS_PER_CHUNK = 25;

// The language packages' spec fixtures, plus a few of the repository's own
// files for each extension the bundled grammars handle. Set
// NATIVE_TREE_SITTER_COMPARE_PATHS (directories separated by the path
// delimiter) to also compare a few files per extension from elsewhere.
function filesToCompare() {
  let files = [];
  let walk = (dir, visit) => {
    for (let entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      let full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, visit);
      else if (fs.statSync(full).size <= MAX_FILE_SIZE) visit(full);
    }
  };
  for (let name of fs.readdirSync(PACKAGES_PATH)) {
    if (!name.startsWith('language-')) continue;
    let specPath = path.join(PACKAGES_PATH, name, 'spec');
    if (!fs.existsSync(specPath)) continue;
    walk(specPath, (file) => {
      if (!/-spec\.(js|coffee)$/.test(file)) files.push(file);
    });
  }

  let byExtension = new Map();
  let root = path.join(__dirname, '..');
  let dirs = ['src', 'packages', 'static', 'script', 'docs', 'vendor'].map(dir => path.join(root, dir));
  let extraPaths = process.env.NATIVE_TREE_SITTER_COMPARE_PATHS;
  if (extraPaths) dirs.push(...extraPaths.split(path.delimiter).filter(Boolean));
  for (let full of dirs) {
    if (!fs.existsSync(full)) continue;
    walk(full, (file) => {
      let extension = path.extname(file);
      if (!extension) return;
      let list = byExtension.get(extension) ?? [];
      if (list.length < FILES_PER_EXTENSION) list.push(file);
      byExtension.set(extension, list);
    });
  }
  for (let list of byExtension.values()) files.push(...list);
  return files;
}

// The layer's `ScopeResolver` boundaries, with scope names.
function snapshotBoundaries(languageMode, layer) {
  let result = [];
  for (let [point, { open, close }] of layer.scopeResolver) {
    let names = (ids) => ids.map(id => languageMode.scopeNameForScopeId(id)).join(' ');
    result.push(`(${point.row}, ${point.column}) close [${names(close)}] open [${names(open)}]`);
  }
  let invalidated = [...layer.nodesToInvalidateOnChange].sort();
  return { boundaries: result, invalidated };
}

function firstDifference(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) return { index: i, native: a[i], js: b[i] };
  }
  return null;
}

describe('NativeTreeSitterLanguageMode compared with WASMTreeSitterLanguageMode', () => {
  beforeEach(async () => {
    jasmine.useRealClock();
    atom.config.set('core.useTreeSitterParsers', true);
    atom.config.set('core.useExperimentalNativeTreeSitter', true);
    for (let name of fs.readdirSync(PACKAGES_PATH)) {
      if (name.startsWith('language-')) await atom.packages.activatePackage(name);
    }
  });

  it('resolves highlights like ScopeResolver', async () => {
    let compared = 0;
    let mismatches = [];
    let grammars = new Set();

    for (let file of filesToCompare()) {
      let editor = await atom.workspace.open(file);
      let languageMode = editor.getBuffer().getLanguageMode();
      if (!(languageMode instanceof NativeTreeSitterLanguageMode)) {
        editor.destroy();
        continue;
      }
      await languageMode.ready;
      await languageMode.atTransactionEnd();
      // Otherwise both sides would use `ScopeResolver`.
      expect(languageMode.hasStockIdForScope()).toBe(true);

      let buffer = editor.getBuffer();
      let ranges = [[Point.ZERO, buffer.getEndPosition()]];
      for (let row = 0; row <= buffer.getLastRow(); row += ROWS_PER_CHUNK) {
        let end = Math.min(row + ROWS_PER_CHUNK, buffer.getLastRow());
        ranges.push([new Point(row, 0), new Point(end, buffer.lineLengthForRow(end))]);
      }

      for (let layer of languageMode.getAllLanguageLayers()) {
        if (!layer.tree || !layer.queries?.highlightsQuery) continue;
        grammars.add(layer.grammar.scopeName);
        for (let [from, to] of ranges) {
          layer.nodesToInvalidateOnChange.clear();
          languageMode.resolveHighlights(layer, from, to);
          let native = snapshotBoundaries(languageMode, layer);

          layer.nodesToInvalidateOnChange.clear();
          WASMTreeSitterLanguageMode.prototype.resolveHighlights.call(languageMode, layer, from, to);
          let js = snapshotBoundaries(languageMode, layer);
          compared++;

          let difference = firstDifference(native.boundaries, js.boundaries);
          let invalidatedDiffer = native.invalidated.join() !== js.invalidated.join();
          if (difference || invalidatedDiffer) {
            mismatches.push({
              file: path.relative(path.join(__dirname, '..'), file),
              layer: layer.grammar.scopeName,
              range: `${from} - ${to}`,
              difference,
              invalidatedDiffer
            });
          }
        }
      }
      editor.destroy();
    }

    if (mismatches.length > 0) {
      console.log(JSON.stringify(mismatches.slice(0, 20), null, 2));
    }
    console.log(`Compared ${compared} highlight resolutions (${[...grammars].sort().join(', ')}); ${mismatches.length} mismatches`);
    expect(compared).toBeGreaterThan(0);
    expect(mismatches.length).toBe(0);
  }, 600000);
});
