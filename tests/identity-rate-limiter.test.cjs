const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthRateLimiter, AuthRateLimitExceededError, AuthRateLimitUnavailableError } = require('../dist/modules/identity/rate-limiter');

test('rate-limit Redis keys conceal account and IP identifiers', async () => {
  const calls = [];
  const limiter = new AuthRateLimiter({
    eval: async (...args) => { calls.push(args); return 1; },
  }, 'synthetic-rate-limit-key-for-tests-only');

  await limiter.consume('login-account', 'buyer@example.test', { limit: 5, windowSeconds: 900 });
  assert.equal(calls.length, 1);
  assert.match(calls[0][2], /^renivet:auth:v1:login-account:[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(calls).includes('buyer@example.test'), false);
  assert.equal(JSON.stringify(calls).includes('synthetic-rate-limit-key-for-tests-only'), false);
});

test('rate limit allows the configured count and rejects the next attempt', async () => {
  let count = 0;
  const limiter = new AuthRateLimiter({ eval: async () => [++count, 17] }, 'synthetic-rate-limit-key-for-tests-only');
  const rule = { limit: 2, windowSeconds: 42 };
  await limiter.consume('login-ip', '127.0.0.1', rule);
  await limiter.consume('login-ip', '127.0.0.1', rule);
  await assert.rejects(
    limiter.consume('login-ip', '127.0.0.1', rule),
    (error) => error instanceof AuthRateLimitExceededError && error.retryAfterSeconds === 17,
  );
});

test('Redis failures fail closed with a redacted error', async () => {
  const limiter = new AuthRateLimiter({ eval: async () => { throw new Error('redis URL contains secret'); } }, 'synthetic-rate-limit-key-for-tests-only');
  await assert.rejects(
    limiter.consume('login-ip', '127.0.0.1', { limit: 5, windowSeconds: 900 }),
    (error) => error instanceof AuthRateLimitUnavailableError && !error.message.includes('secret'),
  );
});

test('concurrent first requests share one lazy Redis connection', async () => {
  let status = 'wait';
  let connections = 0;
  let calls = 0;
  const redis = {
    get status() { return status; },
    async connect() {
      connections += 1;
      status = 'connecting';
      await new Promise((resolve) => setTimeout(resolve, 5));
      status = 'ready';
    },
    async eval() { calls += 1; return calls; },
  };
  const limiter = new AuthRateLimiter(redis, 'synthetic-rate-limit-key-for-tests-only');
  await Promise.all([
    limiter.consume('login', 'first-account', { limit: 5, windowSeconds: 900 }),
    limiter.consume('login', 'second-account', { limit: 5, windowSeconds: 900 }),
  ]);
  assert.equal(connections, 1);
  assert.equal(calls, 2);
});
