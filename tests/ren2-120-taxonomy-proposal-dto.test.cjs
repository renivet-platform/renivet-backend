'use strict';

require('reflect-metadata');
const assert=require('node:assert/strict');
const test=require('node:test');
const {CategorySchemaProposalDto}=require('../dist/modules/catalog/taxonomy-admin.dto.js');
const {TaxonomyAdminService}=require('../dist/modules/catalog/taxonomy-admin.service.js');

const categoryId='11111111-2222-4333-8444-555555555555';
const rule={attributeId:'99999999-aaaa-4bbb-8ccc-111111111111',code:'fit',scope:'product',
  valueType:'enum',allowedValues:['regular','relaxed'],requiredByDefault:false};
const context={actorId:'11111111-2222-4333-8444-555555555555',requestId:'test-dto',idempotencyKey:'dto-regression'};

test('transformed CategorySchemaProposalDto reaches repository as a strictly validated plain object',async()=>{
  let saved;
  const service=new TaxonomyAdminService({
    propose:async(input)=>{saved=input;return {status:'draft_submitted',id:categoryId};}
  });
  const dto=Object.assign(new CategorySchemaProposalDto(),{
    categoryId,version:1,validatorVersion:'w2-attribute-validator-v1',ruleset:{attributes:[rule]},
  });
  const result=await service.propose(dto,context);
  assert.equal(result.status,'draft_submitted');
  assert.ok(saved);
  assert.equal(Object.getPrototypeOf(saved),Object.prototype);
  assert.equal(saved.ruleset.attributes.length,1);
  assert.equal(saved.ruleset.attributes[0].code,'fit');
});

test('DTO normalization still rejects invalid nested attribute values',async()=>{
  let calls=0;
  const service=new TaxonomyAdminService({propose:async()=>{calls++;}});
  const dto=Object.assign(new CategorySchemaProposalDto(),{
    categoryId,version:1,validatorVersion:'w2-attribute-validator-v1',
    ruleset:{attributes:[{...rule,valueType:'not_a_valid_type'}]},
  });
  await assert.rejects(service.propose(dto,context),error=>error.getStatus?.()===400);
  assert.equal(calls,0);
});

test('DTO normalization rejects invalid versions rather than skipping validation',async()=>{
  const service=new TaxonomyAdminService({propose:async()=>{throw Error('Should not persist')}});
  const dto=Object.assign(new CategorySchemaProposalDto(),{
    categoryId,version:0,validatorVersion:'w2-attribute-validator-v1',ruleset:{attributes:[rule]},
  });
  await assert.rejects(service.propose(dto,context),error=>error.getStatus?.()===400);
});
