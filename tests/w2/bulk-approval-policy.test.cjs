'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { transitionBulkImportReview, bulkImportMayPublish } = require('../../dist/modules/imports/bulk-approval-policy.js');

const staged = () => ({ state:'STAGED', version:1, brandId:'brand-a',
  submittedBy:null, reviewedBy:null, fields:['CATALOG','VARIANT','PRICE','MEDIA','CATEGORY','ATTRIBUTES'], rejectionReason:null });
const editor = { userId:'seller', brandId:'brand-a', role:'BRAND_EDITOR' };
const reviewer = { userId:'reviewer', brandId:'brand-a', role:'AUTHORISED_REVIEWER' };

test('full catalog row can be submitted once and approved by a different authorised reviewer', () => {
  const submitted = transitionBulkImportReview(staged(), 'SUBMIT', editor, 1);
  assert.equal(submitted.ok, true);
  assert.equal(submitted.next.state, 'PENDING_REVIEW');
  assert.deepEqual(submitted.next.fields, staged().fields);
  const approved = transitionBulkImportReview(submitted.next, 'APPROVE', reviewer, 2);
  assert.equal(approved.ok, true);
  assert.equal(approved.next.state, 'APPROVED');
  assert.equal(bulkImportMayPublish(approved.next), false, 'catalog approval alone never publishes a product');
});

test('reviewer can reject with reason; rejection cannot publish', () => {
  const pending = transitionBulkImportReview(staged(), 'SUBMIT', editor, 1).next;
  const rejected = transitionBulkImportReview(pending, 'REJECT', reviewer, 2, 'Invalid brand assets');
  assert.equal(rejected.ok, true);
  assert.equal(rejected.next.rejectionReason, 'Invalid brand assets');
  assert.equal(bulkImportMayPublish(rejected.next), false);
  assert.equal(transitionBulkImportReview(rejected.next, 'APPROVE', reviewer, 3).ok, false);
});

test('enforce brand scope, revision, reviewer identity and rejection reason', () => {
  assert.equal(transitionBulkImportReview(staged(), 'SUBMIT', { ...editor, brandId:'brand-b' }, 1).ok, false);
  assert.equal(transitionBulkImportReview(staged(), 'SUBMIT', editor, 99).ok, false);
  const pending = transitionBulkImportReview(staged(), 'SUBMIT', editor, 1).next;
  assert.equal(transitionBulkImportReview(pending, 'APPROVE', editor, 2).ok, false);
  assert.equal(transitionBulkImportReview(pending, 'APPROVE', { ...reviewer, userId:'seller' }, 2).ok, false);
  assert.equal(transitionBulkImportReview(pending, 'REJECT', reviewer, 2, ' ').ok, false);
});
