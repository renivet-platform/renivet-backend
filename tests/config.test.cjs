const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEnvironment } = require('../dist/config/environment');

test('development defaults bind to loopback without requiring service credentials', () => {
  const config = validateEnvironment({});
  assert.equal(config.NODE_ENV, 'development');
  assert.equal(config.PORT, 4000);
  assert.equal(config.HOST, '127.0.0.1');
  assert.equal(config.DATABASE_URL, undefined);
  assert.equal(validateEnvironment({ AUTH_RATE_LIMIT_HMAC_KEY: 'local-only-set-a-random-32-byte-value' }).AUTH_RATE_LIMIT_HMAC_KEY, 'local-only-set-a-random-32-byte-value');
  assert.equal(config.SMTP_PORT, 587);
  assert.equal(config.SMTP_HOST, undefined);
});

test('SMTP configuration is optional, bounded, and rejects unsafe host and secure-mode values', () => {
  const config = validateEnvironment({ SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_SECURE: 'true' });
  assert.equal(config.SMTP_HOST, 'smtp.example.test');
  assert.equal(config.SMTP_PORT, 465);
  assert.equal(config.SMTP_SECURE, true);
  assert.equal(validateEnvironment({ SMTP_HOST: '', SMTP_PORT: '', SMTP_SECURE: '' }).SMTP_HOST, undefined);
  assert.throws(() => validateEnvironment({ SMTP_HOST: 'smtp.example.test\r\nBcc: attacker@example.test' }), /SMTP_HOST/);
  assert.throws(() => validateEnvironment({ SMTP_PORT: '65536' }), /SMTP_PORT/);
  assert.throws(() => validateEnvironment({ SMTP_SECURE: 'sometimes' }), /SMTP_SECURE/);
});

test('reject invalid NODE_ENV, ports, hosts and URLs with field-only errors', () => {
  assert.throws(() => validateEnvironment({ NODE_ENV: 'preview' }), /NODE_ENV/);
  for (const port of ['abc', '0', '65536', '4000.5']) {
    assert.throws(() => validateEnvironment({ PORT: port }), /PORT/);
  }
  assert.throws(() => validateEnvironment({ HOST: 'https://0.0.0.0' }), /HOST/);
  assert.throws(() => validateEnvironment({ DATABASE_URL: 'not-a-secret-url' }), /DATABASE_URL/);
  assert.throws(() => validateEnvironment({ REDIS_URL: 'https://cache.local' }), /REDIS_URL/);
  assert.throws(() => validateEnvironment({ TYPESENSE_URL: 'file:///tmp/search' }), /TYPESENSE_URL/);
  assert.throws(
    () => validateEnvironment({ PYTHON_SERVICE_URL: 'http://name:password@localhost:8000' }),
    /PYTHON_SERVICE_URL/,
  );
});

test('staging and production require explicit service settings', () => {
  for (const env of ['staging', 'production']) {
    assert.throws(() => validateEnvironment({ NODE_ENV: env }), /DATABASE_URL/);
  }
});

test('staging and production refuse known local credentials', () => {
  const environment = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://app:renivet_local_only@db.internal:5432/renivet',
    REDIS_URL: 'redis://cache.internal:6379',
    TYPESENSE_URL: 'https://search.internal:8108',
    PYTHON_SERVICE_URL: 'https://ai.internal:8000',
    TYPESENSE_API_KEY: 'real-deployment-key',
    AUTH_RATE_LIMIT_HMAC_KEY: 'synthetic-not-a-real-deployment-key-0000000000000000',
    AUTH_CHALLENGE_HMAC_KEY: 'synthetic-challenge-not-a-deployment-key-0000000000',
    AUTH_CSRF_HMAC_KEY: 'synthetic-csrf-not-a-deployment-key-00000000000000',
    AUTH_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 0x5a).toString('base64'),
    AUTH_ALLOWED_ORIGINS: 'https://app.example.test',
  };
  assert.throws(() => validateEnvironment(environment), /DATABASE_URL/);
  environment.DATABASE_URL = 'postgres://app:different-password@db.internal:5432/renivet';
  environment.TYPESENSE_API_KEY = 'local-typesense-do-not-deploy';
  assert.throws(() => validateEnvironment(environment), /TYPESENSE_API_KEY/);
  environment.TYPESENSE_API_KEY = 'real-deployment-key';
  assert.equal(validateEnvironment(environment).PORT, 4000);
});

