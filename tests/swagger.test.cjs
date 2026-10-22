const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldExposeSwagger } = require('../dist/config/swagger');

test('API documentation is disabled in staging and production', () => {
  assert.equal(shouldExposeSwagger('staging'), false);
  assert.equal(shouldExposeSwagger('production'), false);
});

test('API documentation stays available during local development and tests', () => {
  assert.equal(shouldExposeSwagger(undefined), true);
  assert.equal(shouldExposeSwagger('development'), true);
  assert.equal(shouldExposeSwagger('test'), true);
});
