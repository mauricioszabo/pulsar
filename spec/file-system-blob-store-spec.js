const temp = require('temp').track();
const path = require('path');
const fs = require('fs-plus');
const FileSystemBlobStore = require('../src/file-system-blob-store');

describe('FileSystemBlobStore', function() {
  let [storageDirectory, blobStore] = [];

  beforeEach(function() {
    storageDirectory = temp.path('atom-spec-filesystemblobstore');
    blobStore = FileSystemBlobStore.load(storageDirectory);
  });

  afterEach(() => fs.removeSync(storageDirectory));

  it("is empty when the file doesn't exist", function() {
    expect(blobStore.get('foo')).toBeUndefined();
    expect(blobStore.get('bar')).toBeUndefined();
  });

  it('allows to read and write buffers from/to memory without persisting them', function() {
    blobStore.set('foo', Buffer.from('foo'));
    blobStore.set('bar', Buffer.from('bar'));

    expect(blobStore.get('foo')).toEqual(Buffer.from('foo'));
    expect(blobStore.get('bar')).toEqual(Buffer.from('bar'));

    expect(blobStore.get('baz')).toBeUndefined();
    expect(blobStore.get('qux')).toBeUndefined();
  });

  it('persists buffers when saved and retrieves them on load, giving priority to in-memory ones', function() {
    blobStore.set('foo', Buffer.from('foo'));
    blobStore.set('bar', Buffer.from('bar'));
    blobStore.save();

    blobStore = FileSystemBlobStore.load(storageDirectory);

    expect(blobStore.get('foo')).toEqual(Buffer.from('foo'));
    expect(blobStore.get('bar')).toEqual(Buffer.from('bar'));
    expect(blobStore.get('baz')).toBeUndefined();
    expect(blobStore.get('qux')).toBeUndefined();

    blobStore.set('foo', Buffer.from('changed'));

    expect(blobStore.get('foo')).toEqual(Buffer.from('changed'));
  });

  it('persists in-memory and previously stored buffers, and deletes unused keys when saved', function() {
    blobStore.set('foo', Buffer.from('foo'));
    blobStore.set('bar', Buffer.from('bar'));
    blobStore.save();

    blobStore = FileSystemBlobStore.load(storageDirectory);
    blobStore.set('bar', Buffer.from('changed'));
    blobStore.set('qux', Buffer.from('qux'));
    blobStore.save();

    blobStore = FileSystemBlobStore.load(storageDirectory);

    expect(blobStore.get('foo')).toBeUndefined();
    expect(blobStore.get('bar')).toEqual(Buffer.from('changed'));
    expect(blobStore.get('qux')).toEqual(Buffer.from('qux'));
  });

  it('allows to delete keys from both memory and stored buffers', function() {
    blobStore.set('a', Buffer.from('a'));
    blobStore.set('b', Buffer.from('b'));
    blobStore.save();

    blobStore = FileSystemBlobStore.load(storageDirectory);

    blobStore.get('a'); // prevent the key from being deleted on save
    blobStore.set('b', Buffer.from('b'));
    blobStore.set('c', Buffer.from('c'));
    blobStore.delete('b');
    blobStore.delete('c');
    blobStore.save();

    blobStore = FileSystemBlobStore.load(storageDirectory);

    expect(blobStore.get('a')).toEqual(Buffer.from('a'));
    expect(blobStore.get('b')).toBeUndefined();
    expect(blobStore.get('b')).toBeUndefined();
    expect(blobStore.get('c')).toBeUndefined();
  });

  it('ignores errors when loading an invalid blob store', function() {
    blobStore.set('a', Buffer.from('a'));
    blobStore.set('b', Buffer.from('b'));
    blobStore.save();

    // Simulate corruption
    fs.writeFileSync(path.join(storageDirectory, 'MAP'), Buffer.from([0]));
    fs.writeFileSync(path.join(storageDirectory, 'INVKEYS'), Buffer.from([0]));
    fs.writeFileSync(path.join(storageDirectory, 'BLOB'), Buffer.from([0]));

    blobStore = FileSystemBlobStore.load(storageDirectory);

    expect(blobStore.get('a')).toBeUndefined();
    expect(blobStore.get('b')).toBeUndefined();

    blobStore.set('a', Buffer.from('x'));
    blobStore.set('b', Buffer.from('y'));
    blobStore.save();

    blobStore = FileSystemBlobStore.load(storageDirectory);

    expect(blobStore.get('a')).toEqual(Buffer.from('x'));
    expect(blobStore.get('b')).toEqual(Buffer.from('y'));
  });

  describe('with a read-only fallback seed', function() {
    let fallbackDirectory;

    beforeEach(function() {
      fallbackDirectory = temp.path('atom-spec-blobstore-seed');
      // Build a seed by saving a store, then point new stores at it as fallback.
      const seed = FileSystemBlobStore.load(fallbackDirectory);
      seed.set('seeded', Buffer.from('seeded-value'));
      seed.save();
    });

    afterEach(() => fs.removeSync(fallbackDirectory));

    it('reads from the seed when the writable store is empty', function() {
      blobStore = FileSystemBlobStore.load(storageDirectory, fallbackDirectory);
      expect(blobStore.get('seeded')).toEqual(Buffer.from('seeded-value'));
    });

    it('prefers the writable store over the seed when both exist', function() {
      blobStore.set('seeded', Buffer.from('writable-value'));
      blobStore.save();

      blobStore = FileSystemBlobStore.load(storageDirectory, fallbackDirectory);
      expect(blobStore.get('seeded')).toEqual(Buffer.from('writable-value'));
    });

    it('never writes to the seed directory', function() {
      blobStore = FileSystemBlobStore.load(storageDirectory, fallbackDirectory);
      blobStore.get('seeded'); // mark as used so it would be dumped on save
      blobStore.set('fresh', Buffer.from('fresh-value'));
      blobStore.save();

      // The seed's BLOB must be untouched; the new data lands in the writable dir.
      const seedBlob = fs.readFileSync(path.join(fallbackDirectory, 'BLOB'));
      expect(seedBlob).toEqual(Buffer.from('seeded-value'));

      const reloaded = FileSystemBlobStore.load(storageDirectory);
      expect(reloaded.get('fresh')).toEqual(Buffer.from('fresh-value'));
    });

    it('is a no-op when neither writable store nor seed exist', function() {
      const missingSeed = temp.path('atom-spec-blobstore-missing-seed');
      blobStore = FileSystemBlobStore.load(storageDirectory, missingSeed);
      expect(blobStore.get('seeded')).toBeUndefined();
    });
  });
});
