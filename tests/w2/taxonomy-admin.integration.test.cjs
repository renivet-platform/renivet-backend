'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { TaxonomyAdminPostgresRepository } = require('../../dist/modules/catalog/taxonomy-admin.repository.js');

const url = process.env.RENIVET_TEST_DATABASE_URL;
const enabled = Boolean(url);

function assertDisposableDatabase(value) {
  assert.ok(value, 'RENIVET_TEST_DATABASE_URL is required for taxonomy admin integration tests');
  const parsed = new URL(value);
  assert.equal(parsed.protocol, 'postgresql:');
  assert.equal(parsed.hostname, '127.0.0.1', 'taxonomy admin integration tests require loopback-only PostgreSQL');
  assert.equal(parsed.pathname, '/renivet_ci');
  assert.equal(parsed.username, 'renivet_ci');
}

function expectCode(code) {
  return (error) => error?.code === code;
}

async function makeCategory(pool, tag) {
  const result = await pool.query('INSERT INTO catalogue.categories (code,name) VALUES ($1,$2) RETURNING id', [`r58-${tag}-${randomUUID()}`, `REN2-58 ${tag}`]);
  return result.rows[0].id;
}

async function makeRule(pool, tag) {
  const result = await pool.query(
    `INSERT INTO catalogue.attributes (code,label,value_type,scope_type,allowed_values)
     VALUES ($1,'Material','enum','product','["cotton","linen"]'::jsonb) RETURNING id,code`, [`r58-${tag}-${randomUUID()}`],
  );
  return { attributeId: result.rows[0].id, code: result.rows[0].code };
}

