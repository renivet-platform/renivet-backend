'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { ProductDraftPostgresRepository } = require('../../dist/modules/catalog/product-draft.repository.js');
const { TaxonomyAdminPostgresRepository } = require('../../dist/modules/catalog/taxonomy-admin.repository.js');
const { normalizeProductCreate, normalizeProductPatch } = require('../../dist/modules/catalog/product-draft.service.js');

const url = process.env.RENIVET_TEST_DATABASE_URL;
function assertDisposable(value) {
  assert.ok(value, 'RENIVET_TEST_DATABASE_URL is required for REN2-61 integration tests');
  const parsed = new URL(value);
  assert.equal(parsed.protocol, 'postgresql:'); assert.equal(parsed.hostname, '127.0.0.1');
  assert.equal(parsed.pathname, '/renivet_ci'); assert.equal(parsed.username, 'renivet_ci');
}
function expectCode(code) { return (error) => error?.code === code; }

test('REN2-61/62 product drafts and SKU variants enforce category pins, CAS, idempotency, and brand isolation', {
  skip: !url && 'requires the disposable PostgreSQL 16 database', timeout: 60_000,
}, async (t) => {
  assertDisposable(url);
  const pool = new Pool({ connectionString: url, max: 6 });
  let testRoleId;
  t.after(async () => {
    try {
      if (testRoleId) {
        await pool.query('DELETE FROM access.role_assignments WHERE role_id = $1', [testRoleId]);
      }
    } finally {
      await pool.end();
    }
  });
  const version = await pool.query('SHOW server_version_num');
  assert.ok(Number(version.rows[0].server_version_num) >= 160000 && Number(version.rows[0].server_version_num) < 170000);
  const suffix = randomUUID().replaceAll('-', '');
  const addUser = async (label) => (await pool.query(
    `INSERT INTO identity.users(email,display_name,state) VALUES($1,$2,'active') RETURNING id`,
    [`ren2-61-${label}-${suffix}@example.invalid`, label])).rows[0].id;
  const owner = await addUser('owner'); const grantor = await addUser('grantor');
  const proposer = await addUser('proposer'); const approver = await addUser('approver');
  const brand = (await pool.query(
    `INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state) VALUES($1,'REN2-61 Synthetic','REN2-61 Synthetic','approved') RETURNING id`,
    [`ren2-61-${suffix}`])).rows[0].id;
  await pool.query(`INSERT INTO brands.brand_memberships(brand_id,user_id,membership_state,invited_by_id,joined_at)
    VALUES($1,$2,'active',$3,now())`, [brand, owner, grantor]);
  const role = (await pool.query(`INSERT INTO access.roles(role_code,scope_kind,description,is_system)
    VALUES($1,'brand','REN2-61 disposable role',false) RETURNING id`, [`ren2_61_${suffix}`])).rows[0].id;
  testRoleId = role;
  const permission = (await pool.query(`INSERT INTO access.permissions(permission_code,resource,action,description)
    VALUES('catalog.write','catalog','write','REN2-61 product draft test') ON CONFLICT(permission_code) DO UPDATE SET permission_code=EXCLUDED.permission_code RETURNING id`)).rows[0].id;
  await pool.query('INSERT INTO access.role_permissions(role_id,permission_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [role, permission]);
  await pool.query(`INSERT INTO access.role_assignments(user_id,role_id,brand_id,scope_type,active_from,granted_by_id)
    VALUES($1,$2,$3,'brand',now(),$4)`, [owner, role, brand, grantor]);
  const otherBrand = (await pool.query(`INSERT INTO brands.brands(slug,legal_name,display_name,onboarding_state) VALUES($1,'REN2-61 Other','REN2-61 Other','approved') RETURNING id`,
    [`ren2-61-other-${suffix}`])).rows[0].id;
  await pool.query(`INSERT INTO brands.brand_memberships(brand_id,user_id,membership_state,invited_by_id,joined_at) VALUES($1,$2,'active',$3,now())`, [otherBrand, owner, grantor]);
  await pool.query(`INSERT INTO access.role_assignments(user_id,role_id,brand_id,scope_type,active_from,granted_by_id) VALUES($1,$2,$3,'brand',now(),$4)`, [owner, role, otherBrand, grantor]);

  const category = (await pool.query(`INSERT INTO catalogue.categories(code,name) VALUES($1,$1) RETURNING id`, [`r61-${suffix}`])).rows[0].id;
  const attribute = (await pool.query(`INSERT INTO catalogue.attributes(code,label,value_type,scope_type,allowed_values)
    VALUES($1,'Material','enum','product','["cotton","linen"]'::jsonb) RETURNING id,code`, [`r61-material-${suffix}`])).rows[0];
  const sizeAttribute = (await pool.query(`INSERT INTO catalogue.attributes(code,label,value_type,scope_type,allowed_values)
    VALUES($1,'Size','enum','variant','["M","L"]'::jsonb) RETURNING id,code`, [`r62-size-${suffix}`])).rows[0];
  const colorAttribute = (await pool.query(`INSERT INTO catalogue.attributes(code,label,value_type,scope_type,allowed_values)
    VALUES($1,'Color','enum','variant','["Blue","Red"]'::jsonb) RETURNING id,code`, [`r62-color-${suffix}`])).rows[0];
  const variantRules = [
    { attributeId: sizeAttribute.id, code: sizeAttribute.code, scope: 'variant', valueType: 'enum', allowedValues: ['M','L'], requiredByDefault: false },
    { attributeId: colorAttribute.id, code: colorAttribute.code, scope: 'variant', valueType: 'enum', allowedValues: ['Blue','Red'], requiredByDefault: false },
  ];
  const admin = new TaxonomyAdminPostgresRepository({ pool });
  await admin.propose({ categoryId: category, version: 1, validatorVersion: 'w2-attribute-validator-v1',
    ruleset: { attributes: [{ attributeId: attribute.id, code: attribute.code, scope: 'product', valueType: 'enum', allowedValues: ['cotton','linen'], requiredByDefault: true }, ...variantRules] } },
  { actorId: proposer, requestId: `r61:${randomUUID()}`, idempotencyKey: `r61-propose-${suffix}` });
  await admin.publish({ categoryId: category, version: 1 }, { actorId: approver, requestId: `r61:${randomUUID()}`, idempotencyKey: `r61-publish-${suffix}` });
  const activate = await pool.connect();
  try {
    await activate.query('BEGIN');
    await activate.query(`SELECT set_config('app.taxonomy_actor_user_id',$1,true),set_config('app.taxonomy_request_id',$2,true),set_config('app.taxonomy_reason_code','INITIAL_ACTIVATION',true)`, [approver, `r61:${randomUUID()}`]);
    await activate.query('UPDATE catalogue.categories SET active=true WHERE id=$1', [category]);
    await activate.query('COMMIT');
  } catch (error) { await activate.query('ROLLBACK'); throw error; } finally { activate.release(); }
  await admin.propose({ categoryId: category, version: 2, validatorVersion: 'w2-attribute-validator-v1',
    ruleset: { attributes: [{ attributeId: attribute.id, code: attribute.code, scope: 'product', valueType: 'enum', allowedValues: ['cotton','linen'], requiredByDefault: true }, ...variantRules] } },
  { actorId: proposer, requestId: `r61:${randomUUID()}`, idempotencyKey: `r61-propose-v2-${suffix}` });
  await admin.publish({ categoryId: category, version: 2 }, { actorId: approver, requestId: `r61:${randomUUID()}`, idempotencyKey: `r61-publish-v2-${suffix}` });
  const accessContext = { userId: owner, brandId: brand, permission: 'catalog.write', requestId: `r61:${randomUUID()}` };
  const repository = new ProductDraftPostgresRepository({ pool });
  const create = { styleCode: '  summer-01 ', categoryCode: `r61-${suffix}`, categorySchemaVersion: 1,
    title: '  Unfinished dress ', description: '  first save ', attributes: {} };
  const createContext = { ...accessContext, idempotencyKey: `create-${suffix}` };
  const normalizedCreate = normalizeProductCreate(create);
  const draft = await repository.create(normalizedCreate, createContext);
  assert.equal(draft.publicationState, 'DRAFT');
  assert.equal(draft.rowVersion, 1);
  const storedTitle = await pool.query('SELECT title,description,style_code FROM catalogue.products WHERE id=$1', [draft.productId]);
  assert.equal(storedTitle.rows[0].title, 'Unfinished dress'); assert.equal(storedTitle.rows[0].description, 'first save');
  assert.equal(storedTitle.rows[0].style_code, 'summer-01');
  assert.deepEqual(draft.variantIds, [], 'variants are optional for draft creation');
  const emptyAttributes = await pool.query('SELECT count(*)::int AS count FROM catalogue.product_attribute_values WHERE product_id=$1', [draft.productId]);
  assert.equal(emptyAttributes.rows[0].count, 0, 'required submission attributes do not block draft creation');
  const replay = await repository.create(normalizedCreate, createContext);
  assert.equal(replay.productId, draft.productId);
  await assert.rejects(repository.create(normalizeProductCreate({ ...create, title: 'different content' }), createContext), expectCode('PRODUCT_IDEMPOTENCY_CONFLICT'));
  const concurrentInput = normalizeProductCreate({ ...create, styleCode: `concurrent-${suffix}` });
  const concurrentContext = { ...accessContext, idempotencyKey: `concurrent-create-${suffix}` };
  const concurrentCreates = await Promise.all([
    repository.create(concurrentInput, concurrentContext), repository.create(concurrentInput, concurrentContext),
  ]);
  assert.equal(concurrentCreates[0].productId, concurrentCreates[1].productId, 'concurrent retries return one immutable product ID');

  const update = { title: 'Final draft title', attributes: { [attribute.code]: 'cotton' } };
  const updateContext = { ...accessContext, idempotencyKey: `update-${suffix}` };
  const updated = await repository.update(draft.productId, normalizeProductPatch(update), 1, updateContext);
  assert.equal(updated.rowVersion, 2); assert.equal(updated.contentVersion, 2);
  assert.equal(updated.title, 'Final draft title'); assert.equal(updated.attributes[attribute.code], 'cotton');
  const updateReplay = await repository.update(draft.productId, normalizeProductPatch(update), 1, updateContext);
  assert.equal(updateReplay.rowVersion, 2, 'an exact update retry returns the original receipt');
  await assert.rejects(repository.update(draft.productId, normalizeProductPatch({ title: 'different update' }), 1, updateContext), expectCode('PRODUCT_IDEMPOTENCY_CONFLICT'));
  await assert.rejects(repository.update(draft.productId, normalizeProductPatch({ description: 'stale' }), 1,
    { ...accessContext, idempotencyKey: `stale-${suffix}` }), expectCode('PRODUCT_ROW_VERSION_CONFLICT'));
  await assert.rejects(repository.update(draft.productId, normalizeProductPatch({ title: 'leak' }), 2,
    { ...accessContext, brandId: otherBrand, idempotencyKey: `cross-${suffix}` }), expectCode('PRODUCT_NOT_FOUND'));
  const imported = await repository.update(draft.productId, normalizeProductPatch({ description: 'spreadsheet save' }), 2,
    { ...accessContext, idempotencyKey: `import-update-${suffix}`, sourceKind: 'IMPORT', sourceReference: `import-batch-${suffix}` });
  assert.equal(imported.rowVersion, 3);
  const repinned = await repository.update(draft.productId, normalizeProductPatch({ categorySchemaVersion: 2 }), 3,
    { ...accessContext, idempotencyKey: `schema-pin-${suffix}` });
  assert.equal(repinned.categorySchemaVersion, 2);
  assert.equal(repinned.rowVersion, 4);
  const pinnedAttribute = await pool.query(`SELECT v.category_schema_version,r.schema_version_id AS value_schema_id,sv.id AS published_schema_id
    FROM catalogue.product_attribute_values v JOIN catalogue.category_schema_attribute_rules r ON r.id=v.frozen_rule_id
    JOIN catalogue.category_schema_versions sv ON sv.category_id=v.category_id AND sv.version=2 WHERE v.product_id=$1`, [draft.productId]);
  assert.equal(pinnedAttribute.rows[0].category_schema_version, 2, 'attribute FK rows follow the new published pin');
  assert.equal(pinnedAttribute.rows[0].value_schema_id, pinnedAttribute.rows[0].published_schema_id);
  const concurrentUpdates = await Promise.allSettled([
    repository.update(draft.productId, normalizeProductPatch({ title: 'parallel A' }), 4, { ...accessContext, idempotencyKey: `parallel-a-${suffix}` }),
    repository.update(draft.productId, normalizeProductPatch({ title: 'parallel B' }), 4, { ...accessContext, idempotencyKey: `parallel-b-${suffix}` }),
  ]);
  assert.equal(concurrentUpdates.filter((item) => item.status === 'fulfilled').length, 1, 'one CAS update wins');
  assert.equal(concurrentUpdates.filter((item) => item.status === 'rejected' && item.reason.code === 'PRODUCT_ROW_VERSION_CONFLICT').length, 1,
    'concurrent stale update loses without overwriting the winner');
  await pool.query("UPDATE catalogue.products SET publication_state='ARCHIVED' WHERE id=$1", [draft.productId]);
  await assert.rejects(repository.update(draft.productId, normalizeProductPatch({ title: 'no archived edit' }), 5,
    { ...accessContext, idempotencyKey: `archived-product-${suffix}` }), expectCode('PRODUCT_STATE_RESTRICTED'));
  await pool.query("UPDATE catalogue.products SET publication_state='RESTRICTED' WHERE id=$1", [draft.productId]);
  await assert.rejects(repository.update(draft.productId, normalizeProductPatch({ title: 'no restricted edit' }), 5,
    { ...accessContext, idempotencyKey: `restricted-product-${suffix}` }), expectCode('PRODUCT_STATE_RESTRICTED'));
  const lineage = await pool.query(`SELECT source_kind,count(*)::int AS count FROM catalogue.product_field_lineage WHERE product_id=$1 GROUP BY source_kind`, [draft.productId]);
  assert.ok(lineage.rows.some((row) => row.source_kind === 'MANUAL' && row.count >= 4), 'manual field source lineage is recorded');
  assert.ok(lineage.rows.some((row) => row.source_kind === 'IMPORT' && row.count === 1), 'import field source and batch reference are recorded');
  const immutableReceipt = await pool.query(`SELECT id FROM catalogue.product_mutation_receipts WHERE product_id=$1 AND operation='createBrandProduct'`, [draft.productId]);
  await assert.rejects(pool.query(`UPDATE catalogue.product_mutation_receipts SET response_payload='{}'::jsonb WHERE id=$1`, [immutableReceipt.rows[0].id]), /IMMUTABLE_RECORD/);
  const immutableLineage = await pool.query('SELECT id FROM catalogue.product_field_lineage WHERE product_id=$1 LIMIT 1', [draft.productId]);
  await assert.rejects(pool.query('DELETE FROM catalogue.product_field_lineage WHERE id=$1', [immutableLineage.rows[0].id]), /IMMUTABLE_RECORD/);

  const withVariant = await repository.create(normalizeProductCreate({ ...create, styleCode: `variant-${suffix}`,
    variants: [{ sku: `sku-${suffix.slice(0, 20)}`, options: { [sizeAttribute.code]: 'M' }, weightG: 250 }] }),
  { ...accessContext, idempotencyKey: `optional-variant-${suffix}` });
  assert.equal(withVariant.variantIds.length, 1, 'optional initial variants remain supported');
  const variantLineage = await pool.query(`SELECT count(*)::int AS count FROM catalogue.product_field_lineage WHERE product_id=$1 AND field_path LIKE 'variants.%'`, [withVariant.productId]);
  assert.equal(variantLineage.rows[0].count, 3, 'each supplied initial-variant field has lineage');

  const blueM = await repository.createVariant(withVariant.productId,
    { sku: `blue-m-${suffix.slice(0, 12)}`, options: { [sizeAttribute.code]: 'M', [colorAttribute.code]: 'Blue' }, weightG: 250 },
    1, { ...accessContext, idempotencyKey: `blue-m-${suffix}` });
  const blueL = await repository.createVariant(withVariant.productId,
    { sku: `blue-l-${suffix.slice(0, 12)}`, options: { [colorAttribute.code]: 'Blue', [sizeAttribute.code]: 'L' } },
    2, { ...accessContext, idempotencyKey: `blue-l-${suffix}` });
  assert.notEqual(blueM.optionSignature, blueL.optionSignature, 'different option values create different canonical signatures');
  const blueMReplay = await repository.createVariant(withVariant.productId,
    { sku: `blue-m-${suffix.slice(0, 12)}`, options: { [colorAttribute.code]: 'Blue', [sizeAttribute.code]: 'M' }, weightG: 250 },
    1, { ...accessContext, idempotencyKey: `blue-m-${suffix}` });
  assert.equal(blueMReplay.id, blueM.id, 'idempotent create returns the original variant identity');
  assert.equal(blueMReplay.parentRowVersion, 2, 'idempotent replay does not increment the parent again');
  await assert.rejects(repository.createVariant(withVariant.productId,
    { sku: `dupe-${suffix.slice(0, 12)}`, options: { [colorAttribute.code]: 'Blue', [sizeAttribute.code]: 'M' } },
    3, { ...accessContext, idempotencyKey: `duplicate-options-${suffix}` }), expectCode('PRODUCT_CONFLICT'));
  await assert.rejects(repository.createVariant(withVariant.productId,
    { sku: `bad-${suffix.slice(0, 12)}`, options: { [colorAttribute.code]: 'Green', [sizeAttribute.code]: 'M' } },
    3, { ...accessContext, idempotencyKey: `invalid-category-option-${suffix}` }), expectCode('VARIANT_ATTRIBUTE_INVALID'));
  const updatedVariant = await repository.updateVariant(withVariant.productId, blueM.id,
    { options: { [colorAttribute.code]: 'Red', [sizeAttribute.code]: 'M' }, weightG: 275 }, 1,
    { ...accessContext, idempotencyKey: `update-variant-${suffix}` });
  assert.equal(updatedVariant.rowVersion, 2);
  await assert.rejects(repository.updateVariant(withVariant.productId, blueM.id, { weightG: 300 }, 1,
    { ...accessContext, idempotencyKey: `stale-variant-${suffix}` }), expectCode('VARIANT_ROW_VERSION_CONFLICT'));
  await assert.rejects(repository.updateVariant(withVariant.productId, blueM.id, { weightG: 300 }, 2,
    { ...accessContext, brandId: otherBrand, idempotencyKey: `cross-brand-variant-${suffix}` }), expectCode('VARIANT_NOT_FOUND'));
  const concurrentVariantUpdates = await Promise.allSettled([
    repository.updateVariant(withVariant.productId, blueL.id, { weightG: 100 }, 1, { ...accessContext, idempotencyKey: `parallel-a-${suffix}` }),
    repository.updateVariant(withVariant.productId, blueL.id, { weightG: 110 }, 1, { ...accessContext, idempotencyKey: `parallel-b-${suffix}` }),
  ]);
  assert.equal(concurrentVariantUpdates.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(concurrentVariantUpdates.filter((item) => item.status === 'rejected' && item.reason.code === 'VARIANT_ROW_VERSION_CONFLICT').length, 1);
  const inactiveVariant = await repository.deactivateVariant(withVariant.productId, blueL.id, { reasonCode: 'NO_LONGER_SOLD', expectedVariantVersion: 2 }, 2,
    { ...accessContext, idempotencyKey: `deactivate-variant-${suffix}` });
  assert.equal(inactiveVariant.variantState, 'INACTIVE');
  const retainedSku = await pool.query('SELECT sku,variant_state FROM catalogue.product_variants WHERE id=$1', [blueL.id]);
  assert.equal(retainedSku.rows[0].sku, `blue-l-${suffix.slice(0, 12)}`, 'soft deactivation retains the SKU identity');
  assert.equal(retainedSku.rows[0].variant_state, 'INACTIVE');
  await assert.rejects(repository.createVariant(withVariant.productId,
    { sku: `blue-l-${suffix.slice(0, 12)}`, options: { [colorAttribute.code]: 'Blue', [sizeAttribute.code]: 'L' } },
    3, { ...accessContext, idempotencyKey: `recycle-inactive-sku-${suffix}` }), expectCode('PRODUCT_CONFLICT'));
  await pool.query(`INSERT INTO catalogue.variant_prices(brand_id,variant_id,currency,amount_minor,mrp_minor,valid_from,price_state,rule_version)
    VALUES($1,$2,'INR',50,100,now(),'DRAFT',1)`, [brand, blueM.id]);
  await assert.rejects(repository.deactivateVariant(withVariant.productId, blueM.id, { reasonCode: 'HAS_PRICE' }, 2,
    { ...accessContext, idempotencyKey: `referenced-deactivate-${suffix}` }), expectCode('VARIANT_REFERENCED'));
  await pool.query('UPDATE catalogue.product_variants SET sku_locked_at=now() WHERE id=$1', [blueM.id]);
  await assert.rejects(pool.query('UPDATE catalogue.product_variants SET sku=$2 WHERE id=$1', [blueM.id, `changed-${suffix.slice(0, 12)}`]),
    /ordered variant SKU and its lock are immutable/);
  await assert.rejects(repository.deactivateVariant(withVariant.productId, blueM.id, { reasonCode: 'ORDERED' }, 2,
    { ...accessContext, idempotencyKey: `ordered-deactivate-${suffix}` }), expectCode('VARIANT_REFERENCED'));

  for (const state of ['suspended', 'restricted', 'archived']) {
    await pool.query('UPDATE brands.brands SET onboarding_state=$2 WHERE id=$1', [brand, state]);
    await assert.rejects(repository.create(normalizeProductCreate({ ...create, styleCode: `${state}-brand` }),
      { ...accessContext, idempotencyKey: `${state}-${suffix}` }), expectCode('PRODUCT_ACCESS_DENIED'));
  }
  await pool.query("UPDATE brands.brands SET onboarding_state='approved' WHERE id=$1", [brand]);
  await pool.query("UPDATE brands.brand_memberships SET membership_state='suspended' WHERE brand_id=$1 AND user_id=$2", [brand, owner]);
  await assert.rejects(repository.create(normalizeProductCreate({ ...create, styleCode: 'suspended-membership' }),
    { ...accessContext, idempotencyKey: `suspended-membership-${suffix}` }), expectCode('PRODUCT_ACCESS_DENIED'));
});

