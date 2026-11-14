const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');

test('REN2-100 reviewer API exposes all queues behind global admin permissions', () => {
  const source = readFileSync('src/modules/catalog/admin-review.controller.ts', 'utf8');
  for (const queue of ['taxonomy', 'quality', 'pricing', 'claims', 'publishing']) {
    assert.match(source, new RegExp(`@Get\\(['\"]${queue}['\"]\\)`));
    assert.match(source, new RegExp(`${queue}.*permission`, 'i'));
  }
  assert.match(source, /PlatformPermissionGuard/);
  const repository = readFileSync('src/modules/catalog/admin-review.repository.ts', 'utf8');
  assert.match(repository, /scope_type='global' AND ep.brand_id IS NULL/);
  assert.match(repository, /role_code='renivet_admin'/);
  assert.match(repository, /content_snapshot/);
  assert.match(repository, /media_asset_id/);
});

test('REN2-100 protected decisions retain MFA and session-bound CSRF', () => {
  const taxonomy = readFileSync('src/modules/catalog/taxonomy-admin.controller.ts', 'utf8');
  const prices = readFileSync('src/modules/catalog/price-review.controller.ts', 'utf8');
  const claims = readFileSync('src/modules/catalog/claim-review.controller.ts', 'utf8');
  assert.match(taxonomy, /RequireGlobalTaxonomyPermission/);
  for (const source of [prices, claims]) {
    assert.match(source, /RequireMfa/);
    assert.match(source, /csrfMatches/);
  }
  assert.match(readFileSync('src/modules/catalog/price-review.controller.ts', 'utf8'), /RequirePlatformAdminPermission/);
  assert.match(readFileSync('src/modules/catalog/claim-review.controller.ts', 'utf8'), /RequirePlatformAdminPermission/);
});


