'use strict';

// Tree-sitter-optimized text-editor component (see ADR 006 and the
// "Tree-Sitter Optimized Text Editor" plan).
//
// MILESTONE STATUS (M1 — scaffold only): this class currently behaves *exactly*
// like the base `PulsarTextEditorComponent`. It exists so that the
// `core.textEditorImplementation === 'pulsar-tree-sitter'` config path has a
// distinct component to instantiate, and so users can freely toggle between the
// three implementations while the tree-sitter path is built out.
//
// Later milestones add, behind a per-grammar check:
//   M2 – a viewport-rectangle-windowed tokenizer API on the language mode.
//   M3 – direct tree-sitter rendering (one <span> per token, data-ts-row/col),
//        with screen row == buffer row (no folds / soft-wrap yet).
//   M4 – incremental repaint driven by tree-sitter changed ranges.
//
// When the grammar is not a tree-sitter grammar (or folds / soft-wrap are
// active), this component falls back to the base behavior it inherits here.
const PulsarTextEditorComponent = require('./component');

class PulsarTreeSitterTextEditorComponent extends PulsarTextEditorComponent {}

module.exports = PulsarTreeSitterTextEditorComponent;
