'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { TaxonomyAdminService } = require('../../dist/modules/catalog/taxonomy-admin.service.js');

test('publish delegates the expected current version and returns the durable publication receipt', async () => {
  const repository = {
    propose: async () => ({ id: 'draft-1', requestId: 'req-1', status: 'draft', rowVersion: 1, diff: { added: [], removed: [], changed: [] } }),
    publish: async () => ({ id: 'event-1', requestId: 'req-2', status: 'published', rowVersion: 1 }),
  };
  const service = new TaxonomyAdminService(repository);
  const receipt = await service.publish({ categoryId: '19f234c6-280a-4b51-9e6f-836f44d2f49d', version: 2 }, { actorId: '19f234c6-280a-4b51-9e6f-836f44d2f49e', requestId: 'req-2', idempotencyKey: 'publish-2' });
  assert.equal(receipt.status, 'published');
  assert.equal(receipt.id, 'event-1');
});

test('publish rejects a stale compare-and-swap and category proposal maps incomplete or retired versions to conflict', async () => {
  const repository = {
    propose: async () => { throw Object.assign(new Error('stale'), { code: 'TAXONOMY_VERSION_CONFLICT' }); },
    publish: async () => { throw Object.assign(new Error('not publishable'), { code: 'TAXONOMY_VERSION_CONFLICT' }); },
  };
  const service = new TaxonomyAdminService(repository);
  const proposal = {
    categoryId: '19f234c6-280a-4b51-9e6f-836f44d2f49d',
    version: 1,
    validatorVersion: 'w2-attribute-validator-v1',
    ruleset: { attributes: [{ attributeId: 'c080b92a-fb86-4360-9b55-c79b402227df', code: 'material', scope: 'product', valueType: 'text' }] },
  };
  const expectedConflict = (error) => error?.getResponse?.().code === 'TAXONOMY_VERSION_CONFLICT';
  await assert.rejects(service.propose(proposal, { actorId: 'actor', requestId: 'req', idempotencyKey: 'key' }), expectedConflict);
  await assert.rejects(service.publish({ categoryId: proposal.categoryId, version: 1 }, { actorId: 'actor', requestId: 'req', idempotencyKey: 'key' }), expectedConflict);
});

test('publish reports an incomplete frozen schema as an unprocessable entity', async () => {
  const service = new TaxonomyAdminService({
    propose: async () => ({}),
    publish: async () => { throw Object.assign(new Error('incomplete'), { code: 'CATEGORY_SCHEMA_INVALID' }); },
  });
  await assert.rejects(
    service.publish(
      { categoryId: '19f234c6-280a-4b51-9e6f-836f44d2f49d', version: 1 },
      { actorId: 'actor', requestId: 'req', idempotencyKey: 'publish-key' },
    ),
    (error) => error?.getStatus?.() === 422 && error?.getResponse?.().code === 'CATEGORY_SCHEMA_INVALID',
  );
});
