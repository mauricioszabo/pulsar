const _ = require('underscore-plus');
const path = require('path');
const fs = require('fs-plus');
const Grim = require('grim');
const dedent = require('dedent');
const { CompositeDisposable, Disposable, Emitter } = require('event-kit');
const TextBuffer = require('text-buffer');
const { Point, Range } = TextBuffer;
const DecorationManager = require('./decoration-manager');
const Cursor = require('./cursor');
const Selection = require('./selection');
const NullGrammar = require('./null-grammar');
const TextMateLanguageMode = require('./text-mate-language-mode');
const ScopeDescriptor = require('./scope-descriptor');

const TextMateScopeSelector = require('first-mate').ScopeSelector;
const GutterContainer = require('./gutter-container');
let TextEditorComponent = null;
let TextEditorElement = null;
const {
  isDoubleWidthCharacter,
  isHalfWidthCharacter,
  isKoreanCharacter,
  isWrapBoundary
} = require('./text-utils');

const SERIALIZATION_VERSION = 1;
const NON_WHITESPACE_REGEXP = /\S/;
const ZERO_WIDTH_NBSP = '\ufeff';
let nextId = 0;

const DEFAULT_NON_WORD_CHARACTERS = '/\\()"\':,.;<>~!@#$%^&*|+=[]{}`?-…';

