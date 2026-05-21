'use strict';

const { EventEmitter } = require('../types/event-emitter');
const { Disposable } = require('../types/disposable');

class TestController {
  constructor(id, label) {
    this.id = id;
    this.label = label;
    this.items = new TestItemCollection();
    this.refreshHandler = undefined;
    this.resolveHandler = undefined;
    this._onDidInvalidateTestResults = new EventEmitter();
    this.onDidInvalidateTestResults = this._onDidInvalidateTestResults.event;
  }

  createTestItem(id, label, uri) {
    return { id, label, uri, children: new TestItemCollection(), tags: [], canResolveChildren: false, busy: false, range: undefined, error: undefined };
  }

  createRunProfile(label, kind, runHandler, isDefault, tag) {
    return { label, kind, isDefault: !!isDefault, tag, runHandler, dispose() {} };
  }

  createTestRun(request, name, persist) {
    return {
      name, isPersisted: !!persist,
      enqueued() {}, started() {}, skipped() {}, failed() {}, errored() {}, passed() {},
      appendOutput() {}, end() {},
      token: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
    };
  }

  invalidateTestResults() {}
  dispose() {}
}

class TestItemCollection {
  constructor() { this._map = new Map(); }
  get size() { return this._map.size; }
  add(item) { this._map.set(item.id, item); }
  delete(id) { this._map.delete(id); }
  get(id) { return this._map.get(id); }
  replace(items) { this._map.clear(); items.forEach(i => this._map.set(i.id, i)); }
  forEach(fn) { this._map.forEach(fn); }
  [Symbol.iterator]() { return this._map.values(); }
}

const TestRunProfileKind = Object.freeze({ Run: 1, Debug: 2, Coverage: 3 });
const TestResultState = Object.freeze({ Queued: 0, Running: 1, Passed: 2, Failed: 3, Errored: 4, Skipped: 5 });
const TestTag = class { constructor(id) { this.id = id; } };

function createTestController(id, label) {
  return new TestController(id, label);
}

module.exports = {
  createTestController,
  TestController,
  TestItemCollection,
  TestRunProfileKind,
  TestResultState,
  TestTag
};
