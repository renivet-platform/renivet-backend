'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const modulePath = '../../dist/modules/catalog/catalog-publication.js';
const publicationModule = fs.existsSync(path.join(__dirname, modulePath)) ? require(modulePath) : {};
const { validatePublicationInput, CatalogPublicationService } = publicationModule;

const PRODUCT = '11111111-1111-4111-8111-111111111111';
const BRAND = '22222222-2222-4222-8222-222222222222';
const REVISION = '33333333-3333-4333-8333-333333333333';
const REVIEW = '44444444-4444-4444-8444-444444444444';

test('REN2-73 validates exact approved revision ids, positive CAS, and reasoned restriction metadata', () => {
  assert.equal(typeof validatePublicationInput, 'function', 'publication input validator must be implemented');
  assert.throws(() => validatePublicationInput('PUBLISH', { approvedRevisionId: 'bad', approvedReviewId: REVIEW }, {
    userId: PRODUCT, brandId: BRAND, expectedProductVersion: 0, idempotencyKey: 'publish-1',
  }), { code: 'CATALOG_PUBLICATION_REQUEST_INVALID' });
  assert.throws(() => validatePublicationInput('RESTRICT', { reasonCode: ' ' }, {
    userId: PRODUCT, brandId: BRAND, expectedProductVersion: 1, idempotencyKey: 'restrict-1',
  }), { code: 'CATALOG_PUBLICATION_REQUEST_INVALID' });
  assert.deepEqual(validatePublicationInput('RESTRICT', { reasonCode: 'SAFETY_RECALL', appealReference: 'CASE-733', comment: 'Remove while investigated.' }, {
    userId: PRODUCT, brandId: BRAND, expectedProductVersion: 3, idempotencyKey: 'restrict-1',
  }).input, { reasonCode: 'SAFETY_RECALL', appealReference: 'CASE-733', comment: 'Remove while investigated.' });
});

test('REN2-73 publication service validates caller context before any repository write', async () => {
  assert.equal(typeof CatalogPublicationService, 'function', 'publication service must be implemented');
  const calls = [];
  const service = new CatalogPublicationService({
    publish: async (...args) => { calls.push(['publish', ...args]); return { status: 'PUBLISHED' }; },
    restrict: async (...args) => { calls.push(['restrict', ...args]); return { status: 'RESTRICTED' }; },
    unpublish: async (...args) => { calls.push(['unpublish', ...args]); return { status: 'APPROVED' }; },
  });
  const context = { userId: PRODUCT, brandId: BRAND, expectedProductVersion: 2, idempotencyKey: 'key-1' };
  await assert.rejects(service.publish(PRODUCT, { approvedRevisionId: REVISION, approvedReviewId: REVIEW }, { ...context, expectedProductVersion: 0 }),
    { code: 'CATALOG_PUBLICATION_REQUEST_INVALID' });
  assert.equal(calls.length, 0);
  assert.deepEqual(await service.publish(PRODUCT, { approvedRevisionId: REVISION, approvedReviewId: REVIEW }, context), { status: 'PUBLISHED' });
  assert.deepEqual(await service.unpublish(PRODUCT, { reasonCode: 'SELLER_REQUEST' }, context), { status: 'APPROVED' });
  assert.equal(calls.length, 2);
});

test('REN2-73 migration binds versioned lifecycle events, immutable receipts, and global or brand permissions', () => {
  const migration = fs.readFileSync(path.join(__dirname, '../../drizzle/0023_ren2_73_catalog_publication.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE catalogue\.publication_command_receipts/i);
  assert.match(migration, /BEFORE UPDATE OR DELETE/i);
  assert.match(migration, /catalog\.publish/i);
  assert.match(migration, /catalog\.restrict/i);
  assert.match(migration, /appeal_reference/i);
  assert.match(migration, /UNIQUE\(brand_id,product_id,actor_user_id,operation,idempotency_key\)/i);
  assert.match(migration, /publication_version\s*=\s*NEW\.publication_version/i);
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/i);
  assert.doesNotMatch(migration, /INSERT INTO access\.role_permissions/i, 'migration must not grant publish or restrict permission to a role');
});