test('protected environments require a private rate-limit HMAC key and bounded auth limits', () => {
  const environment = {
    NODE_ENV: 'staging',
    DATABASE_URL: 'postgres://app:deployment-only@db.internal:5432/renivet',
    REDIS_URL: 'redis://cache.internal:6379',
    TYPESENSE_URL: 'https://search.internal:8108',
    TYPESENSE_API_KEY: 'deployment-only-typesense-key',
    PYTHON_SERVICE_URL: 'https://ai.internal:8000',
    AUTH_CSRF_HMAC_KEY: 'synthetic-csrf-not-a-deployment-key-00000000000000',
    AUTH_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 0x5a).toString('base64'),
    AUTH_ALLOWED_ORIGINS: 'https://app.example.test',
  };
  assert.throws(() => validateEnvironment(environment), /AUTH_RATE_LIMIT_HMAC_KEY/);
  environment.AUTH_RATE_LIMIT_HMAC_KEY = 'short';
  environment.AUTH_CHALLENGE_HMAC_KEY = 'dedicated-not-a-real-deployment-key-0000000000000';
  assert.throws(() => validateEnvironment(environment), /AUTH_RATE_LIMIT_HMAC_KEY/);
  environment.AUTH_RATE_LIMIT_HMAC_KEY = 'local-only-set-a-random-32-byte-value';
  assert.throws(() => validateEnvironment(environment), /AUTH_RATE_LIMIT_HMAC_KEY/);
  environment.AUTH_RATE_LIMIT_HMAC_KEY = 'synthetic-not-a-real-deployment-key-0000000000000000';
  environment.AUTH_LOGIN_ACCOUNT_LIMIT = '0';
  assert.throws(() => validateEnvironment(environment), /AUTH_LOGIN_ACCOUNT_LIMIT/);
  environment.AUTH_LOGIN_ACCOUNT_LIMIT = '5';
  const config = validateEnvironment(environment);
  assert.equal(config.AUTH_RATE_LIMIT_WINDOW_SECONDS, 900);
  assert.equal(config.AUTH_LOGIN_ACCOUNT_LIMIT, 5);
});

test('invalid URL errors never print supplied credential values', () => {
  const sensitive = 'dont-ever-log-this-secret';
  assert.throws(
    () => validateEnvironment({ DATABASE_URL: sensitive }),
    (err) => err instanceof Error && /DATABASE_URL/.test(err.message) && !err.message.includes(sensitive),
  );
});

test('OTP runtime limits have approved defaults and reject values outside bounded ranges', () => {
  const config = validateEnvironment({});
  assert.equal(config.AUTH_CHALLENGE_TTL_SECONDS, 300);
  assert.equal(config.AUTH_CHALLENGE_MAX_ATTEMPTS, 5);
  assert.equal(config.AUTH_CHALLENGE_RESEND_COOLDOWN_SECONDS, 60);
  assert.equal(config.AUTH_CHALLENGE_RESEND_WINDOW_SECONDS, 900);
  assert.equal(config.AUTH_CHALLENGE_RESEND_MAX, 3);
  assert.throws(() => validateEnvironment({ AUTH_CHALLENGE_TTL_SECONDS: '0' }), /AUTH_CHALLENGE_TTL_SECONDS/);
  assert.throws(() => validateEnvironment({ AUTH_CHALLENGE_MAX_ATTEMPTS: '1001' }), /AUTH_CHALLENGE_MAX_ATTEMPTS/);
});

test('staging and production require a dedicated OTP challenge HMAC key', () => {
  const env = {
    NODE_ENV: 'staging',
    DATABASE_URL: 'postgres://app:deployment-only@db.internal:5432/renivet',
    REDIS_URL: 'redis://cache.internal:6379',
    TYPESENSE_URL: 'https://search.internal:8108',
    TYPESENSE_API_KEY: 'deployment-only-typesense-key',
    PYTHON_SERVICE_URL: 'https://ai.internal:8000',
    AUTH_RATE_LIMIT_HMAC_KEY: 'synthetic-not-a-real-deployment-key-0000000000000000',
    AUTH_CSRF_HMAC_KEY: 'synthetic-csrf-not-a-deployment-key-00000000000000',
    AUTH_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 0x5a).toString('base64'),
    AUTH_ALLOWED_ORIGINS: 'https://app.example.test',
  };
  assert.throws(() => validateEnvironment(env), /AUTH_CHALLENGE_HMAC_KEY/);
  env.AUTH_CHALLENGE_HMAC_KEY = 'dedicated-not-a-real-deployment-key-0000000000000';
  assert.equal(validateEnvironment(env).AUTH_CHALLENGE_HMAC_KEY, env.AUTH_CHALLENGE_HMAC_KEY);
  env.AUTH_CHALLENGE_HMAC_KEY = 'local-only-set-a-random-32-byte-value';
  assert.throws(() => validateEnvironment(env), /AUTH_CHALLENGE_HMAC_KEY/);
});

