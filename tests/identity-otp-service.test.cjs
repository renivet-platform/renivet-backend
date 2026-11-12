const test = require('node:test');
const assert = require('node:assert/strict');
const { OtpChallengeService, OtpChallengeError, makeOtpProof } = require('../dist/modules/identity/otp-challenge.service');

function fixture(overrides = {}) {
  const calls = [];
  const repository = {
    findChallengeTarget: async (_channel, _purpose, destination) => ({ userId: 'user-1', destination }),
    issue: async (input) => { calls.push(['issue', input]); return true; },
    invalidate: async (id) => calls.push(['invalidate', id]),
    verify: async (input) => { calls.push(['verify', input]); return 'verified'; },
    ...overrides.repository,
  };
  const limiter = {
    consume: async (...args) => calls.push(['limit', ...args]),
    withLock: async (_scope, _identity, _ttl, callback) => callback(),
    ...overrides.limiter,
  };
  const delivery = overrides.delivery ?? { available: true, send: async (message) => calls.push(['send', message]) };
  const service = new OtpChallengeService(repository, limiter, delivery, {
    hmacKey: 'synthetic-challenge-proof-key-never-use-in-production',
    ttlSeconds: 300,
    maxAttempts: 5,
    resendCooldownSeconds: 60,
    resendWindowSeconds: 900,
    resendMax: 3,
    ...overrides.options,
  }, overrides.passwords ?? { hash: async (password) => `argon2id-synthetic:${password}` });
  return { service, calls };
}

test('challenge issue generates six digits, normalizes email, persists only proof, and delivers transient code', async () => {
  const { service, calls } = fixture();
  const result = await service.issue({ channel: 'email', purpose: 'email_verification', destination: ' Buyer@Example.Test ' }, '127.0.0.1');
  assert.equal(result.status, 'accepted');
  const issue = calls.find(([kind]) => kind === 'issue')[1];
  const sent = calls.find(([kind]) => kind === 'send')[1];
  assert.match(sent.code, /^\d{6}$/);
  assert.equal(issue.destination, 'buyer@example.test');
  assert.match(issue.codeHash, /^[a-f0-9]{64}$/);
  assert.notEqual(issue.codeHash, sent.code);
  assert.equal(JSON.stringify(calls.filter(([kind]) => kind === 'issue')).includes(sent.code), false);
});

test('challenge proof binds challenge, owner, channel, purpose, contact and code', () => {
  const base = { challengeId: 'id', userId: 'user', channel: 'email', purpose: 'email_verification', destination: 'a@example.test', code: '123456' };
  const digest = makeOtpProof('key', base);
  assert.equal(digest.length, 64);
  for (const changed of ['challengeId', 'userId', 'channel', 'purpose', 'destination', 'code']) {
    assert.notEqual(makeOtpProof('key', { ...base, [changed]: `${base[changed]}-changed` }), digest);
  }
});

test('unknown contacts produce neutral accepted response without sending', async () => {
  const { service, calls } = fixture({ repository: { findChallengeTarget: async () => null } });
  const result = await service.issue({ channel: 'email', purpose: 'email_verification', destination: 'unknown@example.test' }, '127.0.0.1');
  assert.equal(result.status, 'accepted');
  assert.match(result.challengeId, /^[0-9a-f-]{36}$/i);
  assert.equal(calls.some(([kind]) => kind === 'send'), false);
});

test('email and phone normalization is strict and channel-purpose pairs cannot cross', async () => {
  const { service } = fixture();
  await assert.rejects(service.issue({ channel: 'email', purpose: 'email_verification', destination: 'not an email' }, '127.0.0.1'), (error) => error instanceof OtpChallengeError && error.status === 400);
  await assert.rejects(service.issue({ channel: 'phone', purpose: 'email_verification', destination: '+14155550100' }, '127.0.0.1'), (error) => error instanceof OtpChallengeError && error.status === 400);
  await assert.rejects(service.issue({ channel: 'phone', purpose: 'phone_verification', destination: '4155550100' }, '127.0.0.1'), (error) => error instanceof OtpChallengeError && error.status === 400);
});

test('provider outage invalidates the persisted challenge and preserves neutral accepted response', async () => {
  const { service, calls } = fixture({ delivery: { available: true, send: async () => { throw new Error('provider secret'); } } });
  const result = await service.issue({ channel: 'email', purpose: 'email_verification', destination: 'buyer@example.test' }, '127.0.0.1');
  assert.equal(result.status, 'accepted');
  assert.equal(calls.some(([kind]) => kind === 'invalidate'), true);
});

test('hung delivery is aborted at its deadline and does not leave a usable challenge', async () => {
  let aborted = false;
  const { service, calls } = fixture({
    options: { deliveryTimeoutMilliseconds: 10 },
    delivery: { available: true, send: async (_message, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true })) },
  });
  const result = await service.issue({ channel: 'email', purpose: 'email_verification', destination: 'buyer@example.test' }, '127.0.0.1');
  assert.equal(result.status, 'accepted');
  assert.equal(aborted, true);
  assert.equal(calls.some(([kind]) => kind === 'invalidate'), true);
});

