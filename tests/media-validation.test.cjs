'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  detectMediaMime,
  isMediaAttachable,
  normalizeMediaUploadInit,
} = require('../dist/modules/media/media-validation.js');

test('REN2-66 accepts only bounded JPEG, PNG, and WebP upload intents', () => {
  const input = { fileName: 'front.png', mimeType: 'image/png', byteLength: 1024, rightsAttested: true };
  assert.deepEqual(normalizeMediaUploadInit(input), {
    fileName: 'front.png', mimeType: 'image/png', byteLength: 1024, rightsAttested: true, sha256: null,
  });
  assert.throws(() => normalizeMediaUploadInit({ ...input, mimeType: 'image/svg+xml' }), { code: 'MEDIA_UPLOAD_INVALID' });
  assert.throws(() => normalizeMediaUploadInit({ ...input, byteLength: 0 }), { code: 'MEDIA_UPLOAD_INVALID' });
  assert.throws(() => normalizeMediaUploadInit({ ...input, byteLength: 10 * 1024 * 1024 + 1 }), { code: 'MEDIA_UPLOAD_INVALID' });
  assert.throws(() => normalizeMediaUploadInit({ ...input, rightsAttested: 'true' }), { code: 'MEDIA_UPLOAD_INVALID' });
});

test('REN2-66 strips path and control characters from the display filename', () => {
  const input = { fileName: '..\\..\\private\u0000front.jpg', mimeType: 'image/jpeg', byteLength: 100, rightsAttested: false };
  assert.equal(normalizeMediaUploadInit(input).fileName, 'privatefront.jpg');
  assert.equal(normalizeMediaUploadInit(input).rightsAttested, false);
});

test('REN2-66 rejects mismatches between declared MIME and file magic', () => {
  assert.equal(detectMediaMime(Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg');
  assert.equal(detectMediaMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
  assert.equal(detectMediaMime(Buffer.from('RIFF0000WEBP')), 'image/webp');
  assert.equal(detectMediaMime(Buffer.from('<svg/>')), null);
});

test('REN2-66 only makes clean, rights-attested, derivative-ready media attachable', () => {
  assert.equal(isMediaAttachable({ scanState: 'CLEAN', rightsState: 'ATTESTED', derivativeState: 'READY' }), true);
  for (const change of [
    { scanState: 'PENDING' }, { scanState: 'REJECTED' }, { rightsState: 'UNVERIFIED' },
    { rightsState: 'REVOKED' }, { derivativeState: 'PENDING' }, { derivativeState: 'FAILED' },
  ]) {
    assert.equal(isMediaAttachable({ scanState: 'CLEAN', rightsState: 'ATTESTED', derivativeState: 'READY', ...change }), false);
  }
});
