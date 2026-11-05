'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { CatalogReviewPostgresRepository } = require('../../dist/modules/catalog/catalog-review.repository.js');
const { CatalogPublicationPostgresRepository } = require('../../dist/modules/catalog/catalog-publication.repository.js');
const { createCatalogSearchProjectionHandler } = require('../../dist/modules/catalog/catalog-search-projection.js');
const { DurableWorker } = require('../../dist/workers/durable-worker.js');
const { DatabaseWorkerAuthorizationService } = require('../../dist/workers/worker-authorization.js');
const { TypesenseProductSearchClient } = require('../../dist/workers/typesense-product-search.js');
const { snapshotSha256 } = require('../../dist/modules/catalog/catalog-submission.js');

const dbUrl = process.env.RENIVET_TEST_DATABASE_URL;
const expectCode = (code) => (error) => error?.code === code;

test('REN2-74 projects current PostgreSQL publication to Typesense, suppresses stale events, and retries/dead-letters failures', {
  skip: !dbUrl && 'requires disposable PostgreSQL 16', timeout: 90_000,
}, async (t) => {
  const parsed = new URL(dbUrl);
  assert.equal(parsed.protocol, 'postgresql:'); assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.username, 'renivet_ci'); assert.equal(parsed.pathname, '/renivet_ci');
  const source = new Pool({ connectionString: dbUrl, max: 1 });
  const serverVersion = Number((await source.query('SHOW server_version_num')).rows[0].server_version_num);
  assert.ok(serverVersion >= 160000 && serverVersion < 170000);
  await source.end();
  const suffix = randomUUID().replaceAll('-', ''); const database = `ren2_74_${suffix}`;
  const adminUrl = new URL(dbUrl); adminUrl.pathname = '/postgres';
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  assert.equal((await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0]?.rolsuper, true,
    'integration fixture may clone only its disposable PostgreSQL source database');
  await admin.query(`CREATE DATABASE ${database} TEMPLATE renivet_ci`); await admin.end();
  const isolatedUrl = new URL(dbUrl); isolatedUrl.pathname = `/${database}`;
  const pool = new Pool({ connectionString: isolatedUrl.toString(), max: 10 });
  t.after(async () => {
    await pool.end(); const cleanup = new Pool({ connectionString: adminUrl.toString(), max: 1 });
    try { await cleanup.query(`DROP DATABASE ${database} WITH (FORCE)`); } finally { await cleanup.end(); }
  });
  await pool.query(`UPDATE platform.outbox_events SET delivered_at=now(),updated_at=now(),row_version=row_version+1
    WHERE event_type IN('catalogue.product.published','catalogue.product.restricted','catalogue.product.unpublished') AND delivered_at IS NULL`);

  const indexed = new Map(); const calls = []; let failSearch = false;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.headers['x-typesense-api-key'] !== 'synthetic-typesense-key') { res.writeHead(401).end(); return; }
    calls.push({ method: req.method, url: req.url });
    if (failSearch) { res.writeHead(503).end('private fake-provider error'); return; }
    const match = req.url.match(/^\/collections\/products_v1\/documents(?:\?action=upsert|\/([^?]+)\?ignore_not_found=true)$/);
    if (!match) { res.writeHead(404).end('{}'); return; }
    if (req.method === 'POST') {
      const document = JSON.parse(body); indexed.set(document.id, document);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: document.id })); return;
    }
    const id = decodeURIComponent(match[1]); indexed.delete(id);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const search = new TypesenseProductSearchClient({ url: `http://127.0.0.1:${port}`, apiKey: 'synthetic-typesense-key', collection: 'products_v1' });

  const tag = suffix;
  const addUser = async (name) => (await pool.query(`INSERT INTO identity.users(email,display_name,state) VALUES($1,$2,'active') RETURNING id`,
    [`ren2-74-${name}-${tag}@example.invalid`, name])).rows[0].id;
  const submitter = await addUser('submitter'); const operator = await addUser('operator'); const grantor = await addUser('grantor');
  const brand = (await pool.query(`INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state)
    VALUES($1,'REN2-74 Test','REN2-74 Test','approved') RETURNING id`, [`ren2-74-${tag}`])).rows[0].id;
  const permissionIds = (await pool.query(`INSERT INTO access.permissions(permission_code,resource,action,description)
    SELECT p,'catalog',split_part(p,'.',2),'REN2-74 synthetic integration' FROM unnest($1::text[]) p
    ON CONFLICT(permission_code) DO UPDATE SET permission_code=EXCLUDED.permission_code RETURNING id`,
  [['catalog.review','catalog.publish','catalog.restrict']])).rows.map((row) => row.id);
  const globalRole = (await pool.query(`INSERT INTO access.roles(role_code,scope_kind,description,is_system)
    VALUES($1,'global','REN2-74 synthetic catalog role',false) RETURNING id`, [`ren2_74_${tag}`])).rows[0].id;
  for (const permissionId of permissionIds) await pool.query('INSERT INTO access.role_permissions(role_id,permission_id) VALUES($1,$2)', [globalRole, permissionId]);
  await pool.query(`INSERT INTO access.role_assignments(user_id,role_id,scope_type,active_from,granted_by_id)
    VALUES($1,$2,'global',now(),$3)`, [operator, globalRole, grantor]);

  const categoryId = (await pool.query(`INSERT INTO catalogue.categories(code,name) VALUES($1,'REN2-74 Test') RETURNING id`, [`ren2-74-${tag}`])).rows[0].id;
  const schemaId = (await pool.query(`INSERT INTO catalogue.category_schema_versions(category_id,version,ruleset,ruleset_sha256,validator_version)
    VALUES($1,1,'{}'::jsonb,repeat('a',64),'ren2-74-test') RETURNING id`, [categoryId])).rows[0].id;
  await pool.query(`UPDATE catalogue.category_schema_versions SET state='PUBLISHED',approved_by=$2,published_at=now() WHERE id=$1`, [schemaId, operator]);
  const categoryClient = await pool.connect();
  try {
    await categoryClient.query('BEGIN');
    await categoryClient.query("SELECT set_config('app.taxonomy_actor_user_id',$1,true),set_config('app.taxonomy_request_id',$2,true),set_config('app.taxonomy_reason_code','REN2_74_TEST',true)", [operator, `activate-${tag}`]);
    await categoryClient.query('UPDATE catalogue.categories SET active=true WHERE id=$1', [categoryId]); await categoryClient.query('COMMIT');
  } catch (error) { await categoryClient.query('ROLLBACK'); throw error; } finally { categoryClient.release(); }

  const productId = randomUUID(); const variantId = randomUUID(); const priceId = randomUUID(); const assetId = randomUUID();
  const mediaLinkId = randomUUID(); const revisionId = randomUUID();
  await pool.query(`INSERT INTO catalogue.products(id,brand_id,category_id,style_code,title,description,category_schema_version,publication_state,qc_state)
    VALUES($1,$2,$3,$4,'Organic cotton tee','Blue cotton shirt',1,'PENDING_REVIEW','PENDING')`, [productId, brand, categoryId, `STYLE-${tag}`]);
  await pool.query(`INSERT INTO catalogue.product_variants(id,brand_id,product_id,sku,option_signature,options,variant_state)
    VALUES($1,$2,$3,$4,'default','{}','ACTIVE')`, [variantId, brand, productId, `SKU-${tag.slice(0,20)}`]);
  await pool.query(`INSERT INTO catalogue.variant_prices(id,brand_id,variant_id,currency,amount_minor,mrp_minor,valid_from,valid_to,price_state,rule_version)
    VALUES($1,$2,$3,'INR',5000,7000,now()-interval '1 day',now()+interval '1 day','APPROVED',1)`, [priceId, brand, variantId]);
  await pool.query(`INSERT INTO media.media_assets(id,brand_id,storage_key,sha256,mime_type,scan_state,rights_state,derivative_state,
    completed_at,rights_attested_by,rights_attested_at) VALUES($1,$2,$3,NULL,'image/webp','PENDING','ATTESTED','PENDING',NULL,$4,now())`,
  [assetId, brand, `ren2-74/${tag}`, submitter]);
  for (const kind of ['PREVIEW','THUMBNAIL']) await pool.query(`INSERT INTO media.media_derivatives
    (brand_id,media_asset_id,derivative_kind,storage_key,sha256,mime_type,byte_length,width,height)
    VALUES($1,$2,$3,$4,repeat('c',64),'image/webp',16,400,400)`, [brand, assetId, kind, `ren2-74/${tag}/${kind}`]);
  await pool.query(`UPDATE media.media_assets SET sha256=repeat('b',64),scan_state='CLEAN',derivative_state='READY',completed_at=now(),row_version=row_version+1 WHERE id=$1`, [assetId]);
  await pool.query(`INSERT INTO media.product_media(id,brand_id,product_id,media_asset_id,display_role,display_order,alt_text)
    VALUES($1,$2,$3,$4,'PRIMARY',0,'Front view')`, [mediaLinkId, brand, productId, assetId]);
  const snapshot = { schema: 'renivet.product-revision.v1', product: { id: productId, brandId: brand, categoryId,
    categorySchemaVersion: 1, styleCode: `STYLE-${tag}`, title: 'Organic cotton tee', description: 'Blue cotton shirt', contentVersion: 1 },
    attributes: { color: 'blue' }, attributeRules: {}, variants: [{ id: variantId, sku: `SKU-${tag.slice(0,20)}`, approvedPrice: { id: priceId } }],
    media: [{ id: mediaLinkId, assetId }], claims: [], sourceLineage: [] };
  const contentHash = snapshotSha256(snapshot);
  await pool.query(`INSERT INTO catalogue.product_revisions(id,brand_id,product_id,content_version,content_snapshot,content_sha256,
    submitted_by,review_state,category_id,category_schema_version) VALUES($1,$2,$3,1,$4::jsonb,$5,$6,'SUBMITTED',$7,1)`,
  [revisionId, brand, productId, JSON.stringify(snapshot), contentHash, submitter, categoryId]);
  const reviewRepo = new CatalogReviewPostgresRepository({ pool });
  const review = await reviewRepo.decide(productId, { decision: 'APPROVED', reasonCode: 'QC_PASSED', expectedRevisionId: revisionId, expectedRowVersion: 1 },
    { userId: operator, brandId: brand, idempotencyKey: `review-${tag}` });
  const publicationRepo = new CatalogPublicationPostgresRepository({ pool });
  const publicationContext = (expectedProductVersion, idempotencyKey) => ({ userId: operator, brandId: brand, expectedProductVersion, idempotencyKey });
  const published = await publicationRepo.publish(productId, { approvedRevisionId: revisionId, approvedReviewId: review.decisionId },
    publicationContext(review.rowVersion, `publish-${tag}`));
  const restricted = await publicationRepo.restrict(productId, { reasonCode: 'SAFETY_RECALL', appealReference: `CASE-${tag}` },
    publicationContext(published.rowVersion, `restrict-${tag}`));

  const consumerId = `catalog.search_projection_${tag}`;
  const principalProvider = { authenticate: async () => ({ id: 'ren2-74.synthetic-worker', active: true,
    permittedConsumers: [consumerId], provenance: 'integration.test' }) };
  const auth = new DatabaseWorkerAuthorizationService(pool, principalProvider);
  const alerts = []; const logs = [];
  const worker = new DurableWorker(pool, [createCatalogSearchProjectionHandler(search, consumerId)], {
    workerAuthorization: auth, maxAttempts: 1, baseRetryDelayMs: 0, maxRetryDelayMs: 0, jitterMs: 0,
    authorizeRecovery: async (actorId) => actorId === operator,
    log: (entry) => logs.push(entry), onDeadLetter: (alert) => alerts.push(alert),
  });

  // Both lifecycle events are queued after restriction, so the old PUBLISH must project current restricted state only.
  assert.equal(await worker.enqueueOutboxBatch(20), 2);
  const delayedJobs = await worker.claim(consumerId, `worker-${tag}`, 2);
  assert.equal(delayedJobs.length, 2);
  assert.deepEqual(await Promise.all(delayedJobs.map((job) => worker.process(job))), ['processed','processed']);
  assert.equal(indexed.has(productId), false); assert.equal(calls.filter((call) => call.method === 'DELETE').length, 1, JSON.stringify(calls));
  assert.equal(Number((await pool.query('SELECT publication_version FROM catalogue.search_projection_state WHERE product_id=$1', [productId])).rows[0].publication_version), 3);
  assert.equal(Number((await pool.query(`SELECT count(*)::int AS n FROM platform.inbox_receipts WHERE consumer_id=$1 AND message_id IN
    (SELECT id FROM platform.outbox_events WHERE aggregate_id=$2)`, [consumerId, productId])).rows[0].n), 2);
  await assert.rejects(pool.query('UPDATE catalogue.search_projection_state SET publication_version=publication_version-1 WHERE product_id=$1', [productId]),
    /CATALOG_SEARCH_PROJECTION_VERSION_INVALID/);
  assert.equal((await pool.query('SELECT document_state FROM catalogue.search_projection_state WHERE product_id=$1', [productId])).rows[0].document_state, 'TOMBSTONED');

  const unpublished = await publicationRepo.unpublish(productId, { reasonCode: 'SELLER_REVIEW_COMPLETE' },
    publicationContext(restricted.rowVersion, `unpublish-${tag}`));
  const republished = await publicationRepo.publish(productId, { approvedRevisionId: revisionId, approvedReviewId: review.decisionId },
    publicationContext(unpublished.rowVersion, `republish-${tag}`));
  failSearch = true;
  assert.equal(await worker.enqueueOutboxBatch(1), 1);
  const failedJob = (await worker.claim(consumerId, `worker-retry-${tag}`, 1))[0];
  assert.equal(await worker.process(failedJob), 'dead_letter');
  const deadLetters = await worker.listDeadLetters();
  const deadLetter = deadLetters.find((row) => row.jobId === failedJob.id);
  assert.ok(deadLetter); assert.equal(deadLetter.lastErrorCode, 'EAI_AGAIN');
  assert.equal(alerts.length, 1); assert.equal(alerts[0].jobId, failedJob.id);
  assert.ok(logs.some((entry) => entry.event === 'worker.job.failed' && entry.outcome === 'dead_letter' && entry.code === 'EAI_AGAIN'));
  failSearch = false;
  await worker.recoverDeadLetter(deadLetter.id, operator, 'DEPENDENCY_RESTORED');
  assert.equal((await worker.runOnce(consumerId, `worker-recovery-${tag}`, 10)).processed, 2);
  assert.equal(indexed.get(productId).publication_version, Number(republished.publicationVersion));
  assert.equal((await pool.query('SELECT state,attempt_count FROM platform.durable_jobs WHERE id=$1', [failedJob.id])).rows[0].state, 'succeeded');
  const authAudit = await pool.query(`SELECT count(*)::int AS n FROM platform.worker_authorization_audit a
    JOIN platform.worker_job_authorizations j ON j.job_id=a.job_id WHERE j.actor_id=$1 AND j.brand_id=$2 AND a.decision='allowed'`,
  ['ren2-74.synthetic-worker', brand]);
  assert.ok(authAudit.rows[0].n >= 3);
});
