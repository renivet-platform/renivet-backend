'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {randomUUID}=require('node:crypto');
const {Pool}=require('pg');
const {BrandApplicationsController}=require('../dist/modules/identity/brand-applications.controller.js');
const url=process.env.RENIVET_TEST_DATABASE_URL;
test('W1 seller application persists pending brand and membership, and appears in review queue',{
  skip:!url&&'disposable PostgreSQL 16 is required',timeout:30000,
},async(t)=>{
  const parsed=new URL(url);
  assert.equal(parsed.protocol,'postgresql:');
  assert.equal(parsed.hostname,'127.0.0.1');
  assert.equal(parsed.username,'renivet_ci');
  assert.equal(parsed.pathname,'/renivet_ci');
  const pool=new Pool({connectionString:url,max:2});
  t.after(()=>pool.end());
  const suffix=randomUUID().replaceAll('-','');
  const user=(await pool.query(
    "INSERT INTO identity.users(email,display_name,state) VALUES($1,'W1 application test owner','active') RETURNING id",
    [`w1-app-${suffix}@example.invalid`])).rows[0].id;
  const other=(await pool.query(
    "INSERT INTO identity.users(email,display_name,state) VALUES($1,'W1 application competing owner','active') RETURNING id",
    [`w1-other-${suffix}@example.invalid`])).rows[0].id;
  const auth=(id)=>({
    authenticate:async()=>({userId:id}),
    expectedCsrf:()=> 'test-csrf-proof',
  });
  const config={get:()=>['http://localhost:3000']};
  const request={headers:{
    cookie:'__Host-renivet_session='+'A'.repeat(43),
    origin:'http://localhost:3000',
    'sec-fetch-site':'same-origin',
    'x-csrf-token':'test-csrf-proof',
  }};
  const controller=new BrandApplicationsController({pool},auth(user),config);
  const name=`Renivet Demo Brand ${suffix.slice(0,12)}`;
  const body={legalName:`Renivet Demo Legal ${suffix.slice(0,12)}`,brandName:name};
  const first=await controller.apply(body,request);
  assert.equal(first.brandState,'pending');
  assert.equal(first.membershipState,'pending');
  const mine=await controller.mine(request);
  assert.ok(mine.items.some(item=>item.brandId===first.brandId && item.brandName===name));
  const row=(await pool.query(
    "SELECT b.onboarding_state,m.membership_state,m.user_id FROM brands.brands b JOIN brands.brand_memberships m ON m.brand_id=b.id WHERE b.id=$1",
    [first.brandId])).rows[0];
  assert.equal(row.onboarding_state,'pending');
  assert.equal(row.membership_state,'pending');
  assert.equal(row.user_id,user);
  const again=await controller.apply(body,request);
  assert.equal(again.brandId,first.brandId);
  const otherController=new BrandApplicationsController({pool},auth(other),config);
  await assert.rejects(otherController.apply(body,request),e=>e.getStatus?.()===409);
  await assert.rejects(controller.apply({...body,pan:'NOT_ALLOWED'},request),e=>e.getStatus?.()===422);
  await assert.rejects(controller.apply(body,{headers:{...request.headers,'x-csrf-token':'wrong'}}),e=>e.status===403 || e.getStatus?.()===403);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM brands.brands WHERE id=$1',[first.brandId])).rows[0].count,1);
});
