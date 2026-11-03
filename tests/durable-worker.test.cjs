'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DurableWorker,
  calculateRetryDelayMs,
  safeFailureCode,
} = require('../dist/workers/durable-worker.js');

test('retry delay uses bounded exponential backoff plus injected jitter', () => {
  assert.equal(calculateRetryDelayMs(1, { baseDelayMs: 1000, maxDelayMs: 10_000, jitterMs: 250, random: () => 0.9999 }), 1250);
  assert.equal(calculateRetryDelayMs(4, { baseDelayMs: 1000, maxDelayMs: 5000, jitterMs: 250, random: () => 0 }), 5000);
});

test('retry delay rejects invalid attempt and randomness values', () => {
  assert.throws(() => calculateRetryDelayMs(0), /attempt/i);
  assert.throws(() => calculateRetryDelayMs(1, { random: () => 2 }), /random/i);
});

test('failure details normalize to a safe code without preserving raw exception text', () => {
  const error = new Error('OTP 123456 for account; session=secret; bank=1234');
  error.code = 'ECONNRESET';
  assert.equal(safeFailureCode(error), 'ECONNRESET');
  assert.equal(safeFailureCode(new Error('sensitive raw error body')), 'WORKER_FAILURE');
  assert.equal(safeFailureCode({ code: 'bad input\npassword=x' }), 'WORKER_FAILURE');
  assert.equal(safeFailureCode({ code: 'OTP_123456' }), 'WORKER_FAILURE');
});

test('operator recovery fails closed when no authorization policy is configured', async () => {
  const worker = new DurableWorker({}, [{ consumerId: 'test-consumer', eventTypes: ['test.event'], authorization: { scope: 'system' }, async handle() {} }]);
  await assert.rejects(worker.recoverDeadLetter('case-id', 'actor-id', 'OPERATOR_RETRY'), /not authorized/);
  await assert.rejects(worker.runOnce('unregistered-consumer'), /not registered/);
});

test('brand-scoped consumers require an authorization port and declare purpose plus effects', () => {
  const handler = {
    consumerId: 'brand-media-worker',
    eventTypes: ['media.asset.ready'],
    authorization: { scope: 'brand', purpose: 'media.derivative', effects: ['media.derivative.create'] },
    async handle() {},
  };
  assert.throws(() => new DurableWorker({}, [handler]), /authorization provider/);
  assert.throws(() => new DurableWorker({}, [{ consumerId: 'implicit-scope', eventTypes: ['test.event'], async handle() {} }]), /declare an authorization scope/);
  assert.throws(() => new DurableWorker({}, [{ ...handler, authorization: { scope: 'brand', purpose: '', effects: [] } }], {
    workerAuthorization: { bindJob: async () => {}, authorize: async () => ({}) },
  }), /purpose and permitted effects/);
  assert.doesNotThrow(() => new DurableWorker({}, [handler], {
    workerAuthorization: { bindJob: async () => {}, authorize: async () => ({}) },
  }));
});
