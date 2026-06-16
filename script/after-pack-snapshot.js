'use strict';

// electron-builder `afterPack` hook: generate the V8 startup snapshot and swap
// the packaged Electron's `v8_context_snapshot.bin` (and `snapshot_blob.bin`)
// for our custom blobs, which bake the heavy editor core modules into the V8
// heap. At runtime, static/index.js detects the `snapshotResult` global these
// blobs expose and serves the snapshotted modules from the heap (see
// setupSnapshot there).
//
// This runs after files are copied into the packaged app but while the on-disk
// Electron framework is still writable, so we can replace the blobs in place.
//
// Set PULSAR_SKIP_SNAPSHOT=1 to skip (e.g. for fast local builds).

const fs = require('fs');
const path = require('path');
const generateStartupSnapshot = require('./generate-startup-snapshot');

const BLOBS = ['v8_context_snapshot.bin', 'snapshot_blob.bin'];

// Resolve the directory that holds the Electron V8 snapshot blobs for the
// packaged app on each platform.
function snapshotBlobDir(appOutDir, electronPlatformName, productFilename) {
  if (electronPlatformName === 'darwin' || electronPlatformName === 'mas') {
    return path.join(
      appOutDir,
      `${productFilename}.app`,
      'Contents',
      'Frameworks',
      'Electron Framework.framework',
      'Versions',
      'A',
      'Resources'
    );
  }
  // linux / win32: blobs sit next to the executable.
  return appOutDir;
}

module.exports = async function afterPackSnapshot(context) {
  if (process.env.PULSAR_SKIP_SNAPSHOT === '1') {
    console.log('Skipping V8 startup snapshot (PULSAR_SKIP_SNAPSHOT=1).');
    return;
  }

  const { appOutDir, packager, electronPlatformName } = context;
  const productFilename = packager.appInfo.productFilename;
  const destDir = snapshotBlobDir(
    appOutDir,
    electronPlatformName,
    productFilename
  );

  // Sanity-check the target exists before doing expensive snapshot work.
  const targetBlob = path.join(destDir, 'v8_context_snapshot.bin');
  if (!fs.existsSync(targetBlob)) {
    console.warn(
      `afterPack snapshot: expected blob not found at ${targetBlob}; ` +
        'skipping snapshot replacement.'
    );
    return;
  }

  const outDir = path.join(
    path.resolve(__dirname, '..'),
    'out',
    'snapshot'
  );

  console.log(`Generating V8 startup snapshot for ${electronPlatformName}…`);
  let result;
  try {
    result = await generateStartupSnapshot({ out: outDir, mksnapshot: true });
  } catch (error) {
    // A failed snapshot must not break the whole build — the app still runs,
    // just without the snapshot speedup.
    console.warn(
      `afterPack snapshot: generation failed, shipping stock blobs. ${error.message}`
    );
    return;
  }

  if (!result || !result.binaries) {
    console.warn('afterPack snapshot: no binaries produced; shipping stock blobs.');
    return;
  }

  for (const blob of BLOBS) {
    const src = path.join(outDir, blob);
    const dest = path.join(destDir, blob);
    if (!fs.existsSync(src)) {
      console.warn(`afterPack snapshot: ${blob} not generated; leaving stock.`);
      continue;
    }
    fs.copyFileSync(src, dest);
    console.log(
      `Replaced ${blob} (${(fs.statSync(dest).size / 1024 / 1024).toFixed(
        1
      )} MB) in ${path.relative(appOutDir, dest) || dest}`
    );
  }
};
