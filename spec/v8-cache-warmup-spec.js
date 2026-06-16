// Warm-up spec used by script/generate-v8-cache-seed.js. Running the spec suite
// boots a real AtomEnvironment through static/index.js, which installs
// NativeCompileCache against the real blob store and compiles the startup module
// graph — populating the in-memory V8 bytecode cache. The test runner does not
// flush the blob store on exit, so we flush it explicitly here, then assert the
// cache was actually populated so a broken warm-up fails loudly instead of
// shipping an empty seed.
//
// This is not a behavioural test of the editor; it exists to produce and sanity
// check the seed artifact.

const NativeCompileCache = require('../src/native-compile-cache');

describe('V8 cache warm-up', () => {
  it('populates and flushes the V8 bytecode cache', () => {
    const stats = NativeCompileCache.getCacheStats();

    // The boot path must have compiled real modules into the cache. On a cold
    // ATOM_HOME this is all misses (which become cache entries on save).
    const touched = stats.hits + stats.misses + stats.rejected;
    expect(touched).toBeGreaterThan(0);

    // Flush the real blob store the renderer has been writing to. `atom` here is
    // the test environment, whose blobStore is the same instance static/index.js
    // loaded and NativeCompileCache has been writing into.
    expect(atom.blobStore).toBeTruthy();
    atom.blobStore.save();
  });
});
