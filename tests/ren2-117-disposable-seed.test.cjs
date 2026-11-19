'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

const script='scripts/seed-ren2-117-disposable-reviews.cjs';

test('REN2-117 disposable review seed parses and cannot run without an explicit opt-in',()=>{
  const check=spawnSync(process.execPath,['--check',script],{encoding:'utf8'});
  assert.equal(check.status,0,check.stderr);
  const result=spawnSync(process.execPath,[script],{
    env:{...process.env,RENIVET_ALLOW_DISPOSABLE_SEED:'0',RENIVET_TEST_DATABASE_URL:''},
    encoding:'utf8'
  });
  assert.notEqual(result.status,0,'seed must refuse normal or missing database configuration');
  const source=readFileSync(script,'utf8');
  for(const guard of ["RENIVET_ALLOW_DISPOSABLE_SEED","127.0.0.1","renivet_ci","NODE_ENV","BEGIN","ROLLBACK"]) assert.ok(source.includes(guard),guard);
  assert.ok(!source.includes("process.env.DATABASE_URL"),'never seed the default application database');
});
