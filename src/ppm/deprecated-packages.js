
const semver = require('semver');
let deprecatedPackages = null;

exports.isDeprecatedPackage = function(name, version) {
  // In the ppm submodule this lived one directory up (in `ppm/`); now it
  // sits next to the loader at `src/ppm/deprecated-packages.json`.
  deprecatedPackages ??= require("./deprecated-packages.json") ?? {};
  if (!deprecatedPackages.hasOwnProperty(name)) { return false; }

  const deprecatedVersionRange = deprecatedPackages[name].version;
  if (!deprecatedVersionRange) { return true; }

  return semver.valid(version) && semver.validRange(deprecatedVersionRange) && semver.satisfies(version, deprecatedVersionRange);
};
