const test = require('node:test');
const assert = require('node:assert/strict');
const { validateEnvironment } = require('../dist/config/environment');

test('development defaults bind to loopback without requiring service credentials', () => {
  const config = validateEnvironment({});
  assert.equal(config.NODE_ENV, 'development');
  assert.equal(config.PORT, 4000);
  assert.equal(config.HOST, '127.0.0.1');
  assert.equal(config.DATABASE_URL, undefined);
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
  };
  assert.throws(() => validateEnvironment(environment), /DATABASE_URL/);
  environment.DATABASE_URL = 'postgres://app:different-password@db.internal:5432/renivet';
  environment.TYPESENSE_API_KEY = 'local-typesense-do-not-deploy';
  assert.throws(() => validateEnvironment(environment), /TYPESENSE_API_KEY/);
  environment.TYPESENSE_API_KEY = 'real-deployment-key';
  assert.equal(validateEnvironment(environment).PORT, 4000);
});

test('invalid URL errors never print supplied credential values', () => {
  const sensitive = 'dont-ever-log-this-secret';
  assert.throws(
    () => validateEnvironment({ DATABASE_URL: sensitive }),
    (err) => err instanceof Error && /DATABASE_URL/.test(err.message) && !err.message.includes(sensitive),
  );
});