async function setAvailability(pool, categoryId, actorId, active) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.taxonomy_actor_user_id',$1,true)", [actorId]);
    await client.query("SELECT set_config('app.taxonomy_request_id',$1,true)", [`ren2-58:${randomUUID()}`]);
    await client.query("SELECT set_config('app.taxonomy_reason_code',$1,true)", [active ? 'PILOT_APPROVED' : 'POLICY_RETIRED']);
    await client.query('UPDATE catalogue.categories SET active=$2 WHERE id=$1', [categoryId, active]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

test('REN2-58 drafts, previews, publishes atomically, replays idempotently, and serializes concurrent publication', {
  skip: enabled ? false : 'requires the disposable PostgreSQL 16 CI database',
  timeout: 60_000,
}, async (t) => {
  assertDisposableDatabase(url);
  const pool = new Pool({ connectionString: url, max: 6, connectionTimeoutMillis: 5_000 });
  t.after(() => pool.end());
  const server = await pool.query('SHOW server_version_num');
  const versionNumber = Number(server.rows[0].server_version_num);
  assert.ok(versionNumber >= 160000 && versionNumber < 170000, 'REN2-58 requires disposable PostgreSQL 16');

  const actor = await pool.query(
    `INSERT INTO identity.users (email,display_name,state) VALUES ($1,'REN2-58 Synthetic Approver','active') RETURNING id`,
    [`r58-${randomUUID()}@example.invalid`],
  );
  const actorId = actor.rows[0].id;
  const approver = await pool.query(
    `INSERT INTO identity.users (email,display_name,state) VALUES ($1,'REN2-58 Independent Approver','active') RETURNING id`,
    [`r58-approver-${randomUUID()}@example.invalid`],
  );
  const approverId = approver.rows[0].id;
  const repository = new TaxonomyAdminPostgresRepository({ pool });
  const categoryId = await makeCategory(pool, 'publish');
  const attribute = await makeRule(pool, 'publish');
  const input = {
    categoryId,
    version: 1,
    validatorVersion: 'w2-attribute-validator-v1',
    ruleset: { attributes: [{ attributeId: attribute.attributeId, code: attribute.code, scope: 'product', valueType: 'enum', allowedValues: ['cotton', 'linen'], requiredByDefault: true }] },
  };
  const proposalContext = { actorId, requestId: `req-${randomUUID()}`, idempotencyKey: `propose-${randomUUID()}` };
  const draft = await repository.propose(input, proposalContext);
  assert.equal(draft.status, 'draft_submitted');
  assert.deepEqual(draft.previewDiff.added.map(({ code }) => code), [attribute.code]);
  const draftReplay = await repository.propose(input, { ...proposalContext, requestId: `replay-${randomUUID()}` });
  assert.equal(draftReplay.id, draft.id);
  assert.deepEqual(draftReplay.previewDiff, draft.previewDiff);
  await assert.rejects(repository.propose({ ...input, version: 2 }, proposalContext), expectCode('TAXONOMY_IDEMPOTENCY_CONFLICT'));
  await assert.rejects(repository.publish({ categoryId, version: 1 }, { actorId, requestId: `self-approval-${randomUUID()}`, idempotencyKey: `self-approval-${randomUUID()}` }), expectCode('TAXONOMY_APPROVER_MUST_DIFFER'));

  const publicationContexts = [1, 2].map((index) => ({ actorId: approverId, requestId: `publish-req-${index}-${randomUUID()}`, idempotencyKey: `publish-${index}-${randomUUID()}` }));
  const publicationCalls = publicationContexts.map((context) => repository.publish({ categoryId, version: 1 }, context));
  const publicationResults = await Promise.allSettled(publicationCalls);
  assert.equal(publicationResults.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(publicationResults.filter((item) => item.status === 'rejected' && item.reason.code === 'TAXONOMY_VERSION_CONFLICT').length, 1);
  const published = await pool.query(
    `SELECT c.schema_version,v.state,v.ruleset_sha256,v.approved_by,
            (SELECT count(*)::int FROM platform.outbox_events o WHERE o.aggregate_id=c.id AND o.event_type='category_schema.published') AS notice_count,
            (SELECT count(*)::int FROM catalogue.taxonomy_admin_events e WHERE e.category_id=c.id AND e.action='publish') AS audit_count
       FROM catalogue.categories c JOIN catalogue.category_schema_versions v
         ON v.category_id=c.id AND v.version=1 WHERE c.id=$1`, [categoryId],
  );
  assert.equal(published.rows[0].schema_version, 1);
  assert.equal(published.rows[0].state, 'PUBLISHED');
  assert.equal(published.rows[0].approved_by, approverId);
  assert.match(published.rows[0].ruleset_sha256, /^[0-9a-f]{64}$/);
  assert.equal(published.rows[0].notice_count, 1);
  assert.equal(published.rows[0].audit_count, 1);
  const auditEvent = await pool.query(
    `SELECT id FROM catalogue.taxonomy_admin_events WHERE category_id=$1 AND action='publish'`, [categoryId],
  );
  await assert.rejects(
    pool.query('UPDATE catalogue.taxonomy_admin_events SET metadata=metadata WHERE id=$1', [auditEvent.rows[0].id]),
    /IMMUTABLE|cannot be changed/i,
  );

  const winnerIndex = publicationResults.findIndex((item) => item.status === 'fulfilled');
  const winner = publicationResults[winnerIndex];
  const replayed = await repository.publish({ categoryId, version: 1 }, { ...publicationContexts[winnerIndex], requestId: `publish-replay-again-${randomUUID()}` });
  assert.equal(replayed.id, winner.value.id);
  const replayCounts = await pool.query(
    `SELECT (SELECT count(*)::int FROM platform.outbox_events WHERE aggregate_id=$1 AND event_type='category_schema.published') AS notices,
            (SELECT count(*)::int FROM catalogue.taxonomy_admin_events WHERE category_id=$1 AND action='publish') AS audits`, [categoryId],
  );
  assert.deepEqual(replayCounts.rows[0], { notices: 1, audits: 1 });

  const retiredCategory = await makeCategory(pool, 'retired');
  const retiredAttribute = await makeRule(pool, 'retired');
  const retiredContext = { actorId, requestId: `retire-proposal-${randomUUID()}`, idempotencyKey: `retire-propose-${randomUUID()}` };
  const retiredRuleset = { attributes: [{ attributeId: retiredAttribute.attributeId, code: retiredAttribute.code, scope: 'product', valueType: 'enum', allowedValues: ['cotton'], requiredByDefault: false }] };
  await repository.propose({ ...input, categoryId: retiredCategory, version: 1, ruleset: retiredRuleset }, retiredContext);
  await repository.publish({ categoryId: retiredCategory, version: 1 }, { actorId: approverId, requestId: `retire-publish-${randomUUID()}`, idempotencyKey: `retire-publish-${randomUUID()}` });
  await setAvailability(pool, retiredCategory, actorId, true);
  await repository.propose({ ...input, categoryId: retiredCategory, version: 2, ruleset: retiredRuleset }, { actorId, requestId: `retire-v2-${randomUUID()}`, idempotencyKey: `retire-v2-${randomUUID()}` });
  await setAvailability(pool, retiredCategory, actorId, false);
  await assert.rejects(repository.publish({ categoryId: retiredCategory, version: 2 }, { actorId: approverId, requestId: `retired-${randomUUID()}`, idempotencyKey: `retired-${randomUUID()}` }), expectCode('TAXONOMY_VERSION_CONFLICT'));

  const incompleteCategory = await makeCategory(pool, 'incomplete');
  const incompleteAttribute = await makeRule(pool, 'incomplete');
  const incompleteDraft = await repository.propose({ ...input, categoryId: incompleteCategory, version: 1, ruleset: { attributes: [{ attributeId: incompleteAttribute.attributeId, code: incompleteAttribute.code, scope: 'product', valueType: 'enum', allowedValues: ['cotton'], requiredByDefault: false }] } }, { actorId, requestId: `incomplete-${randomUUID()}`, idempotencyKey: `incomplete-propose-${randomUUID()}` });
  await pool.query('DELETE FROM catalogue.category_schema_attribute_rules WHERE schema_version_id=$1', [incompleteDraft.id]);
  await assert.rejects(repository.publish({ categoryId: incompleteCategory, version: 1 }, { actorId: approverId, requestId: `incomplete-publish-${randomUUID()}`, idempotencyKey: `incomplete-publish-${randomUUID()}` }), expectCode('CATEGORY_SCHEMA_INVALID'));
  const stillDraft = await pool.query('SELECT state FROM catalogue.category_schema_versions WHERE id=$1', [incompleteDraft.id]);
  assert.equal(stillDraft.rows[0].state, 'DRAFT');
});
