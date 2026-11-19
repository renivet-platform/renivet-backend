'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const {TaxonomyAdminPostgresRepository}=require('../dist/modules/catalog/taxonomy-admin.repository.js');
const url=process.env.RENIVET_TEST_DATABASE_URL;
test('REN2-117 new taxonomy category is inactive, audited, idempotent and non-self-published',{
  skip:!url&&'requires disposable PostgreSQL 16',timeout:30000
},async(t)=>{
  const parsed=new URL(url);
  assert.equal(parsed.protocol,'postgresql:');
  assert.equal(parsed.hostname,'127.0.0.1');
  assert.equal(parsed.pathname,'/renivet_ci');
  assert.equal(parsed.username,'renivet_ci');
  const pool=new Pool({connectionString:url,max:2});
  t.after(()=>pool.end());
  const tag=randomUUID().replaceAll('-','');
  const creator=(await pool.query(
    "INSERT INTO identity.users(email,display_name,state) VALUES($1,$2,'active') RETURNING id",
    ['ren2-117-category-'+tag+'@example.invalid','REN2-117 synthetic creator'])).rows[0].id;
  const repo=new TaxonomyAdminPostgresRepository({pool});
  const input={code:'ren2_117_'+tag.slice(0,22),name:'REN2-117 New Category'};
  const context={actorId:creator,requestId:'ren2-117:'+tag,idempotencyKey:'ren2-117:'+tag};
  const first=await repo.createCategory(input,context);
  assert.equal(first.status,'created_inactive');
  const row=(await pool.query(
    'SELECT name,active,schema_version FROM catalogue.categories WHERE id=$1',[first.id])).rows[0];
  assert.deepEqual(row,{name:input.name,active:false,schema_version:null});
  const audit=(await pool.query(
    "SELECT actor_user_id,action,subject_id FROM access.security_audit_events WHERE action='taxonomy.category_created' AND subject_id=$1",[first.id])).rows[0];
  assert.deepEqual(audit,{actor_user_id:creator,action:'taxonomy.category_created',subject_id:first.id});
  const replay=await repo.createCategory(input,context);
  assert.equal(replay.id,first.id);
  await assert.rejects(repo.createCategory({...input,name:'Different name'},context),e=>e.code==='TAXONOMY_IDEMPOTENCY_CONFLICT');
  await assert.rejects(repo.createCategory({code:input.code,name:'Another version'},{...context,idempotencyKey:'new-'+tag}),
    e=>e.code==='TAXONOMY_VERSION_CONFLICT');
});
