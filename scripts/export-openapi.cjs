'use strict';

const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const { NestFactory } = require('@nestjs/core');
const { FastifyAdapter } = require('@nestjs/platform-fastify');
const { SwaggerModule } = require('@nestjs/swagger');
const { AppModule } = require('../dist/app.module');
const { createOpenApiConfig } = require('../dist/config/openapi');

async function main() {
  process.env.NODE_ENV = 'test';
  // Artifact generation never connects to a developer's configured services.
  process.env.DATABASE_URL = 'postgresql://artifact:artifact@127.0.0.1:1/unused';
  process.env.REDIS_URL = 'redis://127.0.0.1:1/15';
  process.env.AUTH_RATE_LIMIT_HMAC_KEY = 'artifact-generation-only-not-a-secret-00000000';
  const outputArgument = process.argv.indexOf('--output');
  const outputPath = resolve(outputArgument >= 0 ? process.argv[outputArgument + 1] : 'openapi/renivet.openapi.json');
  const app = await NestFactory.create(AppModule, new FastifyAdapter(), { logger: false });
  try {
    app.setGlobalPrefix('api/v1');
    const document = SwaggerModule.createDocument(app, createOpenApiConfig());
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  process.stderr.write(`OpenAPI export failed: ${error?.message ?? 'unknown error'}\n`);
  process.exitCode = 1;
});
