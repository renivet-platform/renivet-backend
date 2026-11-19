const assert = require('node:assert/strict');
const test = require('node:test');
const {randomUUID} = require('node:crypto');
const {AccessAuditController, readAuditCursor, nextAuditCursor} = require('../dist/modules/access/access-audit.controller.js');
const {REQUIRE_PLATFORM_PERMISSION, REQUIRE_PLATFORM_ADMIN_PERMISSION} = require('../dist/modules/access/platform-permission.guard.js');

test('AD-20 audit read requires global Renivet admin access_audit.read',()=>{
  assert.equal(Reflect.getMetadata(REQUIRE_PLATFORM_PERMISSION,AccessAuditController.prototype.list),'access_audit.read');
  assert.equal(Reflect.getMetadata(REQUIRE_PLATFORM_ADMIN_PERMISSION,AccessAuditController.prototype.list),true);
});

test('AD-20 audit cursors are canonical and reject arbitrary values',()=>{
  const value={occurredAt:'2026-11-19T04:00:00.000Z',id:randomUUID()};
  const encoded=nextAuditCursor(value);
  assert.deepEqual(readAuditCursor(encoded),value);
  for(const text of ['broken###','',Buffer.from(JSON.stringify({...value,extra:'injection'})).toString('base64url')]) assert.throws(()=>readAuditCursor(text),/AUDIT_PAGE_INVALID|Bad Request|audit page/i);
  assert.equal(readAuditCursor(undefined),null);
});

test('AD-20 audits are scoped to authorized admin, cannot select raw PII and page correctly',async()=>{
  const userId=randomUUID(),actorId=randomUUID(),entryId=randomUUID();
  let calls=0;
  const rows=[{id:entryId,action:'role.grant',actorUserId:actorId,subjectType:'brand',subjectId:randomUUID(),occurredAt:new Date('2026-11-19T04:00:00.000Z')}];
  const pool={query:async(sql,parameters)=>{
    calls+=1;
    assert.deepEqual(parameters,[userId,null,null,2]);
    assert.match(sql,/access\.security_audit_events/);
    assert.match(sql,/grants\.user_id=\$1/);
    assert.match(sql,/grants\.permission_code='access_audit\.read'/);
    assert.match(sql,/grants\.role_code='renivet_admin'/);
    assert.doesNotMatch(sql,/events\.ip_hash|events\.payload_hash/);
    return {rows};
  }};
  const controller=new AccessAuditController({pool});
  const result=await controller.list({platformPermission:{userId,permission:'access_audit.read'}},undefined,'1');
  assert.equal(calls,1);
  assert.equal(result.items.length,1);
  assert.equal(result.items[0].action,'role.grant');
  assert.equal(result.nextCursor,null);
  assert.ok(!Object.hasOwn(result.items[0],'payloadHash'));
});

test('AD-20 unauthenticated requests cannot query audit and database outages fail closed',async()=>{
  let called=false;
  const controller=new AccessAuditController({pool:{query:async()=>{called=true;return {rows:[]};}}});
  await assert.rejects(controller.list({},undefined,'20'),()=>true);
  assert.equal(called,false);
  await assert.rejects(new AccessAuditController({pool:null}).list({platformPermission:{userId:randomUUID(),permission:'access_audit.read'}}),()=>true);
});