test('session CSRF origin configuration requires exact HTTPS origins and a dedicated HMAC key in protected environments', () => {
  const environment = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://app:deployment-only@db.internal:5432/renivet',
    REDIS_URL: 'redis://cache.internal:6379',
    TYPESENSE_URL: 'https://search.internal:8108',
    TYPESENSE_API_KEY: 'deployment-only-typesense-key',
    PYTHON_SERVICE_URL: 'https://ai.internal:8000',
    AUTH_RATE_LIMIT_HMAC_KEY: 'synthetic-rate-limit-key-not-a-real-deployment-value-0000',
    AUTH_CHALLENGE_HMAC_KEY: 'synthetic-challenge-key-not-a-real-deployment-value-000',
    AUTH_CSRF_HMAC_KEY: 'synthetic-csrf-key-not-a-real-deployment-value-00000000',
    AUTH_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 0x5a).toString('base64'),
  };
  assert.throws(() => validateEnvironment(environment), /AUTH_ALLOWED_ORIGINS/);
  environment.AUTH_ALLOWED_ORIGINS = 'http://app.example.test';
  assert.throws(() => validateEnvironment(environment), /AUTH_ALLOWED_ORIGINS/);
  environment.AUTH_ALLOWED_ORIGINS = 'https://app.example.test/path';
  assert.throws(() => validateEnvironment(environment), /AUTH_ALLOWED_ORIGINS/);
  environment.AUTH_ALLOWED_ORIGINS = 'https://app.example.test';
  assert.deepEqual(validateEnvironment(environment).AUTH_ALLOWED_ORIGINS, ['https://app.example.test']);
  environment.AUTH_CSRF_HMAC_KEY = environment.AUTH_RATE_LIMIT_HMAC_KEY;
  assert.throws(() => validateEnvironment(environment), /AUTH_CSRF_HMAC_KEY/);
});

test('session idle expiry cannot exceed the approved 30-minute limit', () => {
  assert.equal(validateEnvironment({}).AUTH_SESSION_IDLE_TTL_SECONDS, 1_800);
  assert.equal(validateEnvironment({ AUTH_SESSION_IDLE_TTL_SECONDS: '1200' }).AUTH_SESSION_IDLE_TTL_SECONDS, 1_200);
  assert.throws(() => validateEnvironment({ AUTH_SESSION_IDLE_TTL_SECONDS: '1801' }), /AUTH_SESSION_IDLE_TTL_SECONDS/);
});

test('protected environments require a dedicated canonical 32-byte MFA encryption key', () => {
  const environment = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgres://app:deployment-only@db.internal:5432/renivet',
    REDIS_URL: 'redis://cache.internal:6379',
    TYPESENSE_URL: 'https://search.internal:8108',
    TYPESENSE_API_KEY: 'deployment-only-typesense-key',
    PYTHON_SERVICE_URL: 'https://ai.internal:8000',
    AUTH_RATE_LIMIT_HMAC_KEY: 'synthetic-rate-limit-key-not-a-real-deployment-value-000000',
    AUTH_CHALLENGE_HMAC_KEY: 'synthetic-challenge-key-not-a-real-deployment-value-0000000',
    AUTH_CSRF_HMAC_KEY: 'synthetic-csrf-key-not-a-real-deployment-value-00000000000',
    AUTH_ALLOWED_ORIGINS: 'https://app.example.test',
  };
  assert.throws(() => validateEnvironment(environment), /AUTH_MFA_ENCRYPTION_KEY.*required/);
  environment.AUTH_MFA_ENCRYPTION_KEY = Buffer.alloc(32, 0x5a).toString('base64');
  assert.equal(validateEnvironment(environment).AUTH_MFA_ENCRYPTION_KEY, environment.AUTH_MFA_ENCRYPTION_KEY);
  environment.AUTH_MFA_ENCRYPTION_KEY = Buffer.alloc(31, 0x5a).toString('base64');
  assert.throws(() => validateEnvironment(environment), /AUTH_MFA_ENCRYPTION_KEY.*32 bytes/);
  environment.AUTH_MFA_ENCRYPTION_KEY = 'not-base64';
  assert.throws(() => validateEnvironment(environment), /AUTH_MFA_ENCRYPTION_KEY.*base64/);
});
