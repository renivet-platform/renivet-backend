'use strict';
const assert=require('node:assert/strict');
const {createHash,randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const email='admin.w2.e2e@renivet.test';
const permissions=['staff_access.manage','brand_membership.review','brand_membership.manage','access_audit.read','account_status.read','brand_status.read','taxonomy.manage','taxonomy.approve','catalog.review','catalog.publish','catalog.restrict','pricing.approve','inventory.adjust.approve'];
function url(){
  assert.equal(process.env.RENIVET_ENABLE_LOCAL_SUPERADMIN_BOOTSTRAP,'1');
  assert.ok(['development','test'].includes(process.env.NODE_ENV),'Refusing non-local environment');
  const value=process.env.RENIVET_TEST_DATABASE_URL;
  assert.ok(value,'Disposable test database is required');
  const u=new URL(value);
  assert.equal(u.protocol,'postgresql:');
  assert.equal(u.hostname,'127.0.0.1');
  assert.equal(u.port,'5432');
  assert.equal(u.username,'renivet_ci');
  assert.equal(u.pathname,'/renivet_ci');
  assert.equal(u.search,'');
  return value;
}
async function main(){
  const pool=new Pool({connectionString:url(),max:1,connectionTimeoutMillis:5000});
  const client=await pool.connect();
  try{
    const v=Number((await client.query('SHOW server_version_num')).rows[0].server_version_num);
    assert.ok(v>=160000&&v<170000);
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ren2-119-local-superadmin',0))");
    const found=await client.query('SELECT id,email,state,email_verified_at FROM identity.users WHERE lower(email)=$1',[email]);
    assert.equal(found.rowCount,1,'Existing verified test account required, not created automatically');
    const user=found.rows[0];
    assert.equal(user.email,email);
    assert.equal(user.state,'active');
    assert.ok(user.email_verified_at,'Verify the E2E account email through the normal auth flow first');
    const admin=await client.query("SELECT id FROM access.roles WHERE role_code='renivet_admin' AND scope_kind='global'");
    assert.equal(admin.rowCount,1,'Run W1 migrations before bootstrap');
    const role=await client.query("INSERT INTO access.roles(role_code,scope_kind,description,is_system) VALUES('renivet_e2e_superadmin','global','Disposable local E2E QA platform permission role',false) ON CONFLICT(role_code) DO UPDATE SET description=EXCLUDED.description RETURNING id,scope_kind");
    assert.equal(role.rows[0].scope_kind,'global');
    const perms=await client.query('SELECT id,permission_code FROM access.permissions WHERE permission_code=ANY($1::text[])',[permissions]);
    const known=new Set(perms.rows.map(x=>x.permission_code));
    assert.ok(known.has('taxonomy.manage'),'Run taxonomy permission migration first');
    for(const perm of perms.rows)await client.query('INSERT INTO access.role_permissions(role_id,permission_id) VALUES($1,$2) ON CONFLICT(role_id,permission_id) DO NOTHING',[role.rows[0].id,perm.id]);
    for(const roleId of [admin.rows[0].id,role.rows[0].id]){
      await client.query("INSERT INTO access.role_assignments(user_id,role_id,brand_id,scope_type,active_from,granted_by_id) VALUES($1,$2,NULL,'global',now(),$1) ON CONFLICT DO NOTHING",[user.id,roleId]);
    }
    const audit=JSON.stringify({email,role:'renivet_e2e_superadmin',permissions:Array.from(known).sort()});
    await client.query("INSERT INTO access.security_audit_events(actor_user_id,action,subject_type,subject_id,request_id,payload_hash) VALUES(NULL,'local_qa.superadmin_bootstrap','identity.user',$1,$2,$3)",[user.id,'ren2-119-'+randomUUID(),createHash('sha256').update(audit).digest('hex')]);
    const effective=await client.query("SELECT role_code,permission_code FROM access.effective_permissions WHERE user_id=$1 AND scope_type='global' AND brand_id IS NULL",[user.id]);
    assert.ok(effective.rows.some(x=>x.role_code==='renivet_admin'&&x.permission_code==='taxonomy.manage'),'Apply migration 0047; taxonomy permission absent on admin role');
    await client.query('COMMIT');
    console.log('Local QA account roles applied and audited:',email);
    console.log('Global permission rows:',effective.rowCount);
    console.log('Optional unregistered platform permissions:',permissions.filter(x=>!known.has(x)).join(', ')||'none');
  }catch(err){await client.query('ROLLBACK').catch(()=>{});throw err;}
  finally{client.release();await pool.end();}
}
main().catch(err=>{console.error('Local bootstrap rejected:',err.message);process.exitCode=1;});
