'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

let mediaStorageModule;
let mediaStorageLoadError;
try { mediaStorageModule = require('../dist/modules/media/local-media-storage.js'); }
catch (error) { mediaStorageLoadError = error; }

test('local media adapter exports a development-only private storage root and provider', () => {
  assert.equal(typeof mediaStorageModule?.localMediaStorageRoot, 'function', mediaStorageLoadError?.message);
  assert.equal(typeof mediaStorageModule?.LocalMediaStorage, 'function', mediaStorageLoadError?.message);
});

if (mediaStorageModule) {
  const { LocalMediaStorage, localMediaStorageRoot, localMediaObjectPath } = mediaStorageModule;
  const brandId = '11111111-1111-4111-8111-111111111111';
  const assetId = '22222222-2222-4222-8222-222222222222';
  const nonce = '33333333-3333-4333-8333-333333333333';
  const base = path.join(os.tmpdir(), `renivet-media-${process.pid}-${Date.now()}`);
  const configuration = (values) => ({ get: (key) => values[key] });

  test('local media storage stays disabled outside development and defaults outside public assets', () => {
    assert.equal(localMediaStorageRoot({ NODE_ENV: 'test', RENIVET_LOCAL_MEDIA_STORAGE_ENABLED: true }), null);
    assert.equal(localMediaStorageRoot({ NODE_ENV: 'development', RENIVET_LOCAL_MEDIA_STORAGE_ENABLED: false }), null);
    const root = localMediaStorageRoot({ NODE_ENV: 'development', RENIVET_LOCAL_MEDIA_STORAGE_ENABLED: true });
    assert.equal(root, path.resolve('.tmp/media'));
    assert.equal(path.relative(path.resolve('public'), root).startsWith('..'), true);
    assert.throws(() => localMediaStorageRoot({ NODE_ENV: 'development', RENIVET_LOCAL_MEDIA_STORAGE_ENABLED: true,
      RENIVET_LOCAL_MEDIA_STORAGE_DIR: path.resolve('public/uploads') }), /outside public/i);
  });

  test('local media storage safely round trips bounded private objects and rejects invalid keys', async (t) => {
    const storage = new LocalMediaStorage(configuration({ NODE_ENV: 'development',
      RENIVET_LOCAL_MEDIA_STORAGE_ENABLED: true, RENIVET_LOCAL_MEDIA_STORAGE_DIR: base, HOST: '127.0.0.1', PORT: 4000 }));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const key = `brands/${brandId}/media/${assetId}/incoming/${nonce}`;
    const bytes = Buffer.from('private image bytes');
    assert.equal(storage.isConfigured(), true);
    await storage.putPrivateObject({ key, bytes, mimeType: 'image/png', brandId, assetId });
    const metadata = await storage.headObject(key);
    assert.equal(metadata.contentLength, bytes.length);
    assert.equal(metadata.contentType, 'image/png');
    assert.equal(metadata.metadata['renivet-brand-id'], brandId);
    assert.deepEqual(await storage.readObject(key, 1024), bytes);
    assert.equal(localMediaObjectPath(base, key).startsWith(base), true);
    assert.throws(() => localMediaObjectPath(base, `brands/${brandId}/media/${assetId}/../../outside`), /invalid/i);
  });

  test('local upload capabilities bind exact metadata and expire', async (t) => {
    let now = 1_800_000_000_000;
    const storage = new LocalMediaStorage(configuration({ NODE_ENV: 'development',
      RENIVET_LOCAL_MEDIA_STORAGE_ENABLED: true, RENIVET_LOCAL_MEDIA_STORAGE_DIR: base, HOST: '127.0.0.1', PORT: 4000 }));
    Object.defineProperty(storage, 'now', { value: () => now });
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const key = `brands/${brandId}/media/${assetId}/incoming/${nonce}`;
    const bytes = Buffer.from('upload body');
    const intent = await storage.createUploadIntent({ key, mimeType: 'image/png', byteLength: bytes.length,
      brandId, assetId, expiresAt: new Date(now + 60_000).toISOString() });
    const token = intent.headers['x-renivet-local-upload-token'];
    assert.equal(new URL(intent.uploadUrl).pathname.endsWith(`/local-uploads/${assetId}/${nonce}`), true);
    assert.equal(intent.headers['content-length'], undefined, 'browsers set Content-Length and forbid application code from setting it');
    await storage.storeLocalUpload({ key, brandId, assetId, nonce, contentType: 'image/png', contentLength: bytes.length, bytes, capability: token });
    assert.deepEqual(await storage.readObject(key, 1024), bytes);
    await assert.rejects(storage.storeLocalUpload({ key, brandId, assetId, nonce, contentType: 'image/jpeg',
      contentLength: bytes.length, bytes, capability: token }), /capability|metadata/i);
    now += 60_001;
    await assert.rejects(storage.storeLocalUpload({ key, brandId, assetId, nonce, contentType: 'image/png',
      contentLength: bytes.length, bytes, capability: token }), /capability|expired/i);
  });

  test('local media preview URLs are short-lived and signed to one derivative key', async (t) => {
    const storage = new LocalMediaStorage(configuration({ NODE_ENV: 'development',
      RENIVET_LOCAL_MEDIA_STORAGE_ENABLED: true, RENIVET_LOCAL_MEDIA_STORAGE_DIR: base, HOST: '127.0.0.1', PORT: 4000 }));
    Object.defineProperty(storage, 'now', { value: () => 1_800_000_000_000 });
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    const key = `brands/${brandId}/media/${assetId}/derivatives/preview.webp`;
    const bytes = Buffer.from('clean preview bytes');
    await storage.putPrivateObject({ key, bytes, mimeType: 'image/webp', brandId, assetId });
    const url = new URL(await storage.createPreviewUrl(key));
    const token = url.searchParams.get('token');
    assert.equal(Number(token.split('.')[0]), 1_800_000_060_000);
    assert.deepEqual(await storage.readLocalPreview({ key, capability: token }), bytes);
    await assert.rejects(storage.readLocalPreview({ key: `brands/${brandId}/media/${assetId}/original`,
      capability: token }), /capability/i);
  });
}