test('throttle errors happen before contact lookup or provider side effects', async () => {
  let lookedUp = false;
  const { service } = fixture({ repository: { findChallengeTarget: async () => { lookedUp = true; return null; } }, limiter: { consume: async () => { throw new Error('limited'); } } });
  await assert.rejects(service.issue({ channel: 'email', purpose: 'email_verification', destination: 'buyer@example.test' }, '127.0.0.1'));
  assert.equal(lookedUp, false);
});

test('issue limits are scoped by IP, canonical identity, purpose, resend window, and cooldown', async () => {
  const { service, calls } = fixture();
  await service.issue({ channel: 'email', purpose: 'email_verification', destination: ' Buyer@Example.Test ' }, '198.51.100.5');
  const limits = calls.filter(([kind]) => kind === 'limit');
  assert.deepEqual(limits.map(([, scope]) => scope), ['otp-issue-ip', 'otp-issue-identity', 'otp-resend-window', 'otp-resend-cooldown']);
  assert.equal(limits[0][2], '198.51.100.5');
  assert.equal(limits[1][2], 'email:email_verification:buyer@example.test');
  assert.equal(limits[2][3].limit, 4, 'three resends plus the initial issue are allowed in the configured window');
  assert.equal(limits[3][3].limit, 1);
});

test('verification delegates wrong, expired, replayed and purpose-mismatched proofs to generic denial', async () => {
  const { service } = fixture({ repository: { verify: async () => 'denied' } });
  await assert.rejects(service.verify({ challengeId: 'not-a-real-id', purpose: 'phone_verification', code: '000000' }, '127.0.0.1'), (error) => error instanceof OtpChallengeError && error.status === 401);
});

test('delivery unavailable rejects uniformly before identity lookup', async () => {
  let lookedUp = false;
  const { service } = fixture({ repository: { findChallengeTarget: async () => { lookedUp = true; return null; } }, delivery: { available: false, send: async () => undefined } });
  await assert.rejects(service.issue({ channel: 'email', purpose: 'email_verification', destination: 'unknown@example.test' }, '127.0.0.1'), (error) => error instanceof OtpChallengeError && error.status === 503);
  assert.equal(lookedUp, false);
});

test('password recovery hashes the replacement password before purpose-bound proof consumption', async () => {
  const { service, calls } = fixture();
  const result = await service.verify({
    challengeId: '37a7d0bf-8414-4f75-bd11-311c7a442d84',
    purpose: 'password_recovery', code: '123456', newPassword: 'synthetic replacement passphrase',
  }, '127.0.0.1');
  assert.deepEqual(result, { status: 'verified' });
  const proof = calls.find(([kind]) => kind === 'verify')[1];
  assert.equal(proof.purpose, 'password_recovery');
  assert.equal(proof.passwordHash, 'argon2id-synthetic:synthetic replacement passphrase');
  assert.notEqual(proof.passwordHash, 'synthetic replacement passphrase');
});

test('recovery proof rejects missing/invalid replacement passphrase and rejects new passwords for other purposes', async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.verify({ challengeId: '37a7d0bf-8414-4f75-bd11-311c7a442d84', purpose: 'password_recovery', code: '123456' }, '127.0.0.1'), (error) => error.status === 400);
  await assert.rejects(service.verify({ challengeId: '37a7d0bf-8414-4f75-bd11-311c7a442d84', purpose: 'email_verification', code: '123456', newPassword: 'synthetic replacement passphrase' }, '127.0.0.1'), (error) => error.status === 400);
  assert.equal(calls.some(([kind]) => kind === 'verify'), false);
});

test('recovery rate limit is consumed before expensive password hashing', async () => {
  let hashed = false;
  const { service } = fixture({
    limiter: { consume: async () => { throw new Error('rate limited'); } },
    passwords: { hash: async () => { hashed = true; return 'unused'; } },
  });
  await assert.rejects(service.verify({
    challengeId: '37a7d0bf-8414-4f75-bd11-311c7a442d84',
    purpose: 'password_recovery', code: '123456', newPassword: 'synthetic replacement passphrase',
  }, '127.0.0.1'));
  assert.equal(hashed, false);
});

test('Redis outage during verification fails closed before PostgreSQL verification', async () => {
  let verified = false;
  const { service } = fixture({
    repository: { verify: async () => { verified = true; return 'verified'; } },
    limiter: { consume: async () => { throw new Error('redis unavailable'); } },
  });
  await assert.rejects(service.verify({ challengeId: '37a7d0bf-8414-4f75-bd11-311c7a442d84', purpose: 'email_verification', code: '123456' }, '127.0.0.1'), (error) => error instanceof OtpChallengeError && error.status === 503);
  assert.equal(verified, false);
});

test('channel-specific delivery capability prevents the SMS provider from being used for email', async () => {
  let lookedUp = false;
  let sent = false;
  const { service } = fixture({
    repository: { findChallengeTarget: async (_channel, _purpose, destination) => { lookedUp = true; return { userId: 'user-1', destination }; } },
    delivery: {
      available: true,
      availableFor: (channel, purpose) => channel === 'phone' && purpose === 'phone_verification',
      send: async () => { sent = true; },
    },
  });
  await assert.rejects(
    service.issue({ channel: 'email', purpose: 'email_verification', destination: 'buyer@example.test' }, '127.0.0.1'),
    (error) => error instanceof OtpChallengeError && error.status === 503,
  );
  assert.equal(lookedUp, false);
  assert.equal(sent, false);
});
