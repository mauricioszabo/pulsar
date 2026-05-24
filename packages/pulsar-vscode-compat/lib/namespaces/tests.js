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
    return new TestRunProfile(this, label, kind, runHandler, isDefault, tag);
  }

  createTestRun(request, name, persist) {
    return new TestRun(request, name, persist);
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
  forEach(fn) { this._map.forEach(item => fn(item, this)); }
  [Symbol.iterator]() { return this._map.values(); }
}

class TestTag {
  constructor(id) {
    this.id = id;
  }
}

class TestMessage {
  constructor(message) {
    this.message = message;
    this.expectedOutput = undefined;
    this.actualOutput = undefined;
    this.location = undefined;
  }

  static diff(message, expected, actual) {
    const testMessage = new TestMessage(message);
    testMessage.expectedOutput = expected;
    testMessage.actualOutput = actual;
    return testMessage;
  }
}

class TestRunRequest {
  constructor(include, exclude, profile, continuous) {
    this.include = include;
    this.exclude = exclude;
    this.profile = profile;
    this.continuous = !!continuous;
  }
}

class TestRunProfile {
  constructor(controller, label, kind, runHandler, isDefault, tag) {
    this.controller = controller;
    this.label = label;
    this.kind = kind;
    this.runHandler = runHandler;
    this.isDefault = !!isDefault;
    this.tag = tag;
    this.configureHandler = undefined;
    this.loadDetailedCoverage = undefined;
    this.supportsContinuousRun = false;
  }

  dispose() {}
}

class TestRun {
  constructor(request, name, persist) {
    this.request = request;
    this.name = name;
    this.isPersisted = !!persist;
    this.token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  }

  enqueued() {}
  started() {}
  skipped() {}
  failed() {}
  errored() {}
  passed() {}
  appendOutput() {}
  end() {}
}

const TestRunProfileKind = Object.freeze({ Run: 1, Debug: 2, Coverage: 3 });
const TestResultState = Object.freeze({ Queued: 0, Running: 1, Passed: 2, Failed: 3, Errored: 4, Skipped: 5 });

function createTestController(id, label) {
  return new TestController(id, label);
}

module.exports = {
  createTestController,
  TestController,
  TestItemCollection,
  TestRun,
  TestRunProfile,
  TestRunProfileKind,
  TestRunRequest,
  TestResultState,
  TestMessage,
  TestTag
};