// Essential: This class represents all essential editing state for a single
// {TextBuffer}, including cursor and selection positions, folds, and soft wraps.
// If you're manipulating the state of an editor, use this class.
//
// A single {TextBuffer} can belong to multiple editors. For example, if the
// same file is open in two different panes, Pulsar creates a separate editor for
// each pane. If the buffer is manipulated the changes are reflected in both
// editors, but each maintains its own cursor position, folded lines, etc.
//
// ## Accessing TextEditor Instances
//
// The easiest way to get hold of `TextEditor` objects is by registering a callback
// with `::observeTextEditors` on the `atom.workspace` global. Your callback will
// then be called with all current editor instances and also when any editor is
// created in the future.
//
// ```js
// atom.workspace.observeTextEditors(editor => {
//   editor.insertText('Hello World')
// })
// ```
//
// ## Buffer vs. Screen Coordinates
//
// Because editors support folds and soft-wrapping, the lines on screen don't
// always match the lines in the buffer. For example, a long line that soft wraps
// twice renders as three lines on screen, but only represents one line in the
// buffer. Similarly, if rows 5-10 are folded, then row 6 on screen corresponds
// to row 11 in the buffer.
//
// Your choice of coordinates systems will depend on what you're trying to
// achieve. For example, if you're writing a command that jumps the cursor up or
// down by 10 lines, you'll want to use screen coordinates because the user
// probably wants to skip lines *on screen*. However, if you're writing a package
// that jumps between method definitions, you'll want to work in buffer
// coordinates.
//
// **When in doubt, just default to buffer coordinates**, then experiment with
// soft wraps and folds to ensure your code interacts with them correctly.
module.exports = class TextEditor {
  static setClipboard(clipboard) {
    this.clipboard = clipboard;
  }

  static setScheduler(scheduler) {
    if (TextEditorComponent == null) {
      TextEditorComponent = require('./text-editor-component');
    }
    return TextEditorComponent.setScheduler(scheduler);
  }

  static didUpdateStyles() {
    if (TextEditorComponent == null) {
      TextEditorComponent = require('./text-editor-component');
    }
    return TextEditorComponent.didUpdateStyles();
  }

  static didUpdateScrollbarStyles() {
    if (TextEditorComponent == null) {
      TextEditorComponent = require('./text-editor-component');
    }
    return TextEditorComponent.didUpdateScrollbarStyles();
  }

  static viewForItem(item) {
    return item.element || item;
  }

  static deserialize(state, atomEnvironment) {
    if (state.version !== SERIALIZATION_VERSION) return null;

    let bufferId = state.tokenizedBuffer
      ? state.tokenizedBuffer.bufferId
      : state.bufferId;

    try {
      state.buffer = atomEnvironment.project.bufferForIdSync(bufferId);
      if (!state.buffer) return null;
    } catch (error) {
      if (error.syscall === 'read') {
        return; // Error reading the file, don't deserialize an editor for it
      } else {
        throw error;
      }
    }

    state.assert = atomEnvironment.assert.bind(atomEnvironment);

    // Semantics of the readOnly flag have changed since its introduction.
    // Only respect readOnly2, which has been set with the current readOnly semantics.
    delete state.readOnly;
    state.readOnly = state.readOnly2;
    delete state.readOnly2;

    const editor = new TextEditor(state);
    if (state.registered) {
      const disposable = atomEnvironment.textEditors.add(editor);
      editor.onDidDestroy(() => disposable.dispose());
    }
    return editor;
  }

  constructor(params = {}) {
    if (this.constructor.clipboard == null) {
      throw new Error(
        'Must call TextEditor.setClipboard at least once before creating TextEditor instances'
      );
    }

    this.id = params.id != null ? params.id : nextId++;
    if (this.id >= nextId) {
      // Ensure that new editors get unique ids:
      nextId = this.id + 1;
    }
    this.initialScrollTopRow = params.initialScrollTopRow;
    this.initialScrollLeftColumn = params.initialScrollLeftColumn;
    this.decorationManager = params.decorationManager;
    this.selectionsMarkerLayer = params.selectionsMarkerLayer;
    this.mini = params.mini != null ? params.mini : false;
    this.keyboardInputEnabled =
      params.keyboardInputEnabled != null ? params.keyboardInputEnabled : true;
    this.readOnly = params.readOnly != null ? params.readOnly : false;
    this.placeholderText = params.placeholderText;
    this.showLineNumbers = params.showLineNumbers;
    this.assert = params.assert || (condition => condition);
    this.showInvisibles =
      params.showInvisibles != null ? params.showInvisibles : true;
    this.autoHeight = params.autoHeight;
    this.autoWidth = params.autoWidth;
    this.scrollPastEnd =
      params.scrollPastEnd != null ? params.scrollPastEnd : false;
    this.scrollSensitivity =
      params.scrollSensitivity != null ? params.scrollSensitivity : 40;
    this.editorWidthInChars = params.editorWidthInChars;
    this.invisibles = params.invisibles;
    this.showIndentGuide = params.showIndentGuide;
    this.softWrapped = params.softWrapped;
    this.softWrapAtPreferredLineLength = params.softWrapAtPreferredLineLength;
    this.preferredLineLength = params.preferredLineLength;
    this.showCursorOnSelection =
      params.showCursorOnSelection != null
        ? params.showCursorOnSelection
        : true;
    this.maxScreenLineLength = params.maxScreenLineLength;
    this.softTabs = params.softTabs != null ? params.softTabs : true;
    this.autoIndent = params.autoIndent != null ? params.autoIndent : true;
    this.autoIndentOnPaste =
      params.autoIndentOnPaste != null ? params.autoIndentOnPaste : true;
    this.undoGroupingInterval =
      params.undoGroupingInterval != null ? params.undoGroupingInterval : 300;
    this.softWrapped = params.softWrapped != null ? params.softWrapped : false;
    this.softWrapAtPreferredLineLength =
      params.softWrapAtPreferredLineLength != null
        ? params.softWrapAtPreferredLineLength
        : false;
    this.preferredLineLength =
      params.preferredLineLength != null ? params.preferredLineLength : 80;
    this.maxScreenLineLength =
      params.maxScreenLineLength != null ? params.maxScreenLineLength : 500;
    this.showLineNumbers =
      params.showLineNumbers != null ? params.showLineNumbers : true;
    const { tabLength = 2 } = params;

    this.alive = true;
    this.doBackgroundWork = this.doBackgroundWork.bind(this);
    this.serializationVersion = 1;
    this.suppressSelectionMerging = false;
    this.selectionFlashDuration = 500;
    this.gutterContainer = null;
    this.verticalScrollMargin = 2;
    this.horizontalScrollMargin = 6;
    this.lineHeightInPixels = null;
    this.defaultCharWidth = null;
    this.height = null;
    this.width = null;
    this.registered = false;
    this.atomicSoftTabs = true;
    this.emitter = new Emitter();
    this.disposables = new CompositeDisposable();
    this.cursors = [];
    this.cursorsByMarkerId = new Map();
    this.selections = [];
    this.hasTerminatedPendingState = false;

    if (params.buffer) {
      this.buffer = params.buffer;
    } else {
      this.buffer = new TextBuffer({
        shouldDestroyOnFileDelete() {
          return atom.config.get('core.closeDeletedFileTabs');
        }
      });
      this.buffer.setLanguageMode(
        new TextMateLanguageMode({ buffer: this.buffer, config: atom.config })
      );
    }

    const languageMode = this.buffer.getLanguageMode();
    this.languageModeSubscription =
      languageMode.onDidTokenize &&
      languageMode.onDidTokenize(() => {
        this.emitter.emit('did-tokenize');
      });
    if (this.languageModeSubscription)
      this.disposables.add(this.languageModeSubscription);

    if (params.displayLayer) {
      this.displayLayer = params.displayLayer;
    } else {
      const displayLayerParams = {
        invisibles: this.getInvisibles(),
        softWrapColumn: this.getSoftWrapColumn(),
        showIndentGuides: this.doesShowIndentGuide(),
        atomicSoftTabs:
          params.atomicSoftTabs != null ? params.atomicSoftTabs : true,
        tabLength,
        ratioForCharacter: this.ratioForCharacter.bind(this),
        isWrapBoundary,
        foldCharacter: ZERO_WIDTH_NBSP,
        softWrapHangingIndent:
          params.softWrapHangingIndentLength != null
            ? params.softWrapHangingIndentLength
            : 0
      };

      this.displayLayer = this.buffer.getDisplayLayer(params.displayLayerId);
      if (this.displayLayer) {
        this.displayLayer.reset(displayLayerParams);
        this.selectionsMarkerLayer = this.displayLayer.getMarkerLayer(
          params.selectionsMarkerLayerId
        );
      } else {
        this.displayLayer = this.buffer.addDisplayLayer(displayLayerParams);
      }
    }

    this.backgroundWorkHandle = requestIdleCallback(this.doBackgroundWork);
    this.disposables.add(
      new Disposable(() => {
        if (this.backgroundWorkHandle != null)
          return cancelIdleCallback(this.backgroundWorkHandle);
      })
    );

    this.defaultMarkerLayer = this.displayLayer.addMarkerLayer();
    if (!this.selectionsMarkerLayer) {
      this.selectionsMarkerLayer = this.addMarkerLayer({
        maintainHistory: true,
        persistent: true,
        role: 'selections'
      });
    }

    this.decorationManager = new DecorationManager(this);
    this.decorateMarkerLayer(this.selectionsMarkerLayer, { type: 'cursor' });
    if (!this.isMini()) this.decorateCursorLine();

    this.decorateMarkerLayer(this.displayLayer.foldsMarkerLayer, {
      type: 'line-number',
      class: 'folded'
    });

    for (let marker of this.selectionsMarkerLayer.getMarkers()) {
      this.addSelection(marker);
    }

    this.subscribeToBuffer();
    this.subscribeToDisplayLayer();

    if (this.cursors.length === 0 && !params.suppressCursorCreation) {
      const initialLine = Math.max(parseInt(params.initialLine) || 0, 0);
      const initialColumn = Math.max(parseInt(params.initialColumn) || 0, 0);
      this.addCursorAtBufferPosition([initialLine, initialColumn]);
    }

    this.gutterContainer = new GutterContainer(this);
    this.lineNumberGutter = this.gutterContainer.addGutter({
      name: 'line-number',
      type: 'line-number',
      priority: 0,
      visible: params.lineNumberGutterVisible
    });
  }

  get element() {
    return this.getElement();
  }

  get editorElement() {
    Grim.deprecate(dedent`\
      \`TextEditor.prototype.editorElement\` has always been private, but now
      it is gone. Reading the \`editorElement\` property still returns a
      reference to the editor element but this field will be removed in a
      later version of Pulsar, so we recommend using the \`element\` property instead.\
    `);

    return this.getElement();
  }

  get displayBuffer() {
    Grim.deprecate(dedent`\
      \`TextEditor.prototype.displayBuffer\` has always been private, but now
      it is gone. Reading the \`displayBuffer\` property now returns a reference
      to the containing \`TextEditor\`, which now provides *some* of the API of
      the defunct \`DisplayBuffer\` class.\
    `);
    return this;
  }

  get languageMode() {
    return this.buffer.getLanguageMode();
  }

  get tokenizedBuffer() {
    return this.buffer.getLanguageMode();
  }

  get rowsPerPage() {
    return this.getRowsPerPage();
  }

  decorateCursorLine() {
    this.cursorLineDecorations = [
      this.decorateMarkerLayer(this.selectionsMarkerLayer, {
        type: 'line',
        class: 'cursor-line',
        onlyEmpty: true
      }),
      this.decorateMarkerLayer(this.selectionsMarkerLayer, {
        type: 'line-number',
        class: 'cursor-line'
      }),
      this.decorateMarkerLayer(this.selectionsMarkerLayer, {
        type: 'line-number',
        class: 'cursor-line-no-selection',
        onlyHead: true,
        onlyEmpty: true
      })
    ];
  }

  doBackgroundWork(deadline) {
    const previousLongestRow = this.getApproximateLongestScreenRow();
    if (this.displayLayer.doBackgroundWork(deadline)) {
      this.backgroundWorkHandle = requestIdleCallback(this.doBackgroundWork);
    } else {
      this.backgroundWorkHandle = null;
    }

    if (
      this.component &&
      this.getApproximateLongestScreenRow() !== previousLongestRow
    ) {
      this.component.scheduleUpdate();
    }
  }

  update(params) {
    const displayLayerParams = {};

    for (let param of Object.keys(params)) {
      const value = params[param];

      switch (param) {
        case 'autoIndent':
          this.updateAutoIndent(value, false);
          break;

        case 'autoIndentOnPaste':
          this.updateAutoIndentOnPaste(value, false);
          break;

        case 'undoGroupingInterval':
          this.updateUndoGroupingInterval(value, false);
          break;

        case 'scrollSensitivity':
          this.updateScrollSensitivity(value, false);
          break;

        case 'encoding':
          this.updateEncoding(value, false);
          break;

        case 'softTabs':
          this.updateSoftTabs(value, false);
          break;

        case 'atomicSoftTabs':
          this.updateAtomicSoftTabs(value, false, displayLayerParams);
          break;

        case 'tabLength':
          this.updateTabLength(value, false, displayLayerParams);
          break;

        case 'softWrapped':
          this.updateSoftWrapped(value, false, displayLayerParams);
          break;

        case 'softWrapHangingIndentLength':
          this.updateSoftWrapHangingIndentLength(
            value,
            false,
            displayLayerParams
          );
          break;

        case 'softWrapAtPreferredLineLength':
          this.updateSoftWrapAtPreferredLineLength(
            value,
            false,
            displayLayerParams
          );
          break;

        case 'preferredLineLength':
          this.updatePreferredLineLength(value, false, displayLayerParams);
          break;

        case 'maxScreenLineLength':
          this.updateMaxScreenLineLength(value, false, displayLayerParams);
          break;

        case 'mini':
          this.updateMini(value, false, displayLayerParams);
          break;

        case 'readOnly':
          this.updateReadOnly(value, false);
          break;

        case 'keyboardInputEnabled':
          this.updateKeyboardInputEnabled(value, false);
          break;

        case 'placeholderText':
          this.updatePlaceholderText(value, false);
          break;

        case 'lineNumberGutterVisible':
          this.updateLineNumberGutterVisible(value, false);
          break;

        case 'showIndentGuide':
          this.updateShowIndentGuide(value, false, displayLayerParams);
          break;

        case 'showLineNumbers':
          this.updateShowLineNumbers(value, false);
          break;

        case 'showInvisibles':
          this.updateShowInvisibles(value, false, displayLayerParams);
          break;

        case 'invisibles':
          this.updateInvisibles(value, false, displayLayerParams);
          break;

        case 'editorWidthInChars':
          this.updateEditorWidthInChars(value, false, displayLayerParams);
          break;

        case 'width':
          this.updateWidth(value, false, displayLayerParams);
          break;

        case 'scrollPastEnd':
          this.updateScrollPastEnd(value, false);
          break;

        case 'autoHeight':
          this.updateAutoHight(value, false);
          break;

        case 'autoWidth':
          this.updateAutoWidth(value, false);
          break;

        case 'showCursorOnSelection':
          this.updateShowCursorOnSelection(value, false);
          break;

        default:
          if (param !== 'ref' && param !== 'key') {
            throw new TypeError(`Invalid TextEditor parameter: '${param}'`);
          }
      }
    }

    return this.finishUpdate(displayLayerParams);
  }

  finishUpdate(displayLayerParams = {}) {
    this.displayLayer.reset(displayLayerParams);

    if (this.component) {
      return this.component.getNextUpdatePromise();
    } else {
      return Promise.resolve();
    }
  }

  updateAutoIndent(value, finish) {
    this.autoIndent = value;
    if (finish) this.finishUpdate();
  }

  updateAutoIndentOnPaste(value, finish) {
    this.autoIndentOnPaste = value;
    if (finish) this.finishUpdate();
  }

  updateUndoGroupingInterval(value, finish) {
    this.undoGroupingInterval = value;
    if (finish) this.finishUpdate();
  }

  updateScrollSensitivity(value, finish) {
    this.scrollSensitivity = value;
    if (finish) this.finishUpdate();
  }

  updateEncoding(value, finish) {
    this.buffer.setEncoding(value);
    if (finish) this.finishUpdate();
  }

  updateSoftTabs(value, finish) {
    if (value !== this.softTabs) {
      this.softTabs = value;
    }
    if (finish) this.finishUpdate();
  }

  updateAtomicSoftTabs(value, finish, displayLayerParams = {}) {
    if (value !== this.displayLayer.atomicSoftTabs) {
      displayLayerParams.atomicSoftTabs = value;
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateTabLength(value, finish, displayLayerParams = {}) {
    if (value > 0 && value !== this.displayLayer.tabLength) {
      displayLayerParams.tabLength = value;
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateSoftWrapped(value, finish, displayLayerParams = {}) {
    if (value !== this.softWrapped) {
      this.softWrapped = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
      this.emitter.emit('did-change-soft-wrapped', this.isSoftWrapped());
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateSoftWrapHangingIndentLength(value, finish, displayLayerParams = {}) {
    if (value !== this.displayLayer.softWrapHangingIndent) {
      displayLayerParams.softWrapHangingIndent = value;
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateSoftWrapAtPreferredLineLength(value, finish, displayLayerParams = {}) {
    if (value !== this.softWrapAtPreferredLineLength) {
      this.softWrapAtPreferredLineLength = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updatePreferredLineLength(value, finish, displayLayerParams = {}) {
    if (value !== this.preferredLineLength) {
      this.preferredLineLength = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateMaxScreenLineLength(value, finish, displayLayerParams = {}) {
    if (value !== this.maxScreenLineLength) {
      this.maxScreenLineLength = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateMini(value, finish, displayLayerParams = {}) {
    if (value !== this.mini) {
      this.mini = value;
      this.emitter.emit('did-change-mini', value);
      displayLayerParams.invisibles = this.getInvisibles();
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
      displayLayerParams.showIndentGuides = this.doesShowIndentGuide();
      if (this.mini) {
        for (let decoration of this.cursorLineDecorations) {
          decoration.destroy();
        }
        this.cursorLineDecorations = null;
      } else {
        this.decorateCursorLine();
      }
      if (this.component != null) {
        this.component.scheduleUpdate();
      }
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateReadOnly(value, finish) {
    if (value !== this.readOnly) {
      this.readOnly = value;
      if (this.component != null) {
        this.component.scheduleUpdate();
      }
    }
    if (finish) this.finishUpdate();
  }

  updateKeyboardInputEnabled(value, finish) {
    if (value !== this.keyboardInputEnabled) {
      this.keyboardInputEnabled = value;
      if (this.component != null) {
        this.component.scheduleUpdate();
      }
    }
    if (finish) this.finishUpdate();
  }

  updatePlaceholderText(value, finish) {
    if (value !== this.placeholderText) {
      this.placeholderText = value;
      this.emitter.emit('did-change-placeholder-text', value);
    }
    if (finish) this.finishUpdate();
  }

  updateLineNumberGutterVisible(value, finish) {
    if (value !== this.lineNumberGutterVisible) {
      if (value) {
        this.lineNumberGutter.show();
      } else {
        this.lineNumberGutter.hide();
      }
      this.emitter.emit(
        'did-change-line-number-gutter-visible',
        this.lineNumberGutter.isVisible()
      );
    }
    if (finish) this.finishUpdate();
  }

  updateShowIndentGuide(value, finish, displayLayerParams = {}) {
    if (value !== this.showIndentGuide) {
      this.showIndentGuide = value;
      displayLayerParams.showIndentGuides = this.doesShowIndentGuide();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateShowLineNumbers(value, finish) {
    if (value !== this.showLineNumbers) {
      this.showLineNumbers = value;
      if (this.component != null) {
        this.component.scheduleUpdate();
      }
    }
    if (finish) this.finishUpdate();
  }

  updateShowInvisibles(value, finish, displayLayerParams = {}) {
    if (value !== this.showInvisibles) {
      this.showInvisibles = value;
      displayLayerParams.invisibles = this.getInvisibles();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateInvisibles(value, finish, displayLayerParams = {}) {
    if (!_.isEqual(value, this.invisibles)) {
      this.invisibles = value;
      displayLayerParams.invisibles = this.getInvisibles();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateEditorWidthInChars(value, finish, displayLayerParams = {}) {
    if (value > 0 && value !== this.editorWidthInChars) {
      this.editorWidthInChars = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateWidth(value, finish, displayLayerParams = {}) {
    if (value !== this.width) {
      this.width = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateScrollPastEnd(value, finish) {
    if (value !== this.scrollPastEnd) {
      this.scrollPastEnd = value;
      if (this.component) this.component.scheduleUpdate();
    }
    if (finish) this.finishUpdate();
  }

  updateAutoHight(value, finish) {
    if (value !== this.autoHeight) {
      this.autoHeight = value;
    }
    if (finish) this.finishUpdate();
  }

  updateAutoWidth(value, finish) {
    if (value !== this.autoWidth) {
      this.autoWidth = value;
    }
    if (finish) this.finishUpdate();
  }

  updateShowCursorOnSelection(value, finish) {
    if (value !== this.showCursorOnSelection) {
      this.showCursorOnSelection = value;
      if (this.component) this.component.scheduleUpdate();
    }
    if (finish) this.finishUpdate();
  }

  scheduleComponentUpdate() {
    if (this.component) this.component.scheduleUpdate();
  }

  serialize() {
    return {
      deserializer: 'TextEditor',
      version: SERIALIZATION_VERSION,

      displayLayerId: this.displayLayer.id,
      selectionsMarkerLayerId: this.selectionsMarkerLayer.id,

      initialScrollTopRow: this.getScrollTopRow(),
      initialScrollLeftColumn: this.getScrollLeftColumn(),

      tabLength: this.displayLayer.tabLength,
      atomicSoftTabs: this.displayLayer.atomicSoftTabs,
      softWrapHangingIndentLength: this.displayLayer.softWrapHangingIndent,

      id: this.id,
      bufferId: this.buffer.id,
      softTabs: this.softTabs,
      softWrapped: this.softWrapped,
      softWrapAtPreferredLineLength: this.softWrapAtPreferredLineLength,
      preferredLineLength: this.preferredLineLength,
      mini: this.mini,
      readOnly2: this.readOnly, // readOnly encompassed both readOnly and keyboardInputEnabled
      keyboardInputEnabled: this.keyboardInputEnabled,
      editorWidthInChars: this.editorWidthInChars,
      width: this.width,
      maxScreenLineLength: this.maxScreenLineLength,
      registered: this.registered,
      invisibles: this.invisibles,
      showInvisibles: this.showInvisibles,
      showIndentGuide: this.showIndentGuide,
      autoHeight: this.autoHeight,
      autoWidth: this.autoWidth
    };
  }

  subscribeToBuffer() {
    this.buffer.retain();
    this.disposables.add(
      this.buffer.onDidChangeLanguageMode(
        this.handleLanguageModeChange.bind(this)
      )
    );
    this.disposables.add(
      this.buffer.onDidChangePath(() => {
        this.emitter.emit('did-change-title', this.getTitle());
        this.emitter.emit('did-change-path', this.getPath());
      })
    );
    this.disposables.add(
      this.buffer.onDidChangeEncoding(() => {
        this.emitter.emit('did-change-encoding', this.getEncoding());
      })
    );
    this.disposables.add(this.buffer.onDidDestroy(() => this.destroy()));
    this.disposables.add(
      this.buffer.onDidChangeModified(() => {
        if (!this.hasTerminatedPendingState && this.buffer.isModified())
          this.terminatePendingState();
      })
    );
  }

  terminatePendingState() {
    if (!this.hasTerminatedPendingState)
      this.emitter.emit('did-terminate-pending-state');
    this.hasTerminatedPendingState = true;
  }

  onDidTerminatePendingState(callback) {
    return this.emitter.on('did-terminate-pending-state', callback);
  }

  subscribeToDisplayLayer() {
    this.disposables.add(
      this.displayLayer.onDidChange(changes => {
        this.mergeIntersectingSelections();
        if (this.component) this.component.didChangeDisplayLayer(changes);
        this.emitter.emit(
          'did-change',
          changes.map(change => new ChangeEvent(change))
        );
      })
    );
    this.disposables.add(
      this.displayLayer.onDidReset(() => {
        this.mergeIntersectingSelections();
        if (this.component) this.component.didResetDisplayLayer();
        this.emitter.emit('did-change', {});
      })
    );
    this.disposables.add(
      this.selectionsMarkerLayer.onDidCreateMarker(this.addSelection.bind(this))
    );
    return this.disposables.add(
      this.selectionsMarkerLayer.onDidUpdate(() =>
        this.component != null
          ? this.component.didUpdateSelections()
          : undefined
      )
    );
  }

  destroy() {
    if (!this.alive) return;
    this.alive = false;
    this.disposables.dispose();
    this.displayLayer.destroy();
    for (let selection of this.selections.slice()) {
      selection.destroy();
    }
    this.buffer.release();
    this.gutterContainer.destroy();
    this.emitter.emit('did-destroy');
    this.emitter.clear();
    if (this.component) this.component.element.component = null;
    this.component = null;
    this.lineNumberGutter.element = null;
  }

  isAlive() {
    return this.alive;
  }

  isDestroyed() {
    return !this.alive;
  }

  /*
  Section: Event Subscription
  */

  // Essential: Calls your `callback` when the buffer's title has changed.
  //
  // * `callback` {Function}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChangeTitle(callback) {
    return this.emitter.on('did-change-title', callback);
  }

  // Essential: Calls your `callback` when the buffer's path, and therefore title, has changed.
  //
  // * `callback` {Function}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChangePath(callback) {
    return this.emitter.on('did-change-path', callback);
  }

  // Essential: Invoke the given callback synchronously when the content of the
  // buffer changes.
  //
  // Because observers are invoked synchronously, it's important not to perform
  // any expensive operations via this method. Consider {::onDidStopChanging} to
  // delay expensive operations until after changes stop occurring.
  //
  // * `callback` {Function}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChange(callback) {
    return this.emitter.on('did-change', callback);
  }

  // Essential: Invoke `callback` when the buffer's contents change. It is
  // emit asynchronously 300ms after the last buffer change. This is a good place
  // to handle changes to the buffer without compromising typing performance.
  //
  // * `callback` {Function}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidStopChanging(callback) {
    return this.getBuffer().onDidStopChanging(callback);
  }

  // Essential: Calls your `callback` when a {Cursor} is moved. If there are
  // multiple cursors, your callback will be called for each cursor.
  //
  // * `callback` {Function}
  //   * `event` {Object}
  //     * `oldBufferPosition` {Point}
  //     * `oldScreenPosition` {Point}
  //     * `newBufferPosition` {Point}
  //     * `newScreenPosition` {Point}
  //     * `textChanged` {Boolean}
  //     * `cursor` {Cursor} that triggered the event
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChangeCursorPosition(callback) {
    return this.emitter.on('did-change-cursor-position', callback);
  }

  // Essential: Calls your `callback` when a selection's screen range changes.
  //
  // * `callback` {Function}
  //   * `event` {Object}
  //     * `oldBufferRange` {Range}
  //     * `oldScreenRange` {Range}
  //     * `newBufferRange` {Range}
  //     * `newScreenRange` {Range}
  //     * `selection` {Selection} that triggered the event
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChangeSelectionRange(callback) {
    return this.emitter.on('did-change-selection-range', callback);
  }

  // Extended: Calls your `callback` when soft wrap was enabled or disabled.
  //
  // * `callback` {Function}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChangeSoftWrapped(callback) {
    return this.emitter.on('did-change-soft-wrapped', callback);
  }

  // Extended: Calls your `callback` when the buffer's encoding has changed.
  //
  // * `callback` {Function}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChangeEncoding(callback) {
    return this.emitter.on('did-change-encoding', callback);
  }

  // Extended: Calls your `callback` when the grammar that interprets and
  // colorizes the text has been changed. Immediately calls your callback with
  // the current grammar.
  //
  // * `callback` {Function}
  //   * `grammar` {Grammar}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  observeGrammar(callback) {
    callback(this.getGrammar());
    return this.onDidChangeGrammar(callback);
  }

  // Extended: Calls your `callback` when the grammar that interprets and
  // colorizes the text has been changed.
  //
  // * `callback` {Function}
  //   * `grammar` {Grammar}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChangeGrammar(callback) {
    return this.buffer.onDidChangeLanguageMode(() => {
      callback(this.buffer.getLanguageMode().grammar);
    });
  }

  // Extended: Calls your `callback` when the result of {::isModified} changes.
  //
  // * `callback` {Function}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChangeModified(callback) {
    return this.getBuffer().onDidChangeModified(callback);
  }

  // Extended: Calls your `callback` when the buffer's underlying file changes on
  // disk at a moment when the result of {::isModified} is true.
  //
  // * `callback` {Function}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidConflict(callback) {
    return this.getBuffer().onDidConflict(callback);
  }

  // Extended: Calls your `callback` before text has been inserted.
  //
  // * `callback` {Function}
  //   * `event` event {Object}
  //     * `text` {String} text to be inserted
  //     * `cancel` {Function} Call to prevent the text from being inserted
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onWillInsertText(callback) {
    return this.emitter.on('will-insert-text', callback);
  }

  // Extended: Calls your `callback` after text has been inserted.
  //
  // * `callback` {Function}
  //   * `event` event {Object}
  //     * `text` {String} text to be inserted
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidInsertText(callback) {
    return this.emitter.on('did-insert-text', callback);
  }

  // Essential: Invoke the given callback after the buffer is saved to disk.
  //
  // * `callback` {Function} to be called after the buffer is saved.
  //   * `event` {Object} with the following keys:
  //     * `path` The path to which the buffer was saved.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidSave(callback) {
    return this.getBuffer().onDidSave(callback);
  }

  // Essential: Invoke the given callback when the editor is destroyed.
  //
  // * `callback` {Function} to be called when the editor is destroyed.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidDestroy(callback) {
    return this.emitter.once('did-destroy', callback);
  }

  // Extended: Calls your `callback` when a {Cursor} is added to the editor.
  // Immediately calls your callback for each existing cursor.
  //
  // * `callback` {Function}
  //   * `cursor` {Cursor} that was added
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  observeCursors(callback) {
    this.getCursors().forEach(callback);
    return this.onDidAddCursor(callback);
  }

  // Extended: Calls your `callback` when a {Cursor} is added to the editor.
  //
  // * `callback` {Function}
  //   * `cursor` {Cursor} that was added
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidAddCursor(callback) {
    return this.emitter.on('did-add-cursor', callback);
  }

  // Extended: Calls your `callback` when a {Cursor} is removed from the editor.
  //
  // * `callback` {Function}
  //   * `cursor` {Cursor} that was removed
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidRemoveCursor(callback) {
    return this.emitter.on('did-remove-cursor', callback);
  }

  // Extended: Calls your `callback` when a {Selection} is added to the editor.
  // Immediately calls your callback for each existing selection.
  //
  // * `callback` {Function}
  //   * `selection` {Selection} that was added
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  observeSelections(callback) {
    this.getSelections().forEach(callback);
    return this.onDidAddSelection(callback);
  }

  // Extended: Calls your `callback` when a {Selection} is added to the editor.
  //
  // * `callback` {Function}
  //   * `selection` {Selection} that was added
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidAddSelection(callback) {
    return this.emitter.on('did-add-selection', callback);
  }

  // Extended: Calls your `callback` when a {Selection} is removed from the editor.
  //
  // * `callback` {Function}
  //   * `selection` {Selection} that was removed
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidRemoveSelection(callback) {
    return this.emitter.on('did-remove-selection', callback);
  }

  // Extended: Calls your `callback` with each {Decoration} added to the editor.
  // Calls your `callback` immediately for any existing decorations.
  //
  // * `callback` {Function}
  //   * `decoration` {Decoration}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  observeDecorations(callback) {
    return this.decorationManager.observeDecorations(callback);
  }

  // Extended: Calls your `callback` when a {Decoration} is added to the editor.
  //
  // * `callback` {Function}
  //   * `decoration` {Decoration} that was added
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidAddDecoration(callback) {
    return this.decorationManager.onDidAddDecoration(callback);
  }

  // Extended: Calls your `callback` when a {Decoration} is removed from the editor.
  //
  // * `callback` {Function}
  //   * `decoration` {Decoration} that was removed
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidRemoveDecoration(callback) {
    return this.decorationManager.onDidRemoveDecoration(callback);
  }

  // Called by DecorationManager when a decoration is added.
  didAddDecoration(decoration) {
    if (this.component && decoration.isType('block')) {
      this.component.addBlockDecoration(decoration);
    }
  }

  // Extended: Calls your `callback` when the placeholder text is changed.
  //
  // * `callback` {Function}
  //   * `placeholderText` {String} new text
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChangePlaceholderText(callback) {
    return this.emitter.on('did-change-placeholder-text', callback);
  }

  onDidChangeScrollTop(callback) {
    Grim.deprecate(
      'This is now a view method. Call TextEditorElement::onDidChangeScrollTop instead.'
    );
    return this.getElement().onDidChangeScrollTop(callback);
  }

  onDidChangeScrollLeft(callback) {
    Grim.deprecate(
      'This is now a view method. Call TextEditorElement::onDidChangeScrollLeft instead.'
    );
    return this.getElement().onDidChangeScrollLeft(callback);
  }

  onDidRequestAutoscroll(callback) {
    return this.emitter.on('did-request-autoscroll', callback);
  }

  // TODO Remove once the tabs package no longer uses .on subscriptions
  onDidChangeIcon(callback) {
    return this.emitter.on('did-change-icon', callback);
  }

  onDidUpdateDecorations(callback) {
    return this.decorationManager.onDidUpdateDecorations(callback);
  }

  // Retrieves the current buffer's URI.
  getURI() {
    return this.buffer.getUri();
  }

  // Create an {TextEditor} with its initial state based on this object
  copy() {
    const displayLayer = this.displayLayer.copy();
    const selectionsMarkerLayer = displayLayer.getMarkerLayer(
      this.buffer.getMarkerLayer(this.selectionsMarkerLayer.id).copy().id
    );
    const softTabs = this.getSoftTabs();
    return new TextEditor({
      buffer: this.buffer,
      selectionsMarkerLayer,
      softTabs,
      suppressCursorCreation: true,
      tabLength: this.getTabLength(),
      initialScrollTopRow: this.getScrollTopRow(),
      initialScrollLeftColumn: this.getScrollLeftColumn(),
      assert: this.assert,
      displayLayer,
      grammar: this.getGrammar(),
      autoWidth: this.autoWidth,
      autoHeight: this.autoHeight,
      showCursorOnSelection: this.showCursorOnSelection
    });
  }

  // Controls visibility based on the given {Boolean}.
  setVisible(visible) {
    if (visible) {
      const languageMode = this.buffer.getLanguageMode();
      if (languageMode.startTokenizing) languageMode.startTokenizing();
    }
  }

  setMini(mini) {
    this.updateMini(mini, true);
  }

  isMini() {
    return this.mini;
  }

  setReadOnly(readOnly) {
    this.updateReadOnly(readOnly, true);
  }

  isReadOnly() {
    return this.readOnly;
  }

  enableKeyboardInput(enabled) {
    this.updateKeyboardInputEnabled(enabled, true);
  }

  isKeyboardInputEnabled() {
    return this.keyboardInputEnabled;
  }

  onDidChangeMini(callback) {
    return this.emitter.on('did-change-mini', callback);
  }

  setLineNumberGutterVisible(lineNumberGutterVisible) {
    this.updateLineNumberGutterVisible(lineNumberGutterVisible, true);
  }

  isLineNumberGutterVisible() {
    return this.lineNumberGutter.isVisible();
  }

  anyLineNumberGutterVisible() {
    return this.getGutters().some(
      gutter => gutter.type === 'line-number' && gutter.visible
    );
  }

  onDidChangeLineNumberGutterVisible(callback) {
    return this.emitter.on('did-change-line-number-gutter-visible', callback);
  }

  // Essential: Calls your `callback` when a {Gutter} is added to the editor.
  // Immediately calls your callback for each existing gutter.
  //
  // * `callback` {Function}
  //   * `gutter` {Gutter} that currently exists/was added.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  observeGutters(callback) {
    return this.gutterContainer.observeGutters(callback);
  }

  // Essential: Calls your `callback` when a {Gutter} is added to the editor.
  //
  // * `callback` {Function}
  //   * `gutter` {Gutter} that was added.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidAddGutter(callback) {
    return this.gutterContainer.onDidAddGutter(callback);
  }

  // Essential: Calls your `callback` when a {Gutter} is removed from the editor.
  //
  // * `callback` {Function}
  //   * `name` The name of the {Gutter} that was removed.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidRemoveGutter(callback) {
    return this.gutterContainer.onDidRemoveGutter(callback);
  }

  // Set the number of characters that can be displayed horizontally in the
  // editor.
  //
  // * `editorWidthInChars` A {Number} representing the width of the
  // {TextEditorElement} in characters.
  setEditorWidthInChars(editorWidthInChars) {
    this.updateEditorWidthInChars(editorWidthInChars, true);
  }

  // Returns the editor width in characters.
  getEditorWidthInChars() {
    if (this.width != null && this.defaultCharWidth > 0) {
      return Math.max(0, Math.floor(this.width / this.defaultCharWidth));
    } else {
      return this.editorWidthInChars;
    }
  }

  /*
  Section: Buffer
  */

  // Essential: Retrieves the current {TextBuffer}.
  getBuffer() {
    return this.buffer;
  }

  /*
  Section: File Details
  */

  // Essential: Get the editor's title for display in other parts of the
  // UI such as the tabs.
  //
  // If the editor's buffer is saved, its title is the file name. If it is
  // unsaved, its title is "untitled".
  //
  // Returns a {String}.
  getTitle() {
    return this.getFileName() || 'untitled';
  }

  // Essential: Get unique title for display in other parts of the UI, such as
  // the window title.
  //
  // If the editor's buffer is unsaved, its title is "untitled"
  // If the editor's buffer is saved, its unique title is formatted as one
  // of the following,
  // * "<filename>" when it is the only editing buffer with this file name.
  // * "<filename> — <unique-dir-prefix>" when other buffers have this file name.
  //
  // Returns a {String}
  getLongTitle() {
    if (this.getPath()) {
      const fileName = this.getFileName();

      let myPathSegments;
      const openEditorPathSegmentsWithSameFilename = [];
      for (const textEditor of atom.workspace.getTextEditors()) {
        if (textEditor.getFileName() === fileName) {
          const pathSegments = fs
            .tildify(textEditor.getDirectoryPath())
            .split(path.sep);
          openEditorPathSegmentsWithSameFilename.push(pathSegments);
          if (textEditor === this) myPathSegments = pathSegments;
        }
      }

      if (
        !myPathSegments ||
        openEditorPathSegmentsWithSameFilename.length === 1
      )
        return fileName;

      let commonPathSegmentCount;
      for (let i = 0, { length } = myPathSegments; i < length; i++) {
        const myPathSegment = myPathSegments[i];
        if (
          openEditorPathSegmentsWithSameFilename.some(
            segments =>
              segments.length === i + 1 || segments[i] !== myPathSegment
          )
        ) {
          commonPathSegmentCount = i;
          break;
        }
      }

      return `${fileName} \u2014 ${path.join(
        ...myPathSegments.slice(commonPathSegmentCount)
      )}`;
    } else {
      return 'untitled';
    }
  }

  // Essential: Returns the {String} path of this editor's text buffer.
  getPath() {
    return this.buffer.getPath();
  }

  getFileName() {
    const fullPath = this.getPath();
    if (fullPath) return path.basename(fullPath);
  }

  getDirectoryPath() {
    const fullPath = this.getPath();
    if (fullPath) return path.dirname(fullPath);
  }

  // Extended: Returns the {String} character set encoding of this editor's text
  // buffer.
  getEncoding() {
    return this.buffer.getEncoding();
  }

  // Extended: Set the character set encoding to use in this editor's text
  // buffer.
  //
  // * `encoding` The {String} character set encoding name such as 'utf8'
  setEncoding(encoding) {
    this.buffer.setEncoding(encoding);
  }

  // Essential: Returns {Boolean} `true` if this editor has been modified.
  isModified() {
    return this.buffer.isModified();
  }

  // Essential: Returns {Boolean} `true` if this editor has no content.
  isEmpty() {
    return this.buffer.isEmpty();
  }

  /*
  Section: File Operations
  */

  // Essential: Saves the editor's text buffer.
  //
  // See {TextBuffer::save} for more details.
  save() {
    return this.buffer.save();
  }

  // Essential: Saves the editor's text buffer as the given path.
  //
  // See {TextBuffer::saveAs} for more details.
  //
  // * `filePath` A {String} path.
  saveAs(filePath) {
    return this.buffer.saveAs(filePath);
  }

  // Determine whether the user should be prompted to save before closing
  // this editor.
  shouldPromptToSave({ windowCloseRequested, projectHasPaths } = {}) {
    if (
      windowCloseRequested &&
      projectHasPaths &&
      atom.stateStore.isConnected()
    ) {
      return this.buffer.isInConflict();
    } else {
      return this.isModified() && !this.buffer.hasMultipleEditors();
    }
  }

  // Returns an {Object} to configure dialog shown when this editor is saved
  // via {Pane::saveItemAs}.
  getSaveDialogOptions() {
    return {};
  }

  /*
  Section: Reading Text
  */

  // Essential: Returns a {String} representing the entire contents of the editor.
  getText() {
    return this.buffer.getText();
  }

  // Essential: Get the text in the given {Range} in buffer coordinates.
  //
  // * `range` A {Range} or range-compatible {Array}.
  //
  // Returns a {String}.
  getTextInBufferRange(range) {
    return this.buffer.getTextInRange(range);
  }

  // Essential: Returns a {Number} representing the number of lines in the buffer.
  getLineCount() {
    return this.buffer.getLineCount();
  }

  // Essential: Returns a {Number} representing the number of screen lines in the
  // editor. This accounts for folds.
  getScreenLineCount() {
    return this.displayLayer.getScreenLineCount();
  }

  getApproximateScreenLineCount() {
    return this.displayLayer.getApproximateScreenLineCount();
  }

  // Essential: Returns a {Number} representing the last zero-indexed buffer row
  // number of the editor.
  getLastBufferRow() {
    return this.buffer.getLastRow();
  }

  // Essential: Returns a {Number} representing the last zero-indexed screen row
  // number of the editor.
  getLastScreenRow() {
    return this.getScreenLineCount() - 1;
  }

  // Essential: Returns a {String} representing the contents of the line at the
  // given buffer row.
  //
  // * `bufferRow` A {Number} representing a zero-indexed buffer row.
  lineTextForBufferRow(bufferRow) {
    return this.buffer.lineForRow(bufferRow);
  }

  // Essential: Returns a {String} representing the contents of the line at the
  // given screen row.
  //
  // * `screenRow` A {Number} representing a zero-indexed screen row.
  lineTextForScreenRow(screenRow) {
    const screenLine = this.screenLineForScreenRow(screenRow);
    if (screenLine) return screenLine.lineText;
  }

  logScreenLines(start = 0, end = this.getLastScreenRow()) {
    for (let row = start; row <= end; row++) {
      const line = this.lineTextForScreenRow(row);
      console.log(row, this.bufferRowForScreenRow(row), line, line.length);
    }
  }

  tokensForScreenRow(screenRow) {
    const tokens = [];
    let lineTextIndex = 0;
    const currentTokenScopes = [];
    const { lineText, tags } = this.screenLineForScreenRow(screenRow);
    for (const tag of tags) {
      if (this.displayLayer.isOpenTag(tag)) {
        currentTokenScopes.push(this.displayLayer.classNameForTag(tag));
      } else if (this.displayLayer.isCloseTag(tag)) {
        currentTokenScopes.pop();
      } else {
        tokens.push({
          text: lineText.substr(lineTextIndex, tag),
          scopes: currentTokenScopes.slice()
        });
        lineTextIndex += tag;
      }
const _ = require('underscore-plus');
const path = require('path');
const fs = require('fs-plus');
const Grim = require('grim');
const dedent = require('dedent');
const { CompositeDisposable, Disposable, Emitter } = require('event-kit');
const TextBuffer = require('text-buffer');
const { Point, Range } = TextBuffer;
const DecorationManager = require('./decoration-manager');
const Cursor = require('./cursor');
const Selection = require('./selection');
const NullGrammar = require('./null-grammar');
const TextMateLanguageMode = require('./text-mate-language-mode');
const ScopeDescriptor = require('./scope-descriptor');

const TextMateScopeSelector = require('first-mate').ScopeSelector;
const GutterContainer = require('./gutter-container');
let TextEditorComponent = null;
let TextEditorElement = null;
const {
  isDoubleWidthCharacter,
  isHalfWidthCharacter,
  isKoreanCharacter,
  isWrapBoundary
} = require('./text-utils');

const SERIALIZATION_VERSION = 1;
const NON_WHITESPACE_REGEXP = /\S/;
const ZERO_WIDTH_NBSP = '\ufeff';
let nextId = 0;

const DEFAULT_NON_WORD_CHARACTERS = '/\\()"\':,.;<>~!@#$%^&*|+=[]{}`?-…';

// Essential: This class represents all essential editing state for a single
// {TextBuffer}, including cursor and selection positions, folds, and soft wraps.
// If you're manipulating the state of an editor, use this class.
//
// A single {TextBuffer} can belong to multiple editors. For example, if the
// same file is open in two different panes, Pulsar creates a separate editor for
// each pane. If the buffer is manipulated the changes are reflected in both
// editors, but each maintains its own cursor position, folded lines, etc.
//
// ## Accessing TextEditor Instances
//
// The easiest way to get hold of `TextEditor` objects is by registering a callback
// with `::observeTextEditors` on the `atom.workspace` global. Your callback will
// then be called with all current editor instances and also when any editor is
// created in the future.
//
// ```js
// atom.workspace.observeTextEditors(editor => {
//   editor.insertText('Hello World')
// })
// ```
//
// ## Buffer vs. Screen Coordinates
//
// Because editors support folds and soft-wrapping, the lines on screen don't
// always match the lines in the buffer. For example, a long line that soft wraps
// twice renders as three lines on screen, but only represents one line in the
// buffer. Similarly, if rows 5-10 are folded, then row 6 on screen corresponds
// to row 11 in the buffer.
//
// Your choice of coordinates systems will depend on what you're trying to
// achieve. For example, if you're writing a command that jumps the cursor up or
// down by 10 lines, you'll want to use screen coordinates because the user
// probably wants to skip lines *on screen*. However, if you're writing a package
// that jumps between method definitions, you'll want to work in buffer
// coordinates.
//
// **When in doubt, just default to buffer coordinates**, then experiment with
// soft wraps and folds to ensure your code interacts with them correctly.
module.exports = class TextEditor {
  static setClipboard(clipboard) {
    this.clipboard = clipboard;
  }

  static setScheduler(scheduler) {
    if (TextEditorComponent == null) {
      TextEditorComponent = require('./text-editor-component');
    }
    return TextEditorComponent.setScheduler(scheduler);
  }

  static didUpdateStyles() {
    if (TextEditorComponent == null) {
      TextEditorComponent = require('./text-editor-component');
    }
    return TextEditorComponent.didUpdateStyles();
  }

  static didUpdateScrollbarStyles() {
    if (TextEditorComponent == null) {
      TextEditorComponent = require('./text-editor-component');
    }
    return TextEditorComponent.didUpdateScrollbarStyles();
  }

  static viewForItem(item) {
    return item.element || item;
  }

  static deserialize(state, atomEnvironment) {
    if (state.version !== SERIALIZATION_VERSION) return null;

    let bufferId = state.tokenizedBuffer
      ? state.tokenizedBuffer.bufferId
      : state.bufferId;

    try {
      state.buffer = atomEnvironment.project.bufferForIdSync(bufferId);
      if (!state.buffer) return null;
    } catch (error) {
      if (error.syscall === 'read') {
        return; // Error reading the file, don't deserialize an editor for it
      } else {
        throw error;
      }
    }

    state.assert = atomEnvironment.assert.bind(atomEnvironment);

    // Semantics of the readOnly flag have changed since its introduction.
    // Only respect readOnly2, which has been set with the current readOnly semantics.
    delete state.readOnly;
    state.readOnly = state.readOnly2;
    delete state.readOnly2;

    const editor = new TextEditor(state);
    if (state.registered) {
      const disposable = atomEnvironment.textEditors.add(editor);
      editor.onDidDestroy(() => disposable.dispose());
    }
    return editor;
  }

  constructor(params = {}) {
    if (this.constructor.clipboard == null) {
      throw new Error(
        'Must call TextEditor.setClipboard at least once before creating TextEditor instances'
      );
    }

    this.id = params.id != null ? params.id : nextId++;
    if (this.id >= nextId) {
      // Ensure that new editors get unique ids:
      nextId = this.id + 1;
    }
    this.initialScrollTopRow = params.initialScrollTopRow;
    this.initialScrollLeftColumn = params.initialScrollLeftColumn;
    this.decorationManager = params.decorationManager;
    this.selectionsMarkerLayer = params.selectionsMarkerLayer;
    this.mini = params.mini != null ? params.mini : false;
    this.keyboardInputEnabled =
      params.keyboardInputEnabled != null ? params.keyboardInputEnabled : true;
    this.readOnly = params.readOnly != null ? params.readOnly : false;
    this.placeholderText = params.placeholderText;
    this.showLineNumbers = params.showLineNumbers;
    this.assert = params.assert || (condition => condition);
    this.showInvisibles =
      params.showInvisibles != null ? params.showInvisibles : true;
    this.autoHeight = params.autoHeight;
    this.autoWidth = params.autoWidth;
    this.scrollPastEnd =
      params.scrollPastEnd != null ? params.scrollPastEnd : false;
    this.scrollSensitivity =
      params.scrollSensitivity != null ? params.scrollSensitivity : 40;
    this.editorWidthInChars = params.editorWidthInChars;
    this.invisibles = params.invisibles;
    this.showIndentGuide = params.showIndentGuide;
    this.softWrapped = params.softWrapped;
    this.softWrapAtPreferredLineLength = params.softWrapAtPreferredLineLength;
    this.preferredLineLength = params.preferredLineLength;
    this.showCursorOnSelection =
      params.showCursorOnSelection != null
        ? params.showCursorOnSelection
        : true;
    this.maxScreenLineLength = params.maxScreenLineLength;
    this.softTabs = params.softTabs != null ? params.softTabs : true;
    this.autoIndent = params.autoIndent != null ? params.autoIndent : true;
    this.autoIndentOnPaste =
      params.autoIndentOnPaste != null ? params.autoIndentOnPaste : true;
    this.undoGroupingInterval =
      params.undoGroupingInterval != null ? params.undoGroupingInterval : 300;
    this.softWrapped = params.softWrapped != null ? params.softWrapped : false;
    this.softWrapAtPreferredLineLength =
      params.softWrapAtPreferredLineLength != null
        ? params.softWrapAtPreferredLineLength
        : false;
    this.preferredLineLength =
      params.preferredLineLength != null ? params.preferredLineLength : 80;
    this.maxScreenLineLength =
      params.maxScreenLineLength != null ? params.maxScreenLineLength : 500;
    this.showLineNumbers =
      params.showLineNumbers != null ? params.showLineNumbers : true;
    const { tabLength = 2 } = params;

    this.alive = true;
    this.doBackgroundWork = this.doBackgroundWork.bind(this);
    this.serializationVersion = 1;
    this.suppressSelectionMerging = false;
    this.selectionFlashDuration = 500;
    this.gutterContainer = null;
    this.verticalScrollMargin = 2;
    this.horizontalScrollMargin = 6;
    this.lineHeightInPixels = null;
    this.defaultCharWidth = null;
    this.height = null;
    this.width = null;
    this.registered = false;
    this.atomicSoftTabs = true;
    this.emitter = new Emitter();
    this.disposables = new CompositeDisposable();
    this.cursors = [];
    this.cursorsByMarkerId = new Map();
    this.selections = [];
    this.hasTerminatedPendingState = false;

    if (params.buffer) {
      this.buffer = params.buffer;
    } else {
      this.buffer = new TextBuffer({
        shouldDestroyOnFileDelete() {
          return atom.config.get('core.closeDeletedFileTabs');
        }
      });
      this.buffer.setLanguageMode(
        new TextMateLanguageMode({ buffer: this.buffer, config: atom.config })
      );
    }

    const languageMode = this.buffer.getLanguageMode();
    this.languageModeSubscription =
      languageMode.onDidTokenize &&
      languageMode.onDidTokenize(() => {
        this.emitter.emit('did-tokenize');
      });
    if (this.languageModeSubscription)
      this.disposables.add(this.languageModeSubscription);

    if (params.displayLayer) {
      this.displayLayer = params.displayLayer;
    } else {
      const displayLayerParams = {
        invisibles: this.getInvisibles(),
        softWrapColumn: this.getSoftWrapColumn(),
        showIndentGuides: this.doesShowIndentGuide(),
        atomicSoftTabs:
          params.atomicSoftTabs != null ? params.atomicSoftTabs : true,
        tabLength,
        ratioForCharacter: this.ratioForCharacter.bind(this),
        isWrapBoundary,
        foldCharacter: ZERO_WIDTH_NBSP,
        softWrapHangingIndent:
          params.softWrapHangingIndentLength != null
            ? params.softWrapHangingIndentLength
            : 0
      };

      this.displayLayer = this.buffer.getDisplayLayer(params.displayLayerId);
      if (this.displayLayer) {
        this.displayLayer.reset(displayLayerParams);
        this.selectionsMarkerLayer = this.displayLayer.getMarkerLayer(
          params.selectionsMarkerLayerId
        );
      } else {
        this.displayLayer = this.buffer.addDisplayLayer(displayLayerParams);
      }
    }

    this.backgroundWorkHandle = requestIdleCallback(this.doBackgroundWork);
    this.disposables.add(
      new Disposable(() => {
        if (this.backgroundWorkHandle != null)
          return cancelIdleCallback(this.backgroundWorkHandle);
      })
    );

    this.defaultMarkerLayer = this.displayLayer.addMarkerLayer();
    if (!this.selectionsMarkerLayer) {
      this.selectionsMarkerLayer = this.addMarkerLayer({
        maintainHistory: true,
        persistent: true,
        role: 'selections'
      });
    }

    this.decorationManager = new DecorationManager(this);
    this.decorateMarkerLayer(this.selectionsMarkerLayer, { type: 'cursor' });
    if (!this.isMini()) this.decorateCursorLine();

    this.decorateMarkerLayer(this.displayLayer.foldsMarkerLayer, {
      type: 'line-number',
      class: 'folded'
    });

    for (let marker of this.selectionsMarkerLayer.getMarkers()) {
      this.addSelection(marker);
    }

    this.subscribeToBuffer();
    this.subscribeToDisplayLayer();

    if (this.cursors.length === 0 && !params.suppressCursorCreation) {
      const initialLine = Math.max(parseInt(params.initialLine) || 0, 0);
      const initialColumn = Math.max(parseInt(params.initialColumn) || 0, 0);
      this.addCursorAtBufferPosition([initialLine, initialColumn]);
    }

    this.gutterContainer = new GutterContainer(this);
    this.lineNumberGutter = this.gutterContainer.addGutter({
      name: 'line-number',
      type: 'line-number',
      priority: 0,
      visible: params.lineNumberGutterVisible
    });
  }

  get element() {
    return this.getElement();
  }

  get editorElement() {
    Grim.deprecate(dedent`\
      \`TextEditor.prototype.editorElement\` has always been private, but now
      it is gone. Reading the \`editorElement\` property still returns a
      reference to the editor element but this field will be removed in a
      later version of Pulsar, so we recommend using the \`element\` property instead.\
    `);

    return this.getElement();
  }

  get displayBuffer() {
    Grim.deprecate(dedent`\
      \`TextEditor.prototype.displayBuffer\` has always been private, but now
      it is gone. Reading the \`displayBuffer\` property now returns a reference
      to the containing \`TextEditor\`, which now provides *some* of the API of
      the defunct \`DisplayBuffer\` class.\
    `);
    return this;
  }

  get languageMode() {
    return this.buffer.getLanguageMode();
  }

  get tokenizedBuffer() {
    return this.buffer.getLanguageMode();
  }

  get rowsPerPage() {
    return this.getRowsPerPage();
  }

  decorateCursorLine() {
    this.cursorLineDecorations = [
      this.decorateMarkerLayer(this.selectionsMarkerLayer, {
        type: 'line',
        class: 'cursor-line',
        onlyEmpty: true
      }),
      this.decorateMarkerLayer(this.selectionsMarkerLayer, {
        type: 'line-number',
        class: 'cursor-line'
      }),
      this.decorateMarkerLayer(this.selectionsMarkerLayer, {
        type: 'line-number',
        class: 'cursor-line-no-selection',
        onlyHead: true,
        onlyEmpty: true
      })
    ];
  }

  doBackgroundWork(deadline) {
    const previousLongestRow = this.getApproximateLongestScreenRow();
    if (this.displayLayer.doBackgroundWork(deadline)) {
      this.backgroundWorkHandle = requestIdleCallback(this.doBackgroundWork);
    } else {
      this.backgroundWorkHandle = null;
    }

    if (
      this.component &&
      this.getApproximateLongestScreenRow() !== previousLongestRow
    ) {
      this.component.scheduleUpdate();
    }
  }

  update(params) {
    const displayLayerParams = {};

    for (let param of Object.keys(params)) {
      const value = params[param];

      switch (param) {
        case 'autoIndent':
          this.updateAutoIndent(value, false);
          break;

        case 'autoIndentOnPaste':
          this.updateAutoIndentOnPaste(value, false);
          break;

        case 'undoGroupingInterval':
          this.updateUndoGroupingInterval(value, false);
          break;

        case 'scrollSensitivity':
          this.updateScrollSensitivity(value, false);
          break;

        case 'encoding':
          this.updateEncoding(value, false);
          break;

        case 'softTabs':
          this.updateSoftTabs(value, false);
          break;

        case 'atomicSoftTabs':
          this.updateAtomicSoftTabs(value, false, displayLayerParams);
          break;

        case 'tabLength':
          this.updateTabLength(value, false, displayLayerParams);
          break;

        case 'softWrapped':
          this.updateSoftWrapped(value, false, displayLayerParams);
          break;

        case 'softWrapHangingIndentLength':
          this.updateSoftWrapHangingIndentLength(
            value,
            false,
            displayLayerParams
          );
          break;

        case 'softWrapAtPreferredLineLength':
          this.updateSoftWrapAtPreferredLineLength(
            value,
            false,
            displayLayerParams
          );
          break;

        case 'preferredLineLength':
          this.updatePreferredLineLength(value, false, displayLayerParams);
          break;

        case 'maxScreenLineLength':
          this.updateMaxScreenLineLength(value, false, displayLayerParams);
          break;

        case 'mini':
          this.updateMini(value, false, displayLayerParams);
          break;

        case 'readOnly':
          this.updateReadOnly(value, false);
          break;

        case 'keyboardInputEnabled':
          this.updateKeyboardInputEnabled(value, false);
          break;

        case 'placeholderText':
          this.updatePlaceholderText(value, false);
          break;

        case 'lineNumberGutterVisible':
          this.updateLineNumberGutterVisible(value, false);
          break;

        case 'showIndentGuide':
          this.updateShowIndentGuide(value, false, displayLayerParams);
          break;

        case 'showLineNumbers':
          this.updateShowLineNumbers(value, false);
          break;

        case 'showInvisibles':
          this.updateShowInvisibles(value, false, displayLayerParams);
          break;

        case 'invisibles':
          this.updateInvisibles(value, false, displayLayerParams);
          break;

        case 'editorWidthInChars':
          this.updateEditorWidthInChars(value, false, displayLayerParams);
          break;

        case 'width':
          this.updateWidth(value, false, displayLayerParams);
          break;

        case 'scrollPastEnd':
          this.updateScrollPastEnd(value, false);
          break;

        case 'autoHeight':
          this.updateAutoHight(value, false);
          break;

        case 'autoWidth':
          this.updateAutoWidth(value, false);
          break;

        case 'showCursorOnSelection':
          this.updateShowCursorOnSelection(value, false);
          break;

        default:
          if (param !== 'ref' && param !== 'key') {
            throw new TypeError(`Invalid TextEditor parameter: '${param}'`);
          }
      }
    }

    return this.finishUpdate(displayLayerParams);
  }

  finishUpdate(displayLayerParams = {}) {
    this.displayLayer.reset(displayLayerParams);

    if (this.component) {
      return this.component.getNextUpdatePromise();
    } else {
      return Promise.resolve();
    }
  }

  updateAutoIndent(value, finish) {
    this.autoIndent = value;
    if (finish) this.finishUpdate();
  }

  updateAutoIndentOnPaste(value, finish) {
    this.autoIndentOnPaste = value;
    if (finish) this.finishUpdate();
  }

  updateUndoGroupingInterval(value, finish) {
    this.undoGroupingInterval = value;
    if (finish) this.finishUpdate();
  }

  updateScrollSensitivity(value, finish) {
    this.scrollSensitivity = value;
    if (finish) this.finishUpdate();
  }

  updateEncoding(value, finish) {
    this.buffer.setEncoding(value);
    if (finish) this.finishUpdate();
  }

  updateSoftTabs(value, finish) {
    if (value !== this.softTabs) {
      this.softTabs = value;
    }
    if (finish) this.finishUpdate();
  }

  updateAtomicSoftTabs(value, finish, displayLayerParams = {}) {
    if (value !== this.displayLayer.atomicSoftTabs) {
      displayLayerParams.atomicSoftTabs = value;
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateTabLength(value, finish, displayLayerParams = {}) {
    if (value > 0 && value !== this.displayLayer.tabLength) {
      displayLayerParams.tabLength = value;
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateSoftWrapped(value, finish, displayLayerParams = {}) {
    if (value !== this.softWrapped) {
      this.softWrapped = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
      this.emitter.emit('did-change-soft-wrapped', this.isSoftWrapped());
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateSoftWrapHangingIndentLength(value, finish, displayLayerParams = {}) {
    if (value !== this.displayLayer.softWrapHangingIndent) {
      displayLayerParams.softWrapHangingIndent = value;
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateSoftWrapAtPreferredLineLength(value, finish, displayLayerParams = {}) {
    if (value !== this.softWrapAtPreferredLineLength) {
      this.softWrapAtPreferredLineLength = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updatePreferredLineLength(value, finish, displayLayerParams = {}) {
    if (value !== this.preferredLineLength) {
      this.preferredLineLength = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateMaxScreenLineLength(value, finish, displayLayerParams = {}) {
    if (value !== this.maxScreenLineLength) {
      this.maxScreenLineLength = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateMini(value, finish, displayLayerParams = {}) {
    if (value !== this.mini) {
      this.mini = value;
      this.emitter.emit('did-change-mini', value);
      displayLayerParams.invisibles = this.getInvisibles();
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
      displayLayerParams.showIndentGuides = this.doesShowIndentGuide();
      if (this.mini) {
        for (let decoration of this.cursorLineDecorations) {
          decoration.destroy();
        }
        this.cursorLineDecorations = null;
      } else {
        this.decorateCursorLine();
      }
      if (this.component != null) {
        this.component.scheduleUpdate();
      }
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateReadOnly(value, finish) {
    if (value !== this.readOnly) {
      this.readOnly = value;
      if (this.component != null) {
        this.component.scheduleUpdate();
      }
    }
    if (finish) this.finishUpdate();
  }

  updateKeyboardInputEnabled(value, finish) {
    if (value !== this.keyboardInputEnabled) {
      this.keyboardInputEnabled = value;
      if (this.component != null) {
        this.component.scheduleUpdate();
      }
    }
    if (finish) this.finishUpdate();
  }

  updatePlaceholderText(value, finish) {
    if (value !== this.placeholderText) {
      this.placeholderText = value;
      this.emitter.emit('did-change-placeholder-text', value);
    }
    if (finish) this.finishUpdate();
  }

  updateLineNumberGutterVisible(value, finish) {
    if (value !== this.lineNumberGutterVisible) {
      if (value) {
        this.lineNumberGutter.show();
      } else {
        this.lineNumberGutter.hide();
      }
      this.emitter.emit(
        'did-change-line-number-gutter-visible',
        this.lineNumberGutter.isVisible()
      );
    }
    if (finish) this.finishUpdate();
  }

  updateShowIndentGuide(value, finish, displayLayerParams = {}) {
    if (value !== this.showIndentGuide) {
      this.showIndentGuide = value;
      displayLayerParams.showIndentGuides = this.doesShowIndentGuide();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateShowLineNumbers(value, finish) {
    if (value !== this.showLineNumbers) {
      this.showLineNumbers = value;
      if (this.component != null) {
        this.component.scheduleUpdate();
      }
    }
    if (finish) this.finishUpdate();
  }

  updateShowInvisibles(value, finish, displayLayerParams = {}) {
    if (value !== this.showInvisibles) {
      this.showInvisibles = value;
      displayLayerParams.invisibles = this.getInvisibles();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateInvisibles(value, finish, displayLayerParams = {}) {
    if (!_.isEqual(value, this.invisibles)) {
      this.invisibles = value;
      displayLayerParams.invisibles = this.getInvisibles();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateEditorWidthInChars(value, finish, displayLayerParams = {}) {
    if (value > 0 && value !== this.editorWidthInChars) {
      this.editorWidthInChars = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateWidth(value, finish, displayLayerParams = {}) {
    if (value !== this.width) {
      this.width = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateScrollPastEnd(value, finish) {
    if (value !== this.scrollPastEnd) {
      this.scrollPastEnd = value;
      if (this.component) this.component.scheduleUpdate();
    }
    if (finish) this.finishUpdate();
  }

  updateAutoHight(value, finish) {
    if (value !== this.autoHeight) {
      this.autoHeight = value;
    }
    if (finish) this.finishUpdate();
  }

  updateAutoWidth(value, finish) {
    if (value !== this.autoWidth) {
      this.autoWidth = value;
    }
    if (finish) this.finishUpdate();
  }

  updateShowCursorOnSelection(value, finish) {
    if (value !== this.showCursorOnSelection) {
      this.showCursorOnSelection = value;
      if (this.component) this.component.scheduleUpdate();
    }
    if (finish) this.finishUpdate();
  }

  scheduleComponentUpdate() {
    if (this.component) this.component.scheduleUpdate();
  }

  serialize() {
    return {
      deserializer: 'TextEditor',
      version: SERIALIZATION_VERSION,

      displayLayerId: this.displayLayer.id,
      selectionsMarkerLayerId: this.selectionsMarkerLayer.id,

      initialScrollTopRow: this.getScrollTopRow(),
      initialScrollLeftColumn: this.getScrollLeftColumn(),

      tabLength: this.displayLayer.tabLength,
      atomicSoftTabs: this.displayLayer.atomicSoftTabs,
      softWrapHangingIndentLength: this.displayLayer.softWrapHangingIndent,

      id: this.id,
      bufferId: this.buffer.id,
      softTabs: this.softTabs,
      softWrapped: this.softWrapped,
      softWrapAtPreferredLineLength: this.softWrapAtPreferredLineLength,
      preferredLineLength: this.preferredLineLength,
      mini: this.mini,
      readOnly2: this.readOnly, // readOnly encompassed both readOnly and keyboardInputEnabled
      keyboardInputEnabled: this.keyboardInputEnabled,
      editorWidthInChars: this.editorWidthInChars,
      width: this.width,
      maxScreenLineLength: this.maxScreenLineLength,
      registered: this.registered,
      invisibles: this.invisibles,
      showInvisibles: this.showInvisibles,
      showIndentGuide: this.showIndentGuide,
      autoHeight: this.autoHeight,
      autoWidth: this.autoWidth
    };
  }

  subscribeToBuffer() {
    this.buffer.retain();
    this.disposables.add(
      this.buffer.onDidChangeLanguageMode(
        this.handleLanguageModeChange.bind(this)
      )
    );
    this.disposables.add(
      this.buffer.onDidChangePath(() => {
        this.emitter.emit('did-change-title', this.getTitle());
        this.emitter.emit('did-change-path', this.getPath());
      })
    );
    this.disposables.add(
      this.buffer.onDidChangeEncoding(() => {
        this.emitter.emit('did-change-encoding', this.getEncoding());
      })
    );
    this.disposables.add(this.buffer.onDidDestroy(() => this.destroy()));
    this.disposables.add(
      this.buffer.onDidChangeModified(() => {
        if (!this.hasTerminatedPendingState && this.buffer.isModified())
          this.terminatePendingState();
      })
    );
  }

  terminatePendingState() {
    if (!this.hasTerminatedPendingState)
      this.emitter.emit('did-terminate-pending-state');
    this.hasTerminatedPendingState = true;
  }

  onDidTerminatePendingState(callback) {
    return this.emitter.on('did-terminate-pending-state', callback);
  }

  subscribeToDisplayLayer() {
    this.disposables.add(
      this.displayLayer.onDidChange(changes => {
        this.mergeIntersectingSelections();
        if (this.component) this.component.didChangeDisplayLayer(changes);
        this.emitter.emit(
          'did-change',
          changes.map(change => new ChangeEvent(change))
        );
      })
    );
    this.disposables.add(
      this.displayLayer.onDidReset(() => {
        this.mergeIntersectingSelections();
        if (this.component) this.component.didResetDisplayLayer();
        this.emitter.emit('did-change', {});
      })
    );
    this.disposables.add(
      this.selectionsMarkerLayer.onDidCreateMarker(this.addSelection.bind(this))
    );
    return this.disposables.add(
      this.selectionsMarkerLayer.onDidUpdate(() =>
        this.component != null
          ? this.component.didUpdateSelections()
          : undefined
      )
    );
  }

  destroy() {
    if (!this.alive) return;
    this.alive = false;
    this.disposables.dispose();
    this.displayLayer.destroy();
    for (let selection of this.selections.slice()) {
      selection.destroy();
    }
    this.buffer.release();
    this.gutterContainer.destroy();
    this.emitter.emit('did-destroy');
    this.emitter.clear();
    if (this.component) this.component.element.component = null;
    this.component = null;
    this.lineNumberGutter.element = null;
  }

  isAlive() {
    return this.alive;
  }

  isDestroyed() {
    return !this.alive;
  }

  /*
  Section: Event Subscription
  */

  // Essential: Calls your `callback` when the buffer's title has changed.
  //
  // * `callback` {Function}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChangeTitle(callback) {
    return this.emitter.on('did-change-title', callback);
  }

  // Essential: Calls your `callback` when the buffer's path, and therefore title, has changed.
  //
  // * `callback` {Function}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChangePath(callback) {
    return this.emitter.on('did-change-path', callback);
  }

  // Essential: Invoke the given callback synchronously when the content of the
  // buffer changes.
  //
  // Because observers are invoked synchronously, it's important not to perform
  // any expensive operations via this method. Consider {::onDidStopChanging} to
  // delay expensive operations until after changes stop occurring.
  //
  // * `callback` {Function}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChange(callback) {
    return this.emitter.on('did-change', callback);
  }

  // Essential: Invoke `callback` when the buffer's contents change. It is
  // emit asynchronously 300ms after the last buffer change. This is a good place
  // to handle changes to the buffer without compromising typing performance.
  //
  // * `callback` {Function}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidStopChanging(callback) {
    return this.getBuffer().onDidStopChanging(callback);
  }

  // Essential: Calls your `callback` when a {Cursor} is moved. If there are
  // multiple cursors, your callback will be called for each cursor.
  //
  // * `callback` {Function}
  //   * `event` {Object}
  //     * `oldBufferPosition` {Point}
  //     * `oldScreenPosition` {Point}
  //     * `newBufferPosition` {Point}
  //     * `newScreenPosition` {Point}
  //     * `textChanged` {Boolean}
  //     * `cursor` {Cursor} that triggered the event
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChangeCursorPosition(callback) {
    return this.emitter.on('did-change-cursor-position', callback);
  }

  // Essential: Calls your `callback` when a selection's screen range changes.
  //
  // * `callback` {Function}
  //   * `event` {Object}
  //     * `oldBufferRange` {Range}
  //     * `oldScreenRange` {Range}
  //     * `newBufferRange` {Range}
  //     * `newScreenRange` {Range}
  //     * `selection` {Selection} that triggered the event
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChangeSelectionRange(callback) {
    return this.emitter.on('did-change-selection-range', callback);
  }

  // Extended: Calls your `callback` when soft wrap was enabled or disabled.
  //
  // * `callback` {Function}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChangeSoftWrapped(callback) {
    return this.emitter.on('did-change-soft-wrapped', callback);
  }

  // Extended: Calls your `callback` when the buffer's encoding has changed.
  //
  // * `callback` {Function}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChangeEncoding(callback) {
    return this.emitter.on('did-change-encoding', callback);
  }

  // Extended: Calls your `callback` when the grammar that interprets and
  // colorizes the text has been changed. Immediately calls your callback with
  // the current grammar.
  //
  // * `callback` {Function}
  //   * `grammar` {Grammar}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  observeGrammar(callback) {
    callback(this.getGrammar());
    return this.onDidChangeGrammar(callback);
  }

  // Extended: Calls your `callback` when the grammar that interprets and
  // colorizes the text has been changed.
  //
  // * `callback` {Function}
  //   * `grammar` {Grammar}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChangeGrammar(callback) {
    return this.buffer.onDidChangeLanguageMode(() => {
      callback(this.buffer.getLanguageMode().grammar);
    });
  }

  // Extended: Calls your `callback` when the result of {::isModified} changes.
  //
  // * `callback` {Function}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChangeModified(callback) {
    return this.getBuffer().onDidChangeModified(callback);
  }

  // Extended: Calls your `callback` when the buffer's underlying file changes on
  // disk at a moment when the result of {::isModified} is true.
  //
  // * `callback` {Function}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidConflict(callback) {
    return this.getBuffer().onDidConflict(callback);
  }

  // Extended: Calls your `callback` before text has been inserted.
  //
  // * `callback` {Function}
  //   * `event` event {Object}
  //     * `text` {String} text to be inserted
  //     * `cancel` {Function} Call to prevent the text from being inserted
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onWillInsertText(callback) {
    return this.emitter.on('will-insert-text', callback);
  }

  // Extended: Calls your `callback` after text has been inserted.
  //
  // * `callback` {Function}
  //   * `event` event {Object}
  //     * `text` {String} text to be inserted
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidInsertText(callback) {
    return this.emitter.on('did-insert-text', callback);
  }

  // Essential: Invoke the given callback after the buffer is saved to disk.
  //
  // * `callback` {Function} to be called after the buffer is saved.
  //   * `event` {Object} with the following keys:
  //     * `path` The path to which the buffer was saved.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidSave(callback) {
    return this.getBuffer().onDidSave(callback);
  }

  // Essential: Invoke the given callback when the editor is destroyed.
  //
  // * `callback` {Function} to be called when the editor is destroyed.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidDestroy(callback) {
    return this.emitter.once('did-destroy', callback);
  }

  // Extended: Calls your `callback` when a {Cursor} is added to the editor.
  // Immediately calls your callback for each existing cursor.
  //
  // * `callback` {Function}
  //   * `cursor` {Cursor} that was added
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  observeCursors(callback) {
    this.getCursors().forEach(callback);
    return this.onDidAddCursor(callback);
  }

  // Extended: Calls your `callback` when a {Cursor} is added to the editor.
  //
  // * `callback` {Function}
  //   * `cursor` {Cursor} that was added
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidAddCursor(callback) {
    return this.emitter.on('did-add-cursor', callback);
  }

  // Extended: Calls your `callback` when a {Cursor} is removed from the editor.
  //
  // * `callback` {Function}
  //   * `cursor` {Cursor} that was removed
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidRemoveCursor(callback) {
    return this.emitter.on('did-remove-cursor', callback);
  }

  // Extended: Calls your `callback` when a {Selection} is added to the editor.
  // Immediately calls your callback for each existing selection.
  //
  // * `callback` {Function}
  //   * `selection` {Selection} that was added
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  observeSelections(callback) {
    this.getSelections().forEach(callback);
    return this.onDidAddSelection(callback);
  }

  // Extended: Calls your `callback` when a {Selection} is added to the editor.
  //
  // * `callback` {Function}
  //   * `selection` {Selection} that was added
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidAddSelection(callback) {
    return this.emitter.on('did-add-selection', callback);
  }

  // Extended: Calls your `callback` when a {Selection} is removed from the editor.
  //
  // * `callback` {Function}
  //   * `selection` {Selection} that was removed
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidRemoveSelection(callback) {
    return this.emitter.on('did-remove-selection', callback);
  }

  // Extended: Calls your `callback` with each {Decoration} added to the editor.
  // Calls your `callback` immediately for any existing decorations.
  //
  // * `callback` {Function}
  //   * `decoration` {Decoration}
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  observeDecorations(callback) {
    return this.decorationManager.observeDecorations(callback);
  }

  // Extended: Calls your `callback` when a {Decoration} is added to the editor.
  //
  // * `callback` {Function}
  //   * `decoration` {Decoration} that was added
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidAddDecoration(callback) {
    return this.decorationManager.onDidAddDecoration(callback);
  }

  // Extended: Calls your `callback` when a {Decoration} is removed from the editor.
  //
  // * `callback` {Function}
  //   * `decoration` {Decoration} that was removed
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidRemoveDecoration(callback) {
    return this.decorationManager.onDidRemoveDecoration(callback);
  }

  // Called by DecorationManager when a decoration is added.
  didAddDecoration(decoration) {
    if (this.component && decoration.isType('block')) {
      this.component.addBlockDecoration(decoration);
    }
  }

  // Extended: Calls your `callback` when the placeholder text is changed.
  //
  // * `callback` {Function}
  //   * `placeholderText` {String} new text
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidChangePlaceholderText(callback) {
    return this.emitter.on('did-change-placeholder-text', callback);
  }

  onDidChangeScrollTop(callback) {
    Grim.deprecate(
      'This is now a view method. Call TextEditorElement::onDidChangeScrollTop instead.'
    );
    return this.getElement().onDidChangeScrollTop(callback);
  }

  onDidChangeScrollLeft(callback) {
    Grim.deprecate(
      'This is now a view method. Call TextEditorElement::onDidChangeScrollLeft instead.'
    );
    return this.getElement().onDidChangeScrollLeft(callback);
  }

  onDidRequestAutoscroll(callback) {
    return this.emitter.on('did-request-autoscroll', callback);
  }

  // TODO Remove once the tabs package no longer uses .on subscriptions
  onDidChangeIcon(callback) {
    return this.emitter.on('did-change-icon', callback);
  }

  onDidUpdateDecorations(callback) {
    return this.decorationManager.onDidUpdateDecorations(callback);
  }

  // Retrieves the current buffer's URI.
  getURI() {
    return this.buffer.getUri();
  }

  // Create an {TextEditor} with its initial state based on this object
  copy() {
    const displayLayer = this.displayLayer.copy();
    const selectionsMarkerLayer = displayLayer.getMarkerLayer(
      this.buffer.getMarkerLayer(this.selectionsMarkerLayer.id).copy().id
    );
    const softTabs = this.getSoftTabs();
    return new TextEditor({
      buffer: this.buffer,
      selectionsMarkerLayer,
      softTabs,
      suppressCursorCreation: true,
      tabLength: this.getTabLength(),
      initialScrollTopRow: this.getScrollTopRow(),
      initialScrollLeftColumn: this.getScrollLeftColumn(),
      assert: this.assert,
      displayLayer,
      grammar: this.getGrammar(),
      autoWidth: this.autoWidth,
      autoHeight: this.autoHeight,
      showCursorOnSelection: this.showCursorOnSelection
    });
  }

  // Controls visibility based on the given {Boolean}.
  setVisible(visible) {
    if (visible) {
      const languageMode = this.buffer.getLanguageMode();
      if (languageMode.startTokenizing) languageMode.startTokenizing();
    }
  }

  setMini(mini) {
    this.updateMini(mini, true);
  }

  isMini() {
    return this.mini;
  }

  setReadOnly(readOnly) {
    this.updateReadOnly(readOnly, true);
  }

  isReadOnly() {
    return this.readOnly;
  }

  enableKeyboardInput(enabled) {
    this.updateKeyboardInputEnabled(enabled, true);
  }

  isKeyboardInputEnabled() {
    return this.keyboardInputEnabled;
  }

  onDidChangeMini(callback) {
    return this.emitter.on('did-change-mini', callback);
  }

  setLineNumberGutterVisible(lineNumberGutterVisible) {
    this.updateLineNumberGutterVisible(lineNumberGutterVisible, true);
  }

  isLineNumberGutterVisible() {
    return this.lineNumberGutter.isVisible();
  }

  anyLineNumberGutterVisible() {
    return this.getGutters().some(
      gutter => gutter.type === 'line-number' && gutter.visible
    );
  }

  onDidChangeLineNumberGutterVisible(callback) {
    return this.emitter.on('did-change-line-number-gutter-visible', callback);
  }

  // Essential: Calls your `callback` when a {Gutter} is added to the editor.
  // Immediately calls your callback for each existing gutter.
  //
  // * `callback` {Function}
  //   * `gutter` {Gutter} that currently exists/was added.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  observeGutters(callback) {
    return this.gutterContainer.observeGutters(callback);
  }

  // Essential: Calls your `callback` when a {Gutter} is added to the editor.
  //
  // * `callback` {Function}
  //   * `gutter` {Gutter} that was added.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidAddGutter(callback) {
    return this.gutterContainer.onDidAddGutter(callback);
  }

  // Essential: Calls your `callback` when a {Gutter} is removed from the editor.
  //
  // * `callback` {Function}
  //   * `name` The name of the {Gutter} that was removed.
  //
  // Returns a {Disposable} on which `.dispose()` can be called to unsubscribe.
  onDidRemoveGutter(callback) {
    return this.gutterContainer.onDidRemoveGutter(callback);
  }

  // Set the number of characters that can be displayed horizontally in the
  // editor.
  //
  // * `editorWidthInChars` A {Number} representing the width of the
  // {TextEditorElement} in characters.
  setEditorWidthInChars(editorWidthInChars) {
    this.updateEditorWidthInChars(editorWidthInChars, true);
  }

  // Returns the editor width in characters.
  getEditorWidthInChars() {
    if (this.width != null && this.defaultCharWidth > 0) {
      return Math.max(0, Math.floor(this.width / this.defaultCharWidth));
    } else {
      return this.editorWidthInChars;
    }
  }

  /*
  Section: Buffer
  */

  // Essential: Retrieves the current {TextBuffer}.
  getBuffer() {
    return this.buffer;
  }

  /*
  Section: File Details
  */

  // Essential: Get the editor's title for display in other parts of the
  // UI such as the tabs.
  //
  // If the editor's buffer is saved, its title is the file name. If it is
  // unsaved, its title is "untitled".
  //
  // Returns a {String}.
  getTitle() {
    return this.getFileName() || 'untitled';
  }

  // Essential: Get unique title for display in other parts of the UI, such as
  // the window title.
  //
  // If the editor's buffer is unsaved, its title is "untitled"
  // If the editor's buffer is saved, its unique title is formatted as one
  // of the following,
  // * "<filename>" when it is the only editing buffer with this file name.
  // * "<filename> — <unique-dir-prefix>" when other buffers have this file name.
  //
  // Returns a {String}
  getLongTitle() {
    if (this.getPath()) {
      const fileName = this.getFileName();

      let myPathSegments;
      const openEditorPathSegmentsWithSameFilename = [];
      for (const textEditor of atom.workspace.getTextEditors()) {
        if (textEditor.getFileName() === fileName) {
          const pathSegments = fs
            .tildify(textEditor.getDirectoryPath())
            .split(path.sep);
          openEditorPathSegmentsWithSameFilename.push(pathSegments);
          if (textEditor === this) myPathSegments = pathSegments;
        }
      }

      if (
        !myPathSegments ||
        openEditorPathSegmentsWithSameFilename.length === 1
      )
        return fileName;

      let commonPathSegmentCount;
      for (let i = 0, { length } = myPathSegments; i < length; i++) {
        const myPathSegment = myPathSegments[i];
        if (
          openEditorPathSegmentsWithSameFilename.some(
            segments =>
              segments.length === i + 1 || segments[i] !== myPathSegment
          )
        ) {
          commonPathSegmentCount = i;
          break;
        }
      }

      return `${fileName} \u2014 ${path.join(
        ...myPathSegments.slice(commonPathSegmentCount)
      )}`;
    } else {
      return 'untitled';
    }
  }

  // Essential: Returns the {String} path of this editor's text buffer.
  getPath() {
    return this.buffer.getPath();
  }

  getFileName() {
    const fullPath = this.getPath();
    if (fullPath) return path.basename(fullPath);
  }

  getDirectoryPath() {
    const fullPath = this.getPath();
    if (fullPath) return path.dirname(fullPath);
  }

  // Extended: Returns the {String} character set encoding of this editor's text
  // buffer.
  getEncoding() {
    return this.buffer.getEncoding();
  }

  // Extended: Set the character set encoding to use in this editor's text
  // buffer.
  //
  // * `encoding` The {String} character set encoding name such as 'utf8'
  setEncoding(encoding) {
    this.buffer.setEncoding(encoding);
  }

  // Essential: Returns {Boolean} `true` if this editor has been modified.
  isModified() {
    return this.buffer.isModified();
  }

  // Essential: Returns {Boolean} `true` if this editor has no content.
  isEmpty() {
    return this.buffer.isEmpty();
  }

  /*
  Section: File Operations
  */

  // Essential: Saves the editor's text buffer.
  //
  // See {TextBuffer::save} for more details.
  save() {
    return this.buffer.save();
  }

  // Essential: Saves the editor's text buffer as the given path.
  //
  // See {TextBuffer::saveAs} for more details.
  //
  // * `filePath` A {String} path.
  saveAs(filePath) {
    return this.buffer.saveAs(filePath);
  }

  // Determine whether the user should be prompted to save before closing
  // this editor.
  shouldPromptToSave({ windowCloseRequested, projectHasPaths } = {}) {
    if (
      windowCloseRequested &&
      projectHasPaths &&
      atom.stateStore.isConnected()
    ) {
      return this.buffer.isInConflict();
    } else {
      return this.isModified() && !this.buffer.hasMultipleEditors();
    }
  }

  // Returns an {Object} to configure dialog shown when this editor is saved
  // via {Pane::saveItemAs}.
  getSaveDialogOptions() {
    return {};
  }

  /*
  Section: Reading Text
  */

  // Essential: Returns a {String} representing the entire contents of the editor.
  getText() {
    return this.buffer.getText();
  }

  // Essential: Get the text in the given {Range} in buffer coordinates.
  //
  // * `range` A {Range} or range-compatible {Array}.
  //
  // Returns a {String}.
  getTextInBufferRange(range) {
    return this.buffer.getTextInRange(range);
  }

  // Essential: Returns a {Number} representing the number of lines in the buffer.
  getLineCount() {
    return this.buffer.getLineCount();
  }

  // Essential: Returns a {Number} representing the number of screen lines in the
  // editor. This accounts for folds.
  getScreenLineCount() {
    return this.displayLayer.getScreenLineCount();
  }

  getApproximateScreenLineCount() {
    return this.displayLayer.getApproximateScreenLineCount();
  }

  // Essential: Returns a {Number} representing the last zero-indexed buffer row
  // number of the editor.
  getLastBufferRow() {
    return this.buffer.getLastRow();
  }

  // Essential: Returns a {Number} representing the last zero-indexed screen row
  // number of the editor.
  getLastScreenRow() {
    return this.getScreenLineCount() - 1;
  }

  // Essential: Returns a {String} representing the contents of the line at the
  // given buffer row.
  //
  // * `bufferRow` A {Number} representing a zero-indexed buffer row.
  lineTextForBufferRow(bufferRow) {
    return this.buffer.lineForRow(bufferRow);
  }

  // Essential: Returns a {String} representing the contents of the line at the
  // given screen row.
  //
  // * `screenRow` A {Number} representing a zero-indexed screen row.
  lineTextForScreenRow(screenRow) {
    const screenLine = this.screenLineForScreenRow(screenRow);
    if (screenLine) return screenLine.lineText;
  }

  logScreenLines(start = 0, end = this.getLastScreenRow()) {
    for (let row = start; row <= end; row++) {
      const line = this.lineTextForScreenRow(row);
      console.log(row, this.bufferRowForScreenRow(row), line, line.length);
    }
  }

  tokensForScreenRow(screenRow) {
    const tokens = [];
    let lineTextIndex = 0;
    const currentTokenScopes = [];
    const { lineText, tags } = this.screenLineForScreenRow(screenRow);
    for (const tag of tags) {
      if (this.displayLayer.isOpenTag(tag)) {
        currentTokenScopes.push(this.displayLayer.classNameForTag(tag));
      } else if (this.displayLayer.isCloseTag(tag)) {
        currentTokenScopes.pop();
      } else {
        tokens.push({
          text: lineText.substr(lineTextIndex, tag),
          scopes: currentTokenScopes.slice()
        });
        lineTextIndex += tag;
      }
    }
    return tokens;
  }

  screenLineForScreenRow(screenRow) {
    return this.displayLayer.getScreenLine(screenRow);
  }

  bufferRowForScreenRow(screenRow) {
    return this.displayLayer.translateScreenPosition(Point(screenRow, 0)).row;
  }

  bufferRowsForScreenRows(startScreenRow, endScreenRow) {
    return this.displayLayer.bufferRowsForScreenRows(
      startScreenRow,
      endScreenRow + 1
    );
  }

  screenRowForBufferRow(row) {
    return this.displayLayer.translateBufferPosition(Point(row, 0)).row;
  }

  getRightmostScreenPosition() {
    return this.displayLayer.getRightmostScreenPosition();
  }

  getApproximateRightmostScreenPosition() {
    return this.displayLayer.getApproximateRightmostScreenPosition();
  }

  getMaxScreenLineLength() {
    return this.getRightmostScreenPosition().column;
  }

  getLongestScreenRow() {
    return this.getRightmostScreenPosition().row;
  }

  getApproximateLongestScreenRow() {
    return this.getApproximateRightmostScreenPosition().row;
  }

  lineLengthForScreenRow(screenRow) {
    return this.displayLayer.lineLengthForScreenRow(screenRow);
  }

  // Returns the range for the given buffer row.
  //
  // * `row` A row {Number}.
  // * `options` (optional) An options hash with an `includeNewline` key.
  //
  // Returns a {Range}.
  bufferRangeForBufferRow(row, options) {
    return this.buffer.rangeForRow(row, options && options.includeNewline);
  }

  // Get the text in the given {Range}.
  //
  // Returns a {String}.
  getTextInRange(range) {
    return this.buffer.getTextInRange(range);
  }

  // {Delegates to: TextBuffer.isRowBlank}
  isBufferRowBlank(bufferRow) {
    return this.buffer.isRowBlank(bufferRow);
  }

  // {Delegates to: TextBuffer.nextNonBlankRow}
  nextNonBlankBufferRow(bufferRow) {
    return this.buffer.nextNonBlankRow(bufferRow);
  }

  // {Delegates to: TextBuffer.getEndPosition}
  getEofBufferPosition() {
    return this.buffer.getEndPosition();
  }

  // Essential: Get the {Range} of the paragraph surrounding the most recently added
  // cursor.
  //
  // Returns a {Range}.
  getCurrentParagraphBufferRange() {
    return this.getLastCursor().getCurrentParagraphBufferRange();
  }

  /*
  Section: Mutating Text
  */

  // Essential: Replaces the entire contents of the buffer with the given {String}.
  //
  // * `text` A {String} to replace with
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor.
  setText(text, options = {}) {
    if (!this.ensureWritable('setText', options)) return;
    return this.buffer.setText(text);
  }

  // Essential: Set the text in the given {Range} in buffer coordinates.
  //
  // * `range` A {Range} or range-compatible {Array}.
  // * `text` A {String}
  // * `options` (optional) {Object}
  //   * `normalizeLineEndings` (optional) {Boolean} (default: true)
  //   * `undo` (optional) *Deprecated* {String} 'skip' will skip the undo system. This property is deprecated. Call groupLastChanges() on the {TextBuffer} afterward instead.
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  //
  // Returns the {Range} of the newly-inserted text.
  setTextInBufferRange(range, text, options = {}) {
    if (!this.ensureWritable('setTextInBufferRange', options)) return;
    return this.getBuffer().setTextInRange(range, text, options);
  }

  // Essential: For each selection, replace the selected text with the given text.
  //
  // * `text` A {String} representing the text to insert.
  // * `options` (optional) See {Selection::insertText}.
  //
  // Returns a {Range} when the text has been inserted. Returns a {Boolean} `false` when the text has not been inserted.
  insertText(text, options = {}) {
    if (!this.ensureWritable('insertText', options)) return;
    if (!this.emitWillInsertTextEvent(text)) return false;

    let groupLastChanges = false;
    if (options.undo === 'skip') {
      options = Object.assign({}, options);
      delete options.undo;
      groupLastChanges = true;
    }

    const groupingInterval = options.groupUndo ? this.undoGroupingInterval : 0;
    if (options.autoIndentNewline == null)
      options.autoIndentNewline = this.shouldAutoIndent();
    if (options.autoDecreaseIndent == null)
      options.autoDecreaseIndent = this.shouldAutoIndent();
    const result = this.mutateSelectedText(selection => {
      const range = selection.insertText(text, options);
      const didInsertEvent = { text, range };
      this.emitter.emit('did-insert-text', didInsertEvent);
      return range;
    }, groupingInterval);
    if (groupLastChanges) this.buffer.groupLastChanges();
    return result;
  }

  // Essential: For each selection, replace the selected text with a newline.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  insertNewline(options = {}) {
    return this.insertText('\n', options);
  }

  // Essential: For each selection, if the selection is empty, delete the character
  // following the cursor. Otherwise delete the selected text.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  delete(options = {}) {
    if (!this.ensureWritable('delete', options)) return;
    return this.mutateSelectedText(selection => selection.delete(options));
  }

  // Essential: For each selection, if the selection is empty, delete the character
  // preceding the cursor. Otherwise delete the selected text.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  backspace(options = {}) {
    if (!this.ensureWritable('backspace', options)) return;
    return this.mutateSelectedText(selection => selection.backspace(options));
  }

  // Extended: Mutate the text of all the selections in a single transaction.
  //
  // All the changes made inside the given {Function} can be reverted with a
  // single call to {::undo}.
  //
  // * `fn` A {Function} that will be called once for each {Selection}. The first
  //      argument will be a {Selection} and the second argument will be the
  //      {Number} index of that selection.
  mutateSelectedText(fn, groupingInterval = 0) {
    return this.mergeIntersectingSelections(() => {
      return this.transact(groupingInterval, () => {
        return this.getSelectionsOrderedByBufferPosition().map(
          (selection, index) => fn(selection, index)
        );
      });
    });
  }

  // Move lines intersecting the most recent selection or multiple selections
  // up by one row in screen coordinates.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  moveLineUp(options = {}) {
    if (!this.ensureWritable('moveLineUp', options)) return;

    const selections = this.getSelectedBufferRanges().sort((a, b) =>
      a.compare(b)
    );

    if (selections[0].start.row === 0) return;
    if (
      selections[selections.length - 1].start.row === this.getLastBufferRow() &&
      this.buffer.getLastLine() === ''
    )
      return;

    this.transact(() => {
      const newSelectionRanges = [];

      while (selections.length > 0) {
        // Find selections spanning a contiguous set of lines
        const selection = selections.shift();
        const selectionsToMove = [selection];

        while (
          selection.end.row ===
          (selections[0] != null ? selections[0].start.row : undefined)
        ) {
          selectionsToMove.push(selections[0]);
          selection.end.row = selections[0].end.row;
          selections.shift();
        }

        // Compute the buffer range spanned by all these selections, expanding it
        // so that it includes any folded region that intersects them.
        let startRow = selection.start.row;
        let endRow = selection.end.row;
        if (
          selection.end.row > selection.start.row &&
          selection.end.column === 0
        ) {
          // Don't move the last line of a multi-line selection if the selection ends at column 0
          endRow--;
        }

        startRow = this.displayLayer.findBoundaryPrecedingBufferRow(startRow);
        endRow = this.displayLayer.findBoundaryFollowingBufferRow(endRow + 1);
        const linesRange = new Range(Point(startRow, 0), Point(endRow, 0));

        // If selected line range is preceded by a fold, one line above on screen
        // could be multiple lines in the buffer.
        const precedingRow = this.displayLayer.findBoundaryPrecedingBufferRow(
          startRow - 1
        );
        const insertDelta = linesRange.start.row - precedingRow;

        // Any folds in the text that is moved will need to be re-created.
        // It includes the folds that were intersecting with the selection.
        const rangesToRefold = this.displayLayer
          .destroyFoldsIntersectingBufferRange(linesRange)
          .map(range => range.translate([-insertDelta, 0]));

        // Delete lines spanned by selection and insert them on the preceding buffer row
        let lines = this.buffer.getTextInRange(linesRange);
        if (lines[lines.length - 1] !== '\n') {
          lines += this.buffer.lineEndingForRow(linesRange.end.row - 2);
        }
        this.buffer.delete(linesRange);
        this.buffer.insert([precedingRow, 0], lines);

        // Restore folds that existed before the lines were moved
        for (let rangeToRefold of rangesToRefold) {
          this.displayLayer.foldBufferRange(rangeToRefold);
        }

        for (const selectionToMove of selectionsToMove) {
          newSelectionRanges.push(selectionToMove.translate([-insertDelta, 0]));
        }
      }

      this.setSelectedBufferRanges(newSelectionRanges, {
        autoscroll: false,
        preserveFolds: true
      });
      if (this.shouldAutoIndent()) this.autoIndentSelectedRows();
      this.scrollToBufferPosition([newSelectionRanges[0].start.row, 0]);
    });
  }

  // Move lines intersecting the most recent selection or multiple selections
  // down by one row in screen coordinates.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  moveLineDown(options = {}) {
    if (!this.ensureWritable('moveLineDown', options)) return;

    const selections = this.getSelectedBufferRanges();
    selections.sort((a, b) => b.compare(a));

    this.transact(() => {
      this.consolidateSelections();
      const newSelectionRanges = [];

      while (selections.length > 0) {
        // Find selections spanning a contiguous set of lines
        const selection = selections.shift();
        const selectionsToMove = [selection];

        // if the current selection start row matches the next selections' end row - make them one selection
        while (
          selection.start.row ===
          (selections[0] != null ? selections[0].end.row : undefined)
        ) {
          selectionsToMove.push(selections[0]);
          selection.start.row = selections[0].start.row;
          selections.shift();
        }

        // Compute the buffer range spanned by all these selections, expanding it
        // so that it includes any folded region that intersects them.
        let startRow = selection.start.row;
        let endRow = selection.end.row;
        if (
          selection.end.row > selection.start.row &&
          selection.end.column === 0
        ) {
          // Don't move the last line of a multi-line selection if the selection ends at column 0
          endRow--;
        }

        startRow = this.displayLayer.findBoundaryPrecedingBufferRow(startRow);
        endRow = this.displayLayer.findBoundaryFollowingBufferRow(endRow + 1);
        const linesRange = new Range(Point(startRow, 0), Point(endRow, 0));

        // If selected line range is followed by a fold, one line below on screen
        // could be multiple lines in the buffer. But at the same time, if the
        // next buffer row is wrapped, one line in the buffer can represent many
        // screen rows.
        const followingRow = Math.min(
          this.buffer.getLineCount(),
          this.displayLayer.findBoundaryFollowingBufferRow(endRow + 1)
        );
        const insertDelta = followingRow - linesRange.end.row;

        // Any folds in the text that is moved will need to be re-created.
        // It includes the folds that were intersecting with the selection.
        const rangesToRefold = this.displayLayer
          .destroyFoldsIntersectingBufferRange(linesRange)
          .map(range => range.translate([insertDelta, 0]));

        // Delete lines spanned by selection and insert them on the following correct buffer row
        let lines = this.buffer.getTextInRange(linesRange);
        if (followingRow - 1 === this.buffer.getLastRow()) {
          lines = `\n${lines}`;
        }

        this.buffer.insert([followingRow, 0], lines);
        this.buffer.delete(linesRange);

        // Restore folds that existed before the lines were moved
        for (let rangeToRefold of rangesToRefold) {
          this.displayLayer.foldBufferRange(rangeToRefold);
        }

        for (const selectionToMove of selectionsToMove) {
          newSelectionRanges.push(selectionToMove.translate([insertDelta, 0]));
        }
      }

      this.setSelectedBufferRanges(newSelectionRanges, {
        autoscroll: false,
        preserveFolds: true
      });
      if (this.shouldAutoIndent()) this.autoIndentSelectedRows();
      this.scrollToBufferPosition([newSelectionRanges[0].start.row - 1, 0]);
    });
  }

  // Move any active selections one column to the left.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  moveSelectionLeft(options = {}) {
    if (!this.ensureWritable('moveSelectionLeft', options)) return;
    const selections = this.getSelectedBufferRanges();
    const noSelectionAtStartOfLine = selections.every(
      selection => selection.start.column !== 0
    );

    const translationDelta = [0, -1];
    const translatedRanges = [];

    if (noSelectionAtStartOfLine) {
      this.transact(() => {
        for (let selection of selections) {
          const charToLeftOfSelection = new Range(
            selection.start.translate(translationDelta),
            selection.start
          );
          const charTextToLeftOfSelection = this.buffer.getTextInRange(
            charToLeftOfSelection
          );

          this.buffer.insert(selection.end, charTextToLeftOfSelection);
          this.buffer.delete(charToLeftOfSelection);
          translatedRanges.push(selection.translate(translationDelta));
        }

        this.setSelectedBufferRanges(translatedRanges);
      });
    }
  }

  // Move any active selections one column to the right.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  moveSelectionRight(options = {}) {
    if (!this.ensureWritable('moveSelectionRight', options)) return;
    const selections = this.getSelectedBufferRanges();
    const noSelectionAtEndOfLine = selections.every(selection => {
      return (
        selection.end.column !== this.buffer.lineLengthForRow(selection.end.row)
      );
    });

    const translationDelta = [0, 1];
    const translatedRanges = [];

    if (noSelectionAtEndOfLine) {
      this.transact(() => {
        for (let selection of selections) {
          const charToRightOfSelection = new Range(
            selection.end,
            selection.end.translate(translationDelta)
          );
          const charTextToRightOfSelection = this.buffer.getTextInRange(
            charToRightOfSelection
          );

          this.buffer.delete(charToRightOfSelection);
          this.buffer.insert(selection.start, charTextToRightOfSelection);
          translatedRanges.push(selection.translate(translationDelta));
        }

        this.setSelectedBufferRanges(translatedRanges);
      });
    }
  }

  // Duplicate all lines containing active selections.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  duplicateLines(options = {}) {
    if (!this.ensureWritable('duplicateLines', options)) return;
    this.transact(() => {
      const selections = this.getSelectionsOrderedByBufferPosition();
      const previousSelectionRanges = [];

      let i = selections.length - 1;
      while (i >= 0) {
        const j = i;
        previousSelectionRanges[i] = selections[i].getBufferRange();
        if (selections[i].isEmpty()) {
          const { start } = selections[i].getScreenRange();
          selections[i].setScreenRange([[start.row, 0], [start.row + 1, 0]], {
            preserveFolds: true
          });
        }
        let [startRow, endRow] = selections[i].getBufferRowRange();
        endRow++;
        while (i > 0) {
          const [
            previousSelectionStartRow,
            previousSelectionEndRow
          ] = selections[i - 1].getBufferRowRange();
          if (previousSelectionEndRow === startRow) {
            startRow = previousSelectionStartRow;
            previousSelectionRanges[i - 1] = selections[i - 1].getBufferRange();
            i--;
          } else {
            break;
          }
        }

        const intersectingFolds = this.displayLayer.foldsIntersectingBufferRange(
          [[startRow, 0], [endRow, 0]]
        );
        let textToDuplicate = this.getTextInBufferRange([
          [startRow, 0],
          [endRow, 0]
        ]);
        if (endRow > this.getLastBufferRow())
          textToDuplicate = `\n${textToDuplicate}`;
        this.buffer.insert([endRow, 0], textToDuplicate);

        const insertedRowCount = endRow - startRow;

        for (let k = i; k <= j; k++) {
          selections[k].setBufferRange(
            previousSelectionRanges[k].translate([insertedRowCount, 0])
          );
        }

        for (const fold of intersectingFolds) {
          const foldRange = this.displayLayer.bufferRangeForFold(fold);
          this.displayLayer.foldBufferRange(
            foldRange.translate([insertedRowCount, 0])
          );
        }

        i--;
      }
    });
  }

  replaceSelectedText(options, fn) {
    this.mutateSelectedText(selection => {
      selection.getBufferRange();
      if (options && options.selectWordIfEmpty && selection.isEmpty()) {
        selection.selectWord();
      }
      const text = selection.getText();
      selection.deleteSelectedText();
      const range = selection.insertText(fn(text));
      selection.setBufferRange(range);
    });
  }

  // Split multi-line selections into one selection per line.
  //
  // Operates on all selections. This method breaks apart all multi-line
  // selections to create multiple single-line selections that cumulatively cover
  // the same original area.
  splitSelectionsIntoLines() {
    this.mergeIntersectingSelections(() => {
      for (const selection of this.getSelections()) {
        const range = selection.getBufferRange();
        if (range.isSingleLine()) continue;

        const { start, end } = range;
        this.addSelectionForBufferRange([start, [start.row, Infinity]]);
        let { row } = start;
        while (++row < end.row) {
          this.addSelectionForBufferRange([[row, 0], [row, Infinity]]);
        }
        if (end.column !== 0)
          this.addSelectionForBufferRange([
            [end.row, 0],
            [end.row, end.column]
          ]);
        selection.destroy();
      }
    });
  }

  // Extended: For each selection, transpose the selected text.
  //
  // If the selection is empty, the characters preceding and following the cursor
  // are swapped. Otherwise, the selected characters are reversed.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  transpose(options = {}) {
    if (!this.ensureWritable('transpose', options)) return;
    this.mutateSelectedText(selection => {
      if (selection.isEmpty()) {
        selection.selectRight();
        const text = selection.getText();
        selection.delete();
        selection.cursor.moveLeft();
        selection.insertText(text);
      } else {
        selection.insertText(
          selection
            .getText()
            .split('')
            .reverse()
            .join('')
        );
      }
    });
  }

  // Extended: Convert the selected text to upper case.
  //
  // For each selection, if the selection is empty, converts the containing word
  // to upper case. Otherwise convert the selected text to upper case.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  upperCase(options = {}) {
    if (!this.ensureWritable('upperCase', options)) return;
    this.replaceSelectedText({ selectWordIfEmpty: true }, text =>
      text.toUpperCase(options)
    );
  }

  // Extended: Convert the selected text to lower case.
  //
  // For each selection, if the selection is empty, converts the containing word
  // to upper case. Otherwise convert the selected text to upper case.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  lowerCase(options = {}) {
    if (!this.ensureWritable('lowerCase', options)) return;
    this.replaceSelectedText({ selectWordIfEmpty: true }, text =>
      text.toLowerCase(options)
    );
  }

  // Extended: Toggle line comments for rows intersecting selections.
  //
  // If the current grammar doesn't support comments, does nothing.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  toggleLineCommentsInSelection(options = {}) {
    if (!this.ensureWritable('toggleLineCommentsInSelection', options)) return;
    this.mutateSelectedText(selection => selection.toggleLineComments(options));
  }

  // Convert multiple lines to a single line.
  //
  // Operates on all selections. If the selection is empty, joins the current
  // line with the next line. Otherwise it joins all lines that intersect the
  // selection.
  //
  // Joining a line means that multiple lines are converted to a single line with
  // the contents of each of the original non-empty lines separated by a space.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  joinLines(options = {}) {
    if (!this.ensureWritable('joinLines', options)) return;
    this.mutateSelectedText(selection => selection.joinLines());
  }

  // Extended: For each cursor, insert a newline at beginning the following line.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  insertNewlineBelow(options = {}) {
    if (!this.ensureWritable('insertNewlineBelow', options)) return;
    this.transact(() => {
      this.moveToEndOfLine();
      this.insertNewline(options);
    });
  }

  // Extended: For each cursor, insert a newline at the end of the preceding line.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  insertNewlineAbove(options = {}) {
    if (!this.ensureWritable('insertNewlineAbove', options)) return;
    this.transact(() => {
      const bufferRow = this.getCursorBufferPosition().row;
      const indentLevel = this.indentationForBufferRow(bufferRow);
      const onFirstLine = bufferRow === 0;

      this.moveToBeginningOfLine();
      this.moveLeft();
      this.insertNewline(options);

      if (
        this.shouldAutoIndent() &&
        this.indentationForBufferRow(bufferRow) < indentLevel
      ) {
        this.setIndentationForBufferRow(bufferRow, indentLevel);
      }

      if (onFirstLine) {
        this.moveUp();
        this.moveToEndOfLine();
      }
    });
  }

  // Extended: For each selection, if the selection is empty, delete all characters
  // of the containing word that precede the cursor. Otherwise delete the
  // selected text.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  deleteToBeginningOfWord(options = {}) {
    if (!this.ensureWritable('deleteToBeginningOfWord', options)) return;
    this.mutateSelectedText(selection =>
      selection.deleteToBeginningOfWord(options)
    );
  }

  // Extended: Similar to {::deleteToBeginningOfWord}, but deletes only back to the
  // previous word boundary.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  deleteToPreviousWordBoundary(options = {}) {
    if (!this.ensureWritable('deleteToPreviousWordBoundary', options)) return;
    this.mutateSelectedText(selection =>
      selection.deleteToPreviousWordBoundary(options)
    );
  }

  // Extended: Similar to {::deleteToEndOfWord}, but deletes only up to the
  // next word boundary.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  deleteToNextWordBoundary(options = {}) {
    if (!this.ensureWritable('deleteToNextWordBoundary', options)) return;
    this.mutateSelectedText(selection =>
      selection.deleteToNextWordBoundary(options)
    );
  }

  // Extended: For each selection, if the selection is empty, delete all characters
  // of the containing subword following the cursor. Otherwise delete the selected
  // text.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  deleteToBeginningOfSubword(options = {}) {
    if (!this.ensureWritable('deleteToBeginningOfSubword', options)) return;
    this.mutateSelectedText(selection =>
      selection.deleteToBeginningOfSubword(options)
    );
  }

  // Extended: For each selection, if the selection is empty, delete all characters
  // of the containing subword following the cursor. Otherwise delete the selected
  // text.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  deleteToEndOfSubword(options = {}) {
    if (!this.ensureWritable('deleteToEndOfSubword', options)) return;
    this.mutateSelectedText(selection =>
      selection.deleteToEndOfSubword(options)
    );
  }

  // Extended: For each selection, if the selection is empty, delete all characters
  // of the containing line that precede the cursor. Otherwise delete the
  // selected text.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  deleteToBeginningOfLine(options = {}) {
    if (!this.ensureWritable('deleteToBeginningOfLine', options)) return;
    this.mutateSelectedText(selection =>
      selection.deleteToBeginningOfLine(options)
    );
  }

  // Extended: For each selection, if the selection is not empty, deletes the
  // selection; otherwise, deletes all characters of the containing line
  // following the cursor. If the cursor is already at the end of the line,
  // deletes the following newline.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  deleteToEndOfLine(options = {}) {
    if (!this.ensureWritable('deleteToEndOfLine', options)) return;
    this.mutateSelectedText(selection => selection.deleteToEndOfLine(options));
  }

  // Extended: For each selection, if the selection is empty, delete all characters
  // of the containing word following the cursor. Otherwise delete the selected
  // text.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  deleteToEndOfWord(options = {}) {
    if (!this.ensureWritable('deleteToEndOfWord', options)) return;
    this.mutateSelectedText(selection => selection.deleteToEndOfWord(options));
  }

  // Extended: Delete all lines intersecting selections.
  //
  // * `options` (optional) {Object}
  //   * `bypassReadOnly` (optional) {Boolean} Must be `true` to modify a read-only editor. (default: false)
  deleteLine(options = {}) {
    if (!this.ensureWritable('deleteLine', options)) return;
    this.mergeSelectionsOnSameRows();
    this.mutateSelectedText(selection => selection.deleteLine(options));
  }

  // Private: Ensure that this editor is not marked read-only before allowing a buffer modification to occur. If
  // the editor is read-only, require an explicit opt-in option to proceed (`bypassReadOnly`) or throw an Error.
  ensureWritable(methodName, opts) {
    if (!opts.bypassReadOnly && this.isReadOnly()) {
      if (atom.inDevMode() || atom.inSpecMode()) {
        const e = new Error('Attempt to mutate a read-only TextEditor');
        e.detail =
          `Your package is attempting to call ${methodName} on an editor that has been marked read-only. ` +
          'Pass {bypassReadOnly: true} to modify it anyway, or test editors with .isReadOnly() before attempting ' +
          'modifications.';
        throw e;
      }
const _ = require('underscore-plus');
const path = require('path');
const fs = require('fs-plus');
const Grim = require('grim');
const dedent = require('dedent');
const { CompositeDisposable, Disposable, Emitter } = require('event-kit');
const TextBuffer = require('text-buffer');
const { Point, Range } = TextBuffer;
const DecorationManager = require('./decoration-manager');
const Cursor = require('./cursor');
const Selection = require('./selection');
const NullGrammar = require('./null-grammar');
const TextMateLanguageMode = require('./text-mate-language-mode');
const ScopeDescriptor = require('./scope-descriptor');

const TextMateScopeSelector = require('first-mate').ScopeSelector;
const GutterContainer = require('./gutter-container');
let TextEditorComponent = null;
let TextEditorElement = null;
const {
  isDoubleWidthCharacter,
  isHalfWidthCharacter,
  isKoreanCharacter,
  isWrapBoundary
} = require('./text-utils');

const SERIALIZATION_VERSION = 1;
const NON_WHITESPACE_REGEXP = /\S/;
const ZERO_WIDTH_NBSP = '\ufeff';
let nextId = 0;

const DEFAULT_NON_WORD_CHARACTERS = '/\\()"\':,.;<>~!@#$%^&*|+=[]{}`?-…';

// Essential: This class represents all essential editing state for a single
// {TextBuffer}, including cursor and selection positions, folds, and soft wraps.
// If you're manipulating the state of an editor, use this class.
//
// A single {TextBuffer} can belong to multiple editors. For example, if the
// same file is open in two different panes, Pulsar creates a separate editor for
// each pane. If the buffer is manipulated the changes are reflected in both
// editors, but each maintains its own cursor position, folded lines, etc.
//
// ## Accessing TextEditor Instances
//
// The easiest way to get hold of `TextEditor` objects is by registering a callback
// with `::observeTextEditors` on the `atom.workspace` global. Your callback will
// then be called with all current editor instances and also when any editor is
// created in the future.
//
// ```js
// atom.workspace.observeTextEditors(editor => {
//   editor.insertText('Hello World')
// })
// ```
//
// ## Buffer vs. Screen Coordinates
//
// Because editors support folds and soft-wrapping, the lines on screen don't
// always match the lines in the buffer. For example, a long line that soft wraps
// twice renders as three lines on screen, but only represents one line in the
// buffer. Similarly, if rows 5-10 are folded, then row 6 on screen corresponds
// to row 11 in the buffer.
//
// Your choice of coordinates systems will depend on what you're trying to
// achieve. For example, if you're writing a command that jumps the cursor up or
// down by 10 lines, you'll want to use screen coordinates because the user
// probably wants to skip lines *on screen*. However, if you're writing a package
// that jumps between method definitions, you'll want to work in buffer
// coordinates.
//
// **When in doubt, just default to buffer coordinates**, then experiment with
// soft wraps and folds to ensure your code interacts with them correctly.
module.exports = class TextEditor {
  static setClipboard(clipboard) {
    this.clipboard = clipboard;
  }

  static setScheduler(scheduler) {
    if (TextEditorComponent == null) {
      TextEditorComponent = require('./text-editor-component');
    }
    return TextEditorComponent.setScheduler(scheduler);
  }

  static didUpdateStyles() {
    if (TextEditorComponent == null) {
      TextEditorComponent = require('./text-editor-component');
    }
    return TextEditorComponent.didUpdateStyles();
  }

  static didUpdateScrollbarStyles() {
    if (TextEditorComponent == null) {
      TextEditorComponent = require('./text-editor-component');
    }
    return TextEditorComponent.didUpdateScrollbarStyles();
  }

  static viewForItem(item) {
    return item.element || item;
  }

  static deserialize(state, atomEnvironment) {
    if (state.version !== SERIALIZATION_VERSION) return null;

    let bufferId = state.tokenizedBuffer
      ? state.tokenizedBuffer.bufferId
      : state.bufferId;

    try {
      state.buffer = atomEnvironment.project.bufferForIdSync(bufferId);
      if (!state.buffer) return null;
    } catch (error) {
      if (error.syscall === 'read') {
        return; // Error reading the file, don't deserialize an editor for it
      } else {
        throw error;
      }
    }

    state.assert = atomEnvironment.assert.bind(atomEnvironment);

    // Semantics of the readOnly flag have changed since its introduction.
    // Only respect readOnly2, which has been set with the current readOnly semantics.
    delete state.readOnly;
    state.readOnly = state.readOnly2;
    delete state.readOnly2;

    const editor = new TextEditor(state);
    if (state.registered) {
      const disposable = atomEnvironment.textEditors.add(editor);
      editor.onDidDestroy(() => disposable.dispose());
    }
    return editor;
  }

  constructor(params = {}) {
    if (this.constructor.clipboard == null) {
      throw new Error(
        'Must call TextEditor.setClipboard at least once before creating TextEditor instances'
      );
    }

    this.id = params.id != null ? params.id : nextId++;
    if (this.id >= nextId) {
      // Ensure that new editors get unique ids:
      nextId = this.id + 1;
    }
    this.initialScrollTopRow = params.initialScrollTopRow;
    this.initialScrollLeftColumn = params.initialScrollLeftColumn;
    this.decorationManager = params.decorationManager;
    this.selectionsMarkerLayer = params.selectionsMarkerLayer;
    this.mini = params.mini != null ? params.mini : false;
    this.keyboardInputEnabled =
      params.keyboardInputEnabled != null ? params.keyboardInputEnabled : true;
    this.readOnly = params.readOnly != null ? params.readOnly : false;
    this.placeholderText = params.placeholderText;
    this.showLineNumbers = params.showLineNumbers;
    this.assert = params.assert || (condition => condition);
    this.showInvisibles =
      params.showInvisibles != null ? params.showInvisibles : true;
    this.autoHeight = params.autoHeight;
    this.autoWidth = params.autoWidth;
    this.scrollPastEnd =
      params.scrollPastEnd != null ? params.scrollPastEnd : false;
    this.scrollSensitivity =
      params.scrollSensitivity != null ? params.scrollSensitivity : 40;
    this.editorWidthInChars = params.editorWidthInChars;
    this.invisibles = params.invisibles;
    this.showIndentGuide = params.showIndentGuide;
    this.softWrapped = params.softWrapped;
    this.softWrapAtPreferredLineLength = params.softWrapAtPreferredLineLength;
    this.preferredLineLength = params.preferredLineLength;
    this.showCursorOnSelection =
      params.showCursorOnSelection != null
        ? params.showCursorOnSelection
        : true;
    this.maxScreenLineLength = params.maxScreenLineLength;
    this.softTabs = params.softTabs != null ? params.softTabs : true;
    this.autoIndent = params.autoIndent != null ? params.autoIndent : true;
    this.autoIndentOnPaste =
      params.autoIndentOnPaste != null ? params.autoIndentOnPaste : true;
    this.undoGroupingInterval =
      params.undoGroupingInterval != null ? params.undoGroupingInterval : 300;
    this.softWrapped = params.softWrapped != null ? params.softWrapped : false;
    this.softWrapAtPreferredLineLength =
      params.softWrapAtPreferredLineLength != null
        ? params.softWrapAtPreferredLineLength
        : false;
    this.preferredLineLength =
      params.preferredLineLength != null ? params.preferredLineLength : 80;
    this.maxScreenLineLength =
      params.maxScreenLineLength != null ? params.maxScreenLineLength : 500;
    this.showLineNumbers =
      params.showLineNumbers != null ? params.showLineNumbers : true;
    const { tabLength = 2 } = params;

    this.alive = true;
    this.doBackgroundWork = this.doBackgroundWork.bind(this);
    this.serializationVersion = 1;
    this.suppressSelectionMerging = false;
    this.selectionFlashDuration = 500;
    this.gutterContainer = null;
    this.verticalScrollMargin = 2;
    this.horizontalScrollMargin = 6;
    this.lineHeightInPixels = null;
    this.defaultCharWidth = null;
    this.height = null;
    this.width = null;
    this.registered = false;
    this.atomicSoftTabs = true;
    this.emitter = new Emitter();
    this.disposables = new CompositeDisposable();
    this.cursors = [];
    this.cursorsByMarkerId = new Map();
    this.selections = [];
    this.hasTerminatedPendingState = false;

    if (params.buffer) {
      this.buffer = params.buffer;
    } else {
      this.buffer = new TextBuffer({
        shouldDestroyOnFileDelete() {
          return atom.config.get('core.closeDeletedFileTabs');
        }
      });
      this.buffer.setLanguageMode(
        new TextMateLanguageMode({ buffer: this.buffer, config: atom.config })
      );
    }

    const languageMode = this.buffer.getLanguageMode();
    this.languageModeSubscription =
      languageMode.onDidTokenize &&
      languageMode.onDidTokenize(() => {
        this.emitter.emit('did-tokenize');
      });
    if (this.languageModeSubscription)
      this.disposables.add(this.languageModeSubscription);

    if (params.displayLayer) {
      this.displayLayer = params.displayLayer;
    } else {
      const displayLayerParams = {
        invisibles: this.getInvisibles(),
        softWrapColumn: this.getSoftWrapColumn(),
        showIndentGuides: this.doesShowIndentGuide(),
        atomicSoftTabs:
          params.atomicSoftTabs != null ? params.atomicSoftTabs : true,
        tabLength,
        ratioForCharacter: this.ratioForCharacter.bind(this),
        isWrapBoundary,
        foldCharacter: ZERO_WIDTH_NBSP,
        softWrapHangingIndent:
          params.softWrapHangingIndentLength != null
            ? params.softWrapHangingIndentLength
            : 0
      };

      this.displayLayer = this.buffer.getDisplayLayer(params.displayLayerId);
      if (this.displayLayer) {
        this.displayLayer.reset(displayLayerParams);
        this.selectionsMarkerLayer = this.displayLayer.getMarkerLayer(
          params.selectionsMarkerLayerId
        );
      } else {
        this.displayLayer = this.buffer.addDisplayLayer(displayLayerParams);
      }
    }

    this.backgroundWorkHandle = requestIdleCallback(this.doBackgroundWork);
    this.disposables.add(
      new Disposable(() => {
        if (this.backgroundWorkHandle != null)
          return cancelIdleCallback(this.backgroundWorkHandle);
      })
    );

    this.defaultMarkerLayer = this.displayLayer.addMarkerLayer();
    if (!this.selectionsMarkerLayer) {
      this.selectionsMarkerLayer = this.addMarkerLayer({
        maintainHistory: true,
        persistent: true,
        role: 'selections'
      });
    }

    this.decorationManager = new DecorationManager(this);
    this.decorateMarkerLayer(this.selectionsMarkerLayer, { type: 'cursor' });
    if (!this.isMini()) this.decorateCursorLine();

    this.decorateMarkerLayer(this.displayLayer.foldsMarkerLayer, {
      type: 'line-number',
      class: 'folded'
    });

    for (let marker of this.selectionsMarkerLayer.getMarkers()) {
      this.addSelection(marker);
    }

    this.subscribeToBuffer();
    this.subscribeToDisplayLayer();

    if (this.cursors.length === 0 && !params.suppressCursorCreation) {
      const initialLine = Math.max(parseInt(params.initialLine) || 0, 0);
      const initialColumn = Math.max(parseInt(params.initialColumn) || 0, 0);
      this.addCursorAtBufferPosition([initialLine, initialColumn]);
    }

    this.gutterContainer = new GutterContainer(this);
    this.lineNumberGutter = this.gutterContainer.addGutter({
      name: 'line-number',
      type: 'line-number',
      priority: 0,
      visible: params.lineNumberGutterVisible
    });
  }

  get element() {
    return this.getElement();
  }

  get editorElement() {
    Grim.deprecate(dedent`\
      \`TextEditor.prototype.editorElement\` has always been private, but now
      it is gone. Reading the \`editorElement\` property still returns a
      reference to the editor element but this field will be removed in a
      later version of Pulsar, so we recommend using the \`element\` property instead.\
    `);

    return this.getElement();
  }

  get displayBuffer() {
    Grim.deprecate(dedent`\
      \`TextEditor.prototype.displayBuffer\` has always been private, but now
      it is gone. Reading the \`displayBuffer\` property now returns a reference
      to the containing \`TextEditor\`, which now provides *some* of the API of
      the defunct \`DisplayBuffer\` class.\
    `);
    return this;
  }

  get languageMode() {
    return this.buffer.getLanguageMode();
  }

  get tokenizedBuffer() {
    return this.buffer.getLanguageMode();
  }

  get rowsPerPage() {
    return this.getRowsPerPage();
  }

  decorateCursorLine() {
    this.cursorLineDecorations = [
      this.decorateMarkerLayer(this.selectionsMarkerLayer, {
        type: 'line',
        class: 'cursor-line',
        onlyEmpty: true
      }),
      this.decorateMarkerLayer(this.selectionsMarkerLayer, {
        type: 'line-number',
        class: 'cursor-line'
      }),
      this.decorateMarkerLayer(this.selectionsMarkerLayer, {
        type: 'line-number',
        class: 'cursor-line-no-selection',
        onlyHead: true,
        onlyEmpty: true
      })
    ];
  }

  doBackgroundWork(deadline) {
    const previousLongestRow = this.getApproximateLongestScreenRow();
    if (this.displayLayer.doBackgroundWork(deadline)) {
      this.backgroundWorkHandle = requestIdleCallback(this.doBackgroundWork);
    } else {
      this.backgroundWorkHandle = null;
    }

    if (
      this.component &&
      this.getApproximateLongestScreenRow() !== previousLongestRow
    ) {
      this.component.scheduleUpdate();
    }
  }

  update(params) {
    const displayLayerParams = {};

    for (let param of Object.keys(params)) {
      const value = params[param];

      switch (param) {
        case 'autoIndent':
          this.updateAutoIndent(value, false);
          break;

        case 'autoIndentOnPaste':
          this.updateAutoIndentOnPaste(value, false);
          break;

        case 'undoGroupingInterval':
          this.updateUndoGroupingInterval(value, false);
          break;

        case 'scrollSensitivity':
          this.updateScrollSensitivity(value, false);
          break;

        case 'encoding':
          this.updateEncoding(value, false);
          break;

        case 'softTabs':
          this.updateSoftTabs(value, false);
          break;

        case 'atomicSoftTabs':
          this.updateAtomicSoftTabs(value, false, displayLayerParams);
          break;

        case 'tabLength':
          this.updateTabLength(value, false, displayLayerParams);
          break;

        case 'softWrapped':
          this.updateSoftWrapped(value, false, displayLayerParams);
          break;

        case 'softWrapHangingIndentLength':
          this.updateSoftWrapHangingIndentLength(
            value,
            false,
            displayLayerParams
          );
          break;

        case 'softWrapAtPreferredLineLength':
          this.updateSoftWrapAtPreferredLineLength(
            value,
            false,
            displayLayerParams
          );
          break;

        case 'preferredLineLength':
          this.updatePreferredLineLength(value, false, displayLayerParams);
          break;

        case 'maxScreenLineLength':
          this.updateMaxScreenLineLength(value, false, displayLayerParams);
          break;

        case 'mini':
          this.updateMini(value, false, displayLayerParams);
          break;

        case 'readOnly':
          this.updateReadOnly(value, false);
          break;

        case 'keyboardInputEnabled':
          this.updateKeyboardInputEnabled(value, false);
          break;

        case 'placeholderText':
          this.updatePlaceholderText(value, false);
          break;

        case 'lineNumberGutterVisible':
          this.updateLineNumberGutterVisible(value, false);
          break;

        case 'showIndentGuide':
          this.updateShowIndentGuide(value, false, displayLayerParams);
          break;

        case 'showLineNumbers':
          this.updateShowLineNumbers(value, false);
          break;

        case 'showInvisibles':
          this.updateShowInvisibles(value, false, displayLayerParams);
          break;

        case 'invisibles':
          this.updateInvisibles(value, false, displayLayerParams);
          break;

        case 'editorWidthInChars':
          this.updateEditorWidthInChars(value, false, displayLayerParams);
          break;

        case 'width':
          this.updateWidth(value, false, displayLayerParams);
          break;

        case 'scrollPastEnd':
          this.updateScrollPastEnd(value, false);
          break;

        case 'autoHeight':
          this.updateAutoHight(value, false);
          break;

        case 'autoWidth':
          this.updateAutoWidth(value, false);
          break;

        case 'showCursorOnSelection':
          this.updateShowCursorOnSelection(value, false);
          break;

        default:
          if (param !== 'ref' && param !== 'key') {
            throw new TypeError(`Invalid TextEditor parameter: '${param}'`);
          }
      }
    }

    return this.finishUpdate(displayLayerParams);
  }

  finishUpdate(displayLayerParams = {}) {
    this.displayLayer.reset(displayLayerParams);

    if (this.component) {
      return this.component.getNextUpdatePromise();
    } else {
      return Promise.resolve();
    }
  }

  updateAutoIndent(value, finish) {
    this.autoIndent = value;
    if (finish) this.finishUpdate();
  }

  updateAutoIndentOnPaste(value, finish) {
    this.autoIndentOnPaste = value;
    if (finish) this.finishUpdate();
  }

  updateUndoGroupingInterval(value, finish) {
    this.undoGroupingInterval = value;
    if (finish) this.finishUpdate();
  }

  updateScrollSensitivity(value, finish) {
    this.scrollSensitivity = value;
    if (finish) this.finishUpdate();
  }

  updateEncoding(value, finish) {
    this.buffer.setEncoding(value);
    if (finish) this.finishUpdate();
  }

  updateSoftTabs(value, finish) {
    if (value !== this.softTabs) {
      this.softTabs = value;
    }
    if (finish) this.finishUpdate();
  }

  updateAtomicSoftTabs(value, finish, displayLayerParams = {}) {
    if (value !== this.displayLayer.atomicSoftTabs) {
      displayLayerParams.atomicSoftTabs = value;
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateTabLength(value, finish, displayLayerParams = {}) {
    if (value > 0 && value !== this.displayLayer.tabLength) {
      displayLayerParams.tabLength = value;
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateSoftWrapped(value, finish, displayLayerParams = {}) {
    if (value !== this.softWrapped) {
      this.softWrapped = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
      this.emitter.emit('did-change-soft-wrapped', this.isSoftWrapped());
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateSoftWrapHangingIndentLength(value, finish, displayLayerParams = {}) {
    if (value !== this.displayLayer.softWrapHangingIndent) {
      displayLayerParams.softWrapHangingIndent = value;
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateSoftWrapAtPreferredLineLength(value, finish, displayLayerParams = {}) {
    if (value !== this.softWrapAtPreferredLineLength) {
      this.softWrapAtPreferredLineLength = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updatePreferredLineLength(value, finish, displayLayerParams = {}) {
    if (value !== this.preferredLineLength) {
      this.preferredLineLength = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateMaxScreenLineLength(value, finish, displayLayerParams = {}) {
    if (value !== this.maxScreenLineLength) {
      this.maxScreenLineLength = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateMini(value, finish, displayLayerParams = {}) {
    if (value !== this.mini) {
      this.mini = value;
      this.emitter.emit('did-change-mini', value);
      displayLayerParams.invisibles = this.getInvisibles();
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
      displayLayerParams.showIndentGuides = this.doesShowIndentGuide();
      if (this.mini) {
        for (let decoration of this.cursorLineDecorations) {
          decoration.destroy();
        }
        this.cursorLineDecorations = null;
      } else {
        this.decorateCursorLine();
      }
      if (this.component != null) {
        this.component.scheduleUpdate();
      }
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateReadOnly(value, finish) {
    if (value !== this.readOnly) {
      this.readOnly = value;
      if (this.component != null) {
        this.component.scheduleUpdate();
      }
    }
    if (finish) this.finishUpdate();
  }

  updateKeyboardInputEnabled(value, finish) {
    if (value !== this.keyboardInputEnabled) {
      this.keyboardInputEnabled = value;
      if (this.component != null) {
        this.component.scheduleUpdate();
      }
    }
    if (finish) this.finishUpdate();
  }

  updatePlaceholderText(value, finish) {
    if (value !== this.placeholderText) {
      this.placeholderText = value;
      this.emitter.emit('did-change-placeholder-text', value);
    }
    if (finish) this.finishUpdate();
  }

  updateLineNumberGutterVisible(value, finish) {
    if (value !== this.lineNumberGutterVisible) {
      if (value) {
        this.lineNumberGutter.show();
      } else {
        this.lineNumberGutter.hide();
      }
      this.emitter.emit(
        'did-change-line-number-gutter-visible',
        this.lineNumberGutter.isVisible()
      );
    }
    if (finish) this.finishUpdate();
  }

  updateShowIndentGuide(value, finish, displayLayerParams = {}) {
    if (value !== this.showIndentGuide) {
      this.showIndentGuide = value;
      displayLayerParams.showIndentGuides = this.doesShowIndentGuide();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateShowLineNumbers(value, finish) {
    if (value !== this.showLineNumbers) {
      this.showLineNumbers = value;
      if (this.component != null) {
        this.component.scheduleUpdate();
      }
    }
    if (finish) this.finishUpdate();
  }

  updateShowInvisibles(value, finish, displayLayerParams = {}) {
    if (value !== this.showInvisibles) {
      this.showInvisibles = value;
      displayLayerParams.invisibles = this.getInvisibles();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateInvisibles(value, finish, displayLayerParams = {}) {
    if (!_.isEqual(value, this.invisibles)) {
      this.invisibles = value;
      displayLayerParams.invisibles = this.getInvisibles();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateEditorWidthInChars(value, finish, displayLayerParams = {}) {
    if (value > 0 && value !== this.editorWidthInChars) {
      this.editorWidthInChars = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateWidth(value, finish, displayLayerParams = {}) {
    if (value !== this.width) {
      this.width = value;
      displayLayerParams.softWrapColumn = this.getSoftWrapColumn();
    }
    if (finish) this.finishUpdate(displayLayerParams);
  }

  updateScrollPastEnd(value, finish) {
    if (value !== this.scrollPastEnd) {
      this.scrollPastEnd = value;
      if (this.component) this.component.scheduleUpdate();
    }
    if (finish) this.finishUpdate();
  }

  updateAutoHight(value, finish) {
    if (value !== this.autoHeight) {
      this.autoHeight = value;
    }
    if (finish) this.finishUpdate();
  }

  updateAutoWidth(value, finish) {
    if (value !== this.autoWidth) {
      this.autoWidth = value;
    }
    if (finish) this.finishUpdate();
  }

  updateShowCursorOnSelection(value, finish) {
    if (value !== this.showCursorOnSelection) {
      this.showCursorOnSelection = value;
      if (this.component) this.component.scheduleUpdate();
    }
    if (finish) this.finishUpdate();
  }

  scheduleComponentUpdate() {
    if (this.component) this.component.scheduleUpdate();
  }

  serialize() {
    return {
      deserializer: 'TextEditor',
      version: SERIALIZATION_VERSION,

      displayLayerId: this.displayLayer.id,
      selectionsMarkerLayerId: this.selectionsMarkerLayer.id,

      initialScrollTopRow: this.getScrollTopRow(),
      initialScrollLeftColumn: this.getScrollLeftColumn(),

      tabLength: this.displayLayer.tabLength,
      atomicSoftTabs: this.displayLayer.atomicSoftTabs,
      softWrapHangingIndentLength: this.displayLayer.softWrapHangingIndent,

      id: this.id,
      bufferId: this.buffer.id,
      softTabs: this.softTabs,
      softWrapped: this.softWrapped,
      softWrapAtPreferredLineLength: this.softWrapAtPreferredLineLength,
      preferredLineLength: this.preferredLineLength,
      mini: this.mini,
      readOnly2: this.readOnly, // readOnly encompassed both readOnly and keyboardInputEnabled
      keyboardInputEnabled: this.keyboardInputEnabled,
      editorWidthInChars: this.editorWidthInChars,
      width: this.width,
      maxScreenLineLength: this.maxScreenLineLength,
