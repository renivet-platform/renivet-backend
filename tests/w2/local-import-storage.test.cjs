const test = require('node:test');
const assert = require('node:assert/strict');
const {
  localImportStorageRoot,
  localImportObjectPath,
  createLocalUploadToken,
  verifyLocalUploadToken,
} = require('../../dist/modules/imports/local-import-storage.js');

test('local import storage is enabled only in development', () => {
  assert.equal(localImportStorageRoot({ NODE_ENV: 'production', RENIVET_LOCAL_IMPORT_STORAGE_ENABLED: true }), null);
  assert.match(localImportStorageRoot({ NODE_ENV: 'development', RENIVET_LOCAL_IMPORT_STORAGE_ENABLED: true, RENIVET_LOCAL_IMPORT_STORAGE_DIR: '.tmp/imports' }), /tmp[\\/]imports$/);
  assert.equal(localImportStorageRoot({ NODE_ENV: 'development', RENIVET_LOCAL_IMPORT_STORAGE_ENABLED: false }), null);
});

test('local import object paths stay inside the configured root', () => {
  const root = localImportStorageRoot({ NODE_ENV: 'development', RENIVET_LOCAL_IMPORT_STORAGE_ENABLED: true, RENIVET_LOCAL_IMPORT_STORAGE_DIR: '.tmp/imports' });
  const objectPath = localImportObjectPath(root, '7b4c5c92-3c49-47b7-82fc-6978acee421b', '191ae7f1-b7d6-43f2-94e8-8c2fb970e719');
  assert.match(objectPath, /brands[\\/]7b4c5c92-3c49-47b7-82fc-6978acee421b[\\/]imports[\\/]191ae7f1-b7d6-43f2-94e8-8c2fb970e719[\\/]source$/);
  assert.throws(() => localImportObjectPath(root, '../escape', '191ae7f1-b7d6-43f2-94e8-8c2fb970e719'));
});

test('local upload capability is bound to metadata and expiry', () => {
  const token = createLocalUploadToken('secret', 'brand', 'upload', 'hash', 1_900_000_000_000);
  assert.equal(verifyLocalUploadToken('secret', token, 'brand', 'upload', 'hash', 1_899_999_999_000), true);
  assert.equal(verifyLocalUploadToken('wrong', token, 'brand', 'upload', 'hash', 1_899_999_999_000), false);
  assert.equal(verifyLocalUploadToken('secret', token, 'brand', 'upload', 'other', 1_899_999_999_000), false);
  assert.equal(verifyLocalUploadToken('secret', token, 'brand', 'upload', 'hash', 1_900_000_001_000), false);
});
