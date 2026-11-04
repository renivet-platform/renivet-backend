'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeAttachMedia,
  normalizeUpdateMedia,
  parseProductMediaIfMatch,
} = require('../../dist/modules/media/product-media.service.js');

test('REN2-67 accepts a clean parent image link with its explicit ordering and role', () => {
  assert.deepEqual(normalizeAttachMedia({
    mediaAssetId: '08f1bba5-80a5-4979-8984-84279507eb4f',
    variantId: null,
    displayRole: 'gallery',
    displayOrder: 0,
    altText: 'Front view',
  }), {
    mediaAssetId: '08f1bba5-80a5-4979-8984-84279507eb4f',
    variantId: null,
    displayRole: 'gallery',
    displayOrder: 0,
    altText: 'Front view',
  });
});

test('REN2-67 rejects an invalid asset identifier, order and extra attach fields', () => {
  for (const body of [
    { mediaAssetId: 'not-a-uuid', displayRole: 'gallery', displayOrder: 0 },
    { mediaAssetId: '08f1bba5-80a5-4979-8984-84279507eb4f', displayRole: 'gallery', displayOrder: -1 },
    { mediaAssetId: '08f1bba5-80a5-4979-8984-84279507eb4f', displayRole: 'gallery', displayOrder: 0, brandId: 'attacker' },
  ]) assert.throws(() => normalizeAttachMedia(body), { code: 'PRODUCT_MEDIA_INVALID' });
});

test('REN2-67 accepts only a non-empty supported media-link patch', () => {
  assert.deepEqual(normalizeUpdateMedia({ displayOrder: 2, altText: 'Side view' }), { displayOrder: 2, altText: 'Side view' });
  for (const body of [{}, { displayOrder: -1 }, { unknown: true }, { displayRole: '' }]) {
    assert.throws(() => normalizeUpdateMedia(body), { code: 'PRODUCT_MEDIA_INVALID' });
  }
});

test('REN2-67 requires a quoted positive If-Match version for update and detach', () => {
  assert.equal(parseProductMediaIfMatch('"17"'), 17);
  for (const value of [undefined, '17', 'W/"17"', '"0"', '"1", "2"']) {
    assert.throws(() => parseProductMediaIfMatch(value), { code: 'PRODUCT_MEDIA_IF_MATCH_INVALID' });
  }
});
