'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const JSZip = require('jszip');
const { ingestImageZip, resolvePublicHttpsUrl, fetchPublicHttpsImage } = require('../dist/modules/media/media-zip-ingestion.js');

const brandId = 'c6ec20f1-05c6-4f44-bf0d-4c60c6d4b80f';
const productId = '6b837a82-8d61-4d5d-9c31-e2222b6f3239';
const batchId = '89166b6c-0310-4268-8e56-8f2fa7892658';
const variantId = '1b837a82-8d61-4d5d-9c31-e2222b6f3239';
const manifest = { SKU1: { productId, variantId } };
const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4]);

async function archive(files) {
  const zip = new JSZip();
  for (const [name, bytes] of Object.entries(files)) zip.file(name, bytes);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

test('REN2-82 rejects traversal and validates the full archive before any effects', async () => {
  const bytes = await archive({ 'SKU1__01.png': png, '../SKU1__02.png': png });
  let effects = 0;
  await assert.rejects(ingestImageZip({ bytes, brandId, batchId, manifest,
    resolveProducts: async () => ({ SKU1: { brandId, productId, variantId, sku: 'SKU1' } }), processImage: async () => { effects++; } }),
  { code: 'MEDIA_ZIP_UNSAFE' });
  assert.equal(effects, 0);
});

test('REN2-82 maps SKU__NN deterministically and emits one idempotency receipt key per image', async () => {
  const bytes = await archive({ 'SKU1__02.png': png, 'SKU1__01.png': png });
  const seen = [];
  const result = await ingestImageZip({ bytes, brandId, batchId, manifest,
    resolveProducts: async () => ({ SKU1: { brandId, productId, variantId, sku: 'SKU1' } }),
    processImage: async (image) => { seen.push(image); } });
  assert.deepEqual(seen.map((item) => item.slot).sort(), [1, 2]);
  assert.equal(new Set(seen.map((item) => item.effectKey)).size, 2);
  assert.equal(result.processed, 2);
});

test('REN2-82 rejects a foreign-brand manifest target before processing', async () => {
  const bytes = await archive({ 'SKU1__01.png': png });
  let effects = 0;
  await assert.rejects(ingestImageZip({ bytes, brandId, batchId, manifest,
    resolveProducts: async () => ({ SKU1: { brandId: 'a0f99918-0d15-4d0a-b53f-0d017c5272dd', productId, variantId, sku: 'SKU1' } }),
    processImage: async () => { effects++; } }), { code: 'MEDIA_ZIP_TARGET_INVALID' });
  assert.equal(effects, 0);
});

test('REN2-82 processes a synthetic 12,000-image batch with bounded worker concurrency', async () => {
  const skus = Array.from({ length: 12_000 }, (_, i) => `SKU${String(i + 1).padStart(5, '0')}`);
  const productBySku = Object.fromEntries(skus.map((sku, i) => [sku, {
    productId: `00000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, '0')}`,
    variantId: `00000000-0000-4001-8000-${(i + 1).toString(16).padStart(12, '0')}`,
  }]));
  const files = Object.fromEntries(skus.map((sku) => [`${sku}__01.png`, png]));
  const bytes = await archive(files);
  let active = 0, peak = 0;
  const result = await ingestImageZip({ bytes, brandId, batchId, manifest: productBySku,
    concurrency: 3,
    resolveProducts: async (_brandId, mappings) => Object.fromEntries(Object.entries(mappings).map(([sku, mapping]) => [sku,
      { brandId, productId: mapping.productId, variantId: mapping.variantId, sku }])),
    processImage: async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 0)); active--; } });
  assert.equal(result.processed, 12_000);
  assert.ok(peak <= 3);
});

test('REN2-82 rejects private, non-HTTPS, credentialed, and mixed DNS URL targets', async () => {
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  await assert.rejects(resolvePublicHttpsUrl('http://example.com/a', publicLookup), { code: 'MEDIA_URL_UNSAFE' });
  await assert.rejects(resolvePublicHttpsUrl('https://user@example.com/a', publicLookup), { code: 'MEDIA_URL_UNSAFE' });
  await assert.rejects(resolvePublicHttpsUrl('https://example.com/a', async () => [{ address: '127.0.0.1', family: 4 }]), { code: 'MEDIA_URL_UNSAFE' });
  await assert.rejects(resolvePublicHttpsUrl('https://example.com/a', async () => [
    { address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 },
  ]), { code: 'MEDIA_URL_UNSAFE' });
  const safe = await resolvePublicHttpsUrl('https://example.com/a', publicLookup);
  assert.equal(safe.address, '93.184.216.34');
});

test('REN2-82 remote media fetch refuses redirects and enforces the body limit', async () => {
  await assert.rejects(fetchPublicHttpsImage('https://example.com/image.png', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: async () => ({ statusCode: 302, headers: { location: 'https://example.com/other' }, body: Buffer.alloc(0) }),
  }), { code: 'MEDIA_URL_REDIRECT_REJECTED' });
  await assert.rejects(fetchPublicHttpsImage('https://example.com/image.png', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    maxBytes: 4,
    request: async () => ({ statusCode: 200, headers: { 'content-type': 'image/png' }, body: Buffer.alloc(5) }),
  }), { code: 'MEDIA_URL_LIMIT_EXCEEDED' });
});

test('REN2-82 treats HTTPS request timeouts as retryable fetch failures', async () => {
  const https = require('node:https');
  const { EventEmitter } = require('node:events');
  const originalRequest = https.request;
  https.request = () => {
    const request = new EventEmitter();
    request.end = () => request.emit('timeout');
    request.destroy = (error) => queueMicrotask(() => request.emit('error', error));
    return request;
  };
  try {
    await assert.rejects(fetchPublicHttpsImage('https://example.com/image.png', {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    }), (error) => error.code === 'MEDIA_URL_TIMEOUT' && error.retryable === true);
  } finally {
    https.request = originalRequest;
  }
});
