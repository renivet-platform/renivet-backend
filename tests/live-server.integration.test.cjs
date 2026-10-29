'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');

async function reservePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

test('staging HTTP server is live while Swagger and unfinished commerce routes stay unavailable', { timeout: 30000 }, async () => {
  const port = await reservePort();
  const runtime = spawn(process.execPath, ['dist/main.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'staging',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATABASE_URL: 'postgres://app:stage-test-only@localhost:5432/renivet',
      REDIS_URL: 'redis://localhost:6379',
      TYPESENSE_URL: 'http://localhost:8108',
      TYPESENSE_API_KEY: 'stage-test-key-not-a-real-secret',
      PYTHON_SERVICE_URL: 'http://localhost:8000',
      AUTH_RATE_LIMIT_HMAC_KEY: 'stage-test-rate-limit-key-not-a-real-secret-000000',
      AUTH_CHALLENGE_HMAC_KEY: 'stage-test-challenge-proof-key-not-a-real-secret-000000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  for (const stream of [runtime.stdout, runtime.stderr]) {
    stream.on('data', (chunk) => { log = (log + chunk.toString()).slice(-2500); });
  }
  const base = `http://127.0.0.1:${port}`;
  try {
    let healthy = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (runtime.exitCode !== null) break;
      try {
        const response = await fetch(`${base}/api/v1/health`, {
          signal: AbortSignal.timeout(800),
        });
        if (response.status === 200) {
          assert.deepEqual(await response.json(), { status: 'ok', service: 'renivet-backend' });
          healthy = true;
          break;
        }
      } catch { /* Server is starting. */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(healthy, `Backend did not become healthy: ${log}`);
    for (const path of ['/docs', '/docs-json', '/api/v1/checkout', '/api/v1/payments', '/api/v1/settlements']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 404, `Unexpectedly exposed ${path}`);
    }
  } finally {
    runtime.kill();
    if (runtime.exitCode === null && runtime.signalCode === null) {
      await Promise.race([
        once(runtime, 'exit'),
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    }
  }
});
