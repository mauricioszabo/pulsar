const Module = require('module');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

function computeHash(contents) {
  return crypto
    .createHash('sha1')
    .update(contents, 'utf8')
    .digest('hex');
}

class NativeCompileCache {
  constructor() {
    this.cacheStore = null;
    this.previousModuleCompile = null;
    // Observability for the V8 bytecode cache. `hits`/`misses` count whether a
    // cached buffer existed for a module; `rejected` counts buffers that existed
    // but were refused by V8 (e.g. a seed built against a different V8 version),
    // which is the signal that a shipped code-cache seed is dead weight.
    this.cacheStats = { hits: 0, misses: 0, rejected: 0 };
    // Opt-in per-file logging for debugging which modules hit/miss/reject.
    this.verbose = process.env.PULSAR_LOG_V8_CACHE === '1';
  }

  setCacheStore(store) {
    this.cacheStore = store;
  }

  getCacheStats() {
    return this.cacheStats;
  }

  resetCacheStats() {
    this.cacheStats = { hits: 0, misses: 0, rejected: 0 };
  }

  setV8Version(v8Version) {
    this.v8Version = v8Version.toString();
  }

  install() {
    this.savePreviousModuleCompile();
    this.overrideModuleCompile();
  }

  uninstall() {
    this.restorePreviousModuleCompile();
  }

  savePreviousModuleCompile() {
    this.previousModuleCompile = Module.prototype._compile;
  }

  runInThisContext(code, filename) {
    const script = new vm.Script(code, filename);
    const cachedData = script.createCachedData();
    return {
      result: script.runInThisContext(),
      cacheBuffer: typeof cachedData !== 'undefined' ? cachedData : null
    };
  }

  runInThisContextCached(code, filename, cachedData) {
    const script = new vm.Script(code, { filename, cachedData });
    return {
      result: script.runInThisContext(),
      wasRejected: script.cachedDataRejected
    };
  }

  overrideModuleCompile() {
    let self = this;
    // Here we override Node's module.js
    // (https://github.com/atom/node/blob/atom/lib/module.js#L378), changing
    // only the bits that affect compilation in order to use the cached one.
    Module.prototype._compile = function(content, filename) {
      let moduleSelf = this;
      // remove shebang
      content = content.replace(/^#!.*/, '');
      function require(path) {
        return moduleSelf.require(path);
      }
      require.resolve = function(request) {
        return Module._resolveFilename(request, moduleSelf);
      };
      require.main = process.mainModule;

      // Enable support to add extra extension types
      require.extensions = Module._extensions;
      require.cache = Module._cache;

      let dirname = path.dirname(filename);

      // create wrapper function
      let wrapper = Module.wrap(content);

      let cacheKey = computeHash(wrapper + self.v8Version);
      let compiledWrapper = null;
      if (self.cacheStore.has(cacheKey)) {
        let buffer = self.cacheStore.get(cacheKey);
        let compilationResult = self.runInThisContextCached(
          wrapper,
          filename,
          buffer
        );
        compiledWrapper = compilationResult.result;
        if (compilationResult.wasRejected) {
          self.cacheStats.rejected++;
          self.cacheStore.delete(cacheKey);
          if (self.verbose) {
            console.log(`[v8-cache] reject ${filename}`);
          }
        } else {
          self.cacheStats.hits++;
          if (self.verbose) {
            console.log(`[v8-cache] hit    ${filename}`);
          }
        }
      } else {
        self.cacheStats.misses++;
        if (self.verbose) {
          console.log(`[v8-cache] miss   ${filename}`);
        }
        let compilationResult;
        try {
          compilationResult = self.runInThisContext(wrapper, filename);
        } catch (err) {
          console.error(`Error running script ${filename}`);
          throw err;
        }
        if (compilationResult.cacheBuffer) {
          self.cacheStore.set(cacheKey, compilationResult.cacheBuffer);
        }
        compiledWrapper = compilationResult.result;
      }

      let args = [
        moduleSelf.exports,
        require,
        moduleSelf,
        filename,
        dirname,
        process,
        global,
        Buffer
      ];
      return compiledWrapper.apply(moduleSelf.exports, args);
    };
  }

  restorePreviousModuleCompile() {
    Module.prototype._compile = this.previousModuleCompile;
  }
}

module.exports = new NativeCompileCache();
