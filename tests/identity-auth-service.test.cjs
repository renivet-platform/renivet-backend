const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthService, AuthHttpError } = require('../dist/modules/identity/auth.service');

const password = 'synthetic registration passphrase';
const options = {
  hmacKey: 'synthetic-rate-limit-key-for-tests-only',
  windowSeconds: 900,
  registerAccountLimit: 5,
  registerIpLimit: 30,
  loginAccountLimit: 5,
  loginIpLimit: 60,
  sessionTtlSeconds: 1800,
};

function createService(overrides = {}, serviceOptions = options) {
  const calls = { limits: [], registrations: [], lookups: [], sessions: [] };
  const repository = {
    createPendingAccount: async (email, passwordHash) => {
      calls.registrations.push({ email, passwordHash });
      return overrides.createPendingAccount ? overrides.createPendingAccount(email, passwordHash) : true;
    },
    findPasswordCredential: async (email) => {
      calls.lookups.push(email);
      return overrides.findPasswordCredential ? overrides.findPasswordCredential(email) : null;
    },
    createSession: async (session) => {
      calls.sessions.push(session);
      return overrides.createSession ? overrides.createSession(session) : true;
    },
  };
  const passwords = {
    hash: async (value) => `hash:${value}`,
    verifyOrDummy: async (hash, value) => overrides.verifyOrDummy
      ? overrides.verifyOrDummy(hash, value)
      : hash === `hash:${value}`,
  };
  const limiter = {
    consume: async (...args) => {
      calls.limits.push(args);
      if (overrides.consume) return overrides.consume(...args);
    },
  };
  return { service: new AuthService(repository, passwords, limiter, serviceOptions), calls };
}

test('registration canonicalizes contact, persists only a hash, and returns a neutral accepted result', async () => {
  const { service, calls } = createService();
  const result = await service.register({ email: '  BUYER@Example.Test ', password }, '127.0.0.1');
  assert.deepEqual(result, { status: 'accepted' });
  assert.equal(calls.registrations[0].email, 'buyer@example.test');
  assert.notEqual(calls.registrations[0].passwordHash, password);
  assert.equal(calls.limits.length, 2);
});

test('existing contact has the same registration response and is never merged or overwritten', async () => {
  const { service, calls } = createService({ createPendingAccount: async () => false });
  const result = await service.register({ email: 'buyer@example.test', password }, '127.0.0.1');
  assert.deepEqual(result, { status: 'accepted' });
  assert.equal(calls.registrations.length, 1);
  assert.equal(calls.registrations[0].email, 'buyer@example.test');
});

test('unknown, wrong-password, unverified, and inactive accounts share one authentication failure', async () => {
  const failureFor = async (credential, verifyResult) => {
    const { service } = createService({
      findPasswordCredential: async () => credential,
      verifyOrDummy: async () => verifyResult,
    });
    try {
      await service.login({ email: 'buyer@example.test', password }, '127.0.0.1');
      assert.fail('login should be denied');
    } catch (error) {
      assert.ok(error instanceof AuthHttpError);
      return { status: error.status, response: error.publicResponse };
    }
  };
  const outcomes = await Promise.all([
    failureFor(null, false),
    failureFor({ userId: 'user-a', state: 'active', emailVerifiedAt: new Date(), passwordHash: 'hash' }, false),
    failureFor({ userId: 'user-b', state: 'pending_verification', emailVerifiedAt: null, passwordHash: 'hash' }, true),
    failureFor({ userId: 'user-c', state: 'suspended', emailVerifiedAt: new Date(), passwordHash: 'hash' }, true),
  ]);
  assert.equal(new Set(outcomes.map((outcome) => JSON.stringify(outcome))).size, 1);
  assert.equal(outcomes[0].status, 401);
});

test('verified login stores only a digest and returns an opaque cookie secret', async () => {
  const { service, calls } = createService({
    findPasswordCredential: async () => ({
      userId: '18bd5b9a-15ca-4d51-83f1-209d0f202ef1',
      credentialId: 'd552dc7c-d352-44cc-82d8-8ec7cf649d12',
      state: 'active',
      emailVerifiedAt: new Date(),
      passwordHash: `hash:${password}`,
    }),
  });
  const result = await service.login({ email: 'buyer@example.test', password }, '127.0.0.1');
  assert.equal(result.userId, '18bd5b9a-15ca-4d51-83f1-209d0f202ef1');
  assert.match(result.sessionToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(calls.sessions[0].tokenHash, result.sessionToken);
  assert.match(calls.sessions[0].tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(calls.sessions[0].expiresAt.getTime() - Date.now() <= 1800_000, true);
});

test('login persists the configured absolute expiry and caps the initial cookie lifetime', async () => {
  const { service, calls } = createService({
    findPasswordCredential: async () => ({
      userId: '18bd5b9a-15ca-4d51-83f1-209d0f202ef1',
      credentialId: 'd552dc7c-d352-44cc-82d8-8ec7cf649d12',
      state: 'active', emailVerifiedAt: new Date(), passwordHash: `hash:${password}`,
    }),
  }, { ...options, sessionTtlSeconds: 1_800, absoluteSessionTtlSeconds: 900 });
  const before = Date.now();
  const result = await service.login({ email: 'buyer@example.test', password }, '127.0.0.1');
  const session = calls.sessions[0];
  assert.equal(result.expiresInSeconds, 900);
  assert.equal(session.expiresAt.getTime(), session.absoluteExpiresAt.getTime());
  assert.ok(session.absoluteExpiresAt.getTime() >= before + 900_000);
});

test('throttle and infrastructure errors become safe auth errors', async () => {
  const { service } = createService({ consume: async () => { throw new Error('private contact and key'); } });
  await assert.rejects(
    service.register({ email: 'buyer@example.test', password }, '127.0.0.1'),
    (error) => error instanceof AuthHttpError && error.status === 503 && !error.message.includes('private contact'),
  );
});
