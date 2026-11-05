'use strict';

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const test = require('node:test');
const { canonicalizeSnapshot, snapshotSha256 } = require('../../dist/modules/catalog/catalog-submission.js');
const { buildProductSearchDocument, CatalogSearchProjectionConsumer, parsePublicationProjectionEvent } = require('../../dist/modules/catalog/catalog-search-projection.js');
const { TypesenseProductSearchClient } = require('../../dist/workers/typesense-product-search.js');

const BRAND = '22222222-2222-4222-8222-222222222222';
const PRODUCT = '11111111-1111-4111-8111-111111111111';
const REVISION = '33333333-3333-4333-8333-333333333333';
const REVIEW = '44444444-4444-4444-8444-444444444444';
const UUID = () => randomUUID();

function event(lifecycleEvent = 'PUBLISH', publicationVersion = 2) {
  const eventId = UUID();
  const publicationState = lifecycleEvent === 'PUBLISH' ? 'PUBLISHED' : lifecycleEvent === 'RESTRICT' ? 'RESTRICTED' : 'APPROVED';
  const payload = { eventId, lifecycleEvent, brandId: BRAND, productId: PRODUCT, revisionId: REVISION, reviewId: REVIEW,
    contentVersion: 1, publicationVersion, publicationState, contentSha256: 'a'.repeat(64), reasonCode: lifecycleEvent === 'PUBLISH' ? 'QC_APPROVED' : 'SAFETY_RECALL', appealReference: null };
  payload.payloadSha256 = createHash('sha256').update(canonicalizeSnapshot(payload)).digest('hex');
  return { id: eventId, eventType: `catalogue.product.${lifecycleEvent.toLowerCase() === 'publish' ? 'published' : lifecycleEvent.toLowerCase() === 'restrict' ? 'restricted' : 'unpublished'}`,
    eventVersion: 1, aggregateType: 'catalogue.product', aggregateId: PRODUCT, eventPayload: payload };
}

test('REN2-74 freezes and validates the v1 publication event, including payload hash and aggregate binding', () => {
  const valid = event(); assert.equal(parsePublicationProjectionEvent(valid).lifecycleEvent, 'PUBLISH');
  assert.throws(() => parsePublicationProjectionEvent({ ...valid, eventVersion: 2 }), { code: 'CATALOG_PROJECTION_EVENT_INVALID' });
  assert.throws(() => parsePublicationProjectionEvent({ ...valid, eventPayload: { ...valid.eventPayload, brandId: PRODUCT } }),
    { code: 'CATALOG_PROJECTION_EVENT_HASH_INVALID' });
  assert.throws(() => parsePublicationProjectionEvent({ ...valid, eventPayload: { ...valid.eventPayload, extra: true } }),
    { code: 'CATALOG_PROJECTION_EVENT_INVALID' });
});

test('REN2-74 builds a deterministic public search document from the immutable approved snapshot', () => {
  const snapshot = { product: { id: PRODUCT, brandId: BRAND, categoryId: UUID(), styleCode: 'S-01', title: 'Recycled cotton tee',
    description: 'Blue cotton shirt', contentVersion: 1 }, attributes: { color: 'blue', size: 2 },
    variants: [{ sku: 'TEE-S' }, { sku: 'TEE-M' }] };
  const document = buildProductSearchDocument({ productId: PRODUCT, brandId: BRAND, publicationVersion: 2,
    revisionId: REVISION, contentSha256: snapshotSha256(snapshot), contentSnapshot: snapshot });
  assert.equal(document.id, PRODUCT); assert.equal(document.publication_version, 2);
  assert.equal(document.searchable_text, 'Recycled cotton tee Blue cotton shirt S-01 TEE-M TEE-S blue 2');
  assert.throws(() => buildProductSearchDocument({ productId: PRODUCT, brandId: BRAND, publicationVersion: 2,
    revisionId: REVISION, contentSha256: 'b'.repeat(64), contentSnapshot: snapshot }), { code: 'CATALOG_PROJECTION_REVISION_INVALID' });
});

test('REN2-74 delayed publish after current restriction tombstones latest state and same-version replay makes no second index call', async () => {
  const sourceEvent = event('PUBLISH', 2); const calls = [];
  const search = { upsert: async (document) => calls.push(['upsert', document]), tombstone: async (productId) => calls.push(['tombstone', productId]) };
  const consumer = new CatalogSearchProjectionConsumer(search);
  const current = { id: PRODUCT, brand_id: BRAND, publication_state: 'RESTRICTED', qc_state: 'APPROVED', publication_version: 3,
    published_revision_id: REVISION, published_approval_id: REVIEW, published_approval_decision: 'APPROVED', revision_id: REVISION,
    revision_hash: 'a'.repeat(64), revision_content_version: 1, revision_state: 'APPROVED', review_id: REVIEW,
    review_decision: 'APPROVED', reviewer_user_id: UUID(), submitted_by: UUID(), content_snapshot: null };
  let prior = null;
  const client = { query: async (sql, values) => {
    if (sql.includes('FROM catalogue.products p')) return { rows: [current], rowCount: 1 };
    if (sql.includes('FROM catalogue.search_projection_state')) return { rows: prior ? [prior] : [], rowCount: prior ? 1 : 0 };
    if (sql.includes('INSERT INTO catalogue.search_projection_state')) {
      prior = { publication_version: values[2], document_state: values[5], projected_sha256: values[6] };
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  } };
  const authorization = { brandId: BRAND, sourceEventId: sourceEvent.id, purpose: 'catalog.search_projection', authorizeEffect: async (effect, brand) => {
    assert.equal(effect, 'catalog.search.project'); assert.equal(brand, BRAND);
  } };
  await consumer.handle(sourceEvent, client, authorization);
  await consumer.handle(sourceEvent, client, authorization);
  assert.deepEqual(calls, [['tombstone', PRODUCT]]);
  assert.equal(Number(prior.publication_version), 3); assert.equal(prior.document_state, 'TOMBSTONED');
});

test('REN2-74 Typesense adapter uses stable IDs, scoped collection paths, and never returns provider response bodies', async () => {
  const requests = [];
  const client = new TypesenseProductSearchClient({ url: 'http://127.0.0.1:8108', apiKey: 'synthetic-typesense-key', collection: 'products_v1',
    fetch: async (url, init) => { requests.push({ url: String(url), init }); return new Response(JSON.stringify({ id: PRODUCT }), { status: 200 }); } });
  const document = { id: PRODUCT, brand_id: BRAND, publication_version: 2, revision_id: REVISION, category_id: UUID(), style_code: 'S-01',
    title: 'Item', description: '', searchable_text: 'Item S-01', variant_skus: [] };
  await client.upsert(document); await client.tombstone(PRODUCT);
  assert.match(requests[0].url, /collections\/products_v1\/documents\?action=upsert$/);
  assert.equal(requests[0].init.headers['X-TYPESENSE-API-KEY'], 'synthetic-typesense-key');
  assert.equal(JSON.parse(requests[0].init.body).id, PRODUCT);
  assert.match(requests[1].url, /documents\/11111111-1111-4111-8111-111111111111\?ignore_not_found=true$/);
  const unavailable = new TypesenseProductSearchClient({ url: 'http://127.0.0.1:8108', apiKey: 'key', collection: 'products_v1',
    fetch: async () => new Response('private provider detail', { status: 503 }) });
  await assert.rejects(unavailable.tombstone(PRODUCT), { code: 'EAI_AGAIN' });
});
