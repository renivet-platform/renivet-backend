'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {readFileSync}=require('node:fs');
const {spawnSync}=require('node:child_process');
test('taxonomy permission is granted to preexisting global admin role only',()=>{
  const sql=readFileSync('drizzle/0047_ren2_119_admin_taxonomy_manage_role.sql','utf8');
  assert.match(sql,/taxonomy\.manage/);
  assert.match(sql,/renivet_admin/);
  assert.match(sql,/scope_kind = 'global'/);
  assert.doesNotMatch(sql,/INSERT INTO access\.role_assignments/);
});
test('bootstrap cannot execute without explicit disposable database authorization',()=>{
  const script='scripts/bootstrap-ren2-119-local-superadmin.cjs';
  const parsed=spawnSync(process.execPath,['--check',script],{encoding:'utf8'});
  assert.equal(parsed.status,0,parsed.stderr);
  const result=spawnSync(process.execPath,[script],{
    env:{...process.env,NODE_ENV:'development',RENIVET_ENABLE_LOCAL_SUPERADMIN_BOOTSTRAP:'0',RENIVET_TEST_DATABASE_URL:''},
    encoding:'utf8',
  });
  assert.notEqual(result.status,0);
  const source=readFileSync(script,'utf8');
  for(const term of ['127.0.0.1','renivet_ci','email_verified_at','admin.w2.e2e@renivet.test','ROLLBACK','security_audit_events'])assert.ok(source.includes(term),term);
  assert.doesNotMatch(source,/process\.env\.DATABASE_URL/);
});
