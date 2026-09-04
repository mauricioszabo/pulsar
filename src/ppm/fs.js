// Thin wrapper that adds a few helpers on top of `fs-plus`, ported from
// ppm/src/fs.js but using node's built-in recursive copy instead of `ncp`
// and `wrench`.

const fs = require('fs-plus');
const fsPromises = require('fs/promises');
const path = require('path');

const fsAdditions = {
  list(directoryPath) {
    if (fs.isDirectorySync(directoryPath)) {
      try { return fs.readdirSync(directoryPath); }
      catch (_) { return []; }
    }
    return [];
  },

  async cp(sourcePath, destinationPath) {
    await fsPromises.rm(destinationPath, { recursive: true, force: true });
    await fsPromises.cp(sourcePath, destinationPath, { recursive: true, force: true });
  },

  async mv(sourcePath, destinationPath) {
    await fsPromises.rm(destinationPath, { recursive: true, force: true });
    await fsPromises.mkdir(path.dirname(destinationPath), { recursive: true });
    await fsPromises.rename(sourcePath, destinationPath);
  }
};

module.exports = new Proxy({}, {
  get(_t, key) { return fsAdditions[key] || fs[key]; },
  set(_t, key, value) { return (fsAdditions[key] = value); }
});
