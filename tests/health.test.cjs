const test = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { NestFactory } = require('@nestjs/core');
const { FastifyAdapter } = require('@nestjs/platform-fastify');
const { AppModule } = require('../dist/app.module');

test('GET /api/v1/health responds without external dependencies', async () => {
  const app = await NestFactory.create(AppModule, new FastifyAdapter(), { logger: false });
  app.setGlobalPrefix('api/v1');
  try {
    await app.init();
    const fastify = app.getHttpAdapter().getInstance();
    await fastify.ready();
    const response = await fastify.inject({ method: 'GET', url: '/api/v1/health' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok', service: 'renivet-backend' });
    const unknown = await fastify.inject({ method: 'GET', url: '/api/v1/unknown' });
    assert.equal(unknown.statusCode, 404);
    // Reserved modules are not registered or exposed before owner policy approvals.
    for (const path of ['/api/v1/checkout', '/api/v1/payments', '/api/v1/settlements']) {
      const reserved = await fastify.inject({ method: 'GET', url: path });
      assert.equal(reserved.statusCode, 404, `Unexpected route exposed: ${path}`);
    }
  } finally {
    await app.close();
  }
});
