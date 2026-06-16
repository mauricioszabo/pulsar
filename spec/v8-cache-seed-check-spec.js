// Validation spec for the shipped V8 cache seed. Run this against a clean
// ATOM_HOME with PULSAR_V8_SEED_DIR pointing at a seed directory: it reports the
// hit/miss/reject counts the boot path accumulated. A healthy seed yields many
// hits and ~zero rejects; a seed built against a different V8 yields all rejects.
//
// Used by script/check-v8-cache-seed.js as the CI guard against shipping a stale
// (wrong-V8) seed.

const NativeCompileCache = require('../src/native-compile-cache');

describe('V8 cache seed', () => {
  it('is consumed by the boot path', () => {
    const stats = NativeCompileCache.getCacheStats();
    const total = stats.hits + stats.misses + stats.rejected;

    // Emit a machine-parseable line for the CI checker.
    console.log(
      `V8_SEED_STATS ${JSON.stringify({
        hits: stats.hits,
        misses: stats.misses,
        rejected: stats.rejected,
        total
      })}`
    );

    expect(total).toBeGreaterThan(0);
  });
});
