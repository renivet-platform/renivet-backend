'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const yaml = require('js-yaml');
const { MODULE_METADATA } = require('@nestjs/common/constants');
const { FASTIFY_BODY_LIMIT_BYTES } = require('../dist/config/http-limits.js');
const { MediaModule } = require('../dist/modules/media/media.module.js');
const { MAX_REMOTE_MEDIA_IMAGES } = require('../dist/modules/media/media-zip.dto.js');

test('REN2-82 bounds JSON bodies for a 12k mapping and caps remote URL lists to the transport budget', () => {
  assert.equal(FASTIFY_BODY_LIMIT_BYTES, 2 * 1024 * 1024);
  assert.equal(MAX_REMOTE_MEDIA_IMAGES, 400);
  const mainSource = readFileSync('src/main.ts', 'utf8');
  assert.match(mainSource, /new FastifyAdapter\(\{\s*bodyLimit:\s*FASTIFY_BODY_LIMIT_BYTES\s*\}\)/);
  const candidate = yaml.load(readFileSync('openapi/W2_v1_5_CANDIDATE.yaml', 'utf8'));
  assert.equal(candidate.components.schemas.CreateMediaZipMappingManifest.properties.mappings.maxItems, 12000);
  assert.equal(candidate.components.schemas.ZipImport.properties.remoteImages.maxItems, MAX_REMOTE_MEDIA_IMAGES);
});

test('REN2-82 media ZIP HTTP endpoints stay dormant until runtime activation gates pass', () => {
  const controllers = Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, MediaModule);
  assert.ok(!controllers.some((controller) => controller.name === 'MediaZipController'));
  const active = JSON.parse(readFileSync('openapi/renivet.openapi.json', 'utf8'));
  for (const operationId of ['createMediaZipMappingManifest','createMediaZipImport','getMediaZipImportStatus']) {
    assert.ok(!JSON.stringify(active.paths).includes(operationId));
  }
});
