'use strict';

// a require function with both ES5 and ES6 default export support
function requireModule(modPath) {
  const modul = require(modPath);
  if (modul === null || modul === undefined) {
    return modul;
  }
  if (
    modul.__esModule === true &&
    modul.default !== undefined &&
    modul.default !== null
  ) {
    return modul.default;
  }
  return modul;
}

exports.requireModule = requireModule;
