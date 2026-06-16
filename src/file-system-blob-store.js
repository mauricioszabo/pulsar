'use strict';

const fs = require('fs-plus');
const path = require('path');

module.exports = class FileSystemBlobStore {
  static load(directory, fallbackDirectory) {
    let instance = new FileSystemBlobStore(directory, fallbackDirectory);
    instance.load();
    return instance;
  }

  constructor(directory, fallbackDirectory) {
    this.blobFilename = path.join(directory, 'BLOB');
    this.blobMapFilename = path.join(directory, 'MAP');
    this.lockFilename = path.join(directory, 'LOCK');
    // An optional read-only seed shipped inside the app. It is only consulted
    // when the writable store has no data yet (a fresh install / post-update),
    // so the first launch gets V8 bytecode cache hits instead of recompiling.
    // Writes always go to the writable `directory`, never here.
    if (fallbackDirectory) {
      this.fallbackBlobFilename = path.join(fallbackDirectory, 'BLOB');
      this.fallbackBlobMapFilename = path.join(fallbackDirectory, 'MAP');
    }
    this.reset();
  }

  reset() {
    this.inMemoryBlobs = new Map();
    this.storedBlob = Buffer.alloc(0);
    this.storedBlobMap = {};
    this.usedKeys = new Set();
  }

  load() {
    let blobFilename = this.blobFilename;
    let blobMapFilename = this.blobMapFilename;

    // Fall back to the shipped seed only when the writable store is empty.
    if (
      (!fs.existsSync(blobMapFilename) || !fs.existsSync(blobFilename)) &&
      this.fallbackBlobFilename &&
      fs.existsSync(this.fallbackBlobMapFilename) &&
      fs.existsSync(this.fallbackBlobFilename)
    ) {
      blobFilename = this.fallbackBlobFilename;
      blobMapFilename = this.fallbackBlobMapFilename;
    }

    if (!fs.existsSync(blobMapFilename)) {
      return;
    }
    if (!fs.existsSync(blobFilename)) {
      return;
    }

    try {
      this.storedBlob = fs.readFileSync(blobFilename);
      this.storedBlobMap = JSON.parse(fs.readFileSync(blobMapFilename));
    } catch (e) {
      this.reset();
    }
  }

  save() {
    let dump = this.getDump();
    let blobToStore = Buffer.concat(dump[0]);
    let mapToStore = JSON.stringify(dump[1]);

    let acquiredLock = false;
    try {
      fs.writeFileSync(this.lockFilename, 'LOCK', { flag: 'wx' });
      acquiredLock = true;

      fs.writeFileSync(this.blobFilename, blobToStore);
      fs.writeFileSync(this.blobMapFilename, mapToStore);
    } catch (error) {
      // Swallow the exception silently only if we fail to acquire the lock.
      if (error.code !== 'EEXIST') {
        throw error;
      }
    } finally {
      if (acquiredLock) {
        fs.unlinkSync(this.lockFilename);
      }
    }
  }

  has(key) {
    return (
      this.inMemoryBlobs.has(key) || this.storedBlobMap.hasOwnProperty(key)
    );
  }

  get(key) {
    if (this.has(key)) {
      this.usedKeys.add(key);
      return this.getFromMemory(key) || this.getFromStorage(key);
    }
  }

  set(key, buffer) {
    this.usedKeys.add(key);
    return this.inMemoryBlobs.set(key, buffer);
  }

  delete(key) {
    this.inMemoryBlobs.delete(key);
    delete this.storedBlobMap[key];
  }

  getFromMemory(key) {
    return this.inMemoryBlobs.get(key);
  }

  getFromStorage(key) {
    if (!this.storedBlobMap[key]) {
      return;
    }

    return this.storedBlob.slice.apply(
      this.storedBlob,
      this.storedBlobMap[key]
    );
  }

  getDump() {
    let buffers = [];
    let blobMap = {};
    let currentBufferStart = 0;

    function dump(key, getBufferByKey) {
      let buffer = getBufferByKey(key);
      buffers.push(buffer);
      blobMap[key] = [currentBufferStart, currentBufferStart + buffer.length];
      currentBufferStart += buffer.length;
    }

    for (let key of this.inMemoryBlobs.keys()) {
      if (this.usedKeys.has(key)) {
        dump(key, this.getFromMemory.bind(this));
      }
    }

    for (let key of Object.keys(this.storedBlobMap)) {
      if (!blobMap[key] && this.usedKeys.has(key)) {
        dump(key, this.getFromStorage.bind(this));
      }
    }

    return [buffers, blobMap];
  }
};
