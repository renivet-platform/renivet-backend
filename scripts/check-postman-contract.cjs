'use strict';

const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');
const openapi = JSON.parse(readFileSync(resolve(root, 'openapi/renivet.openapi.json'), 'utf8'));
const collections = [
  'renivet-backend-auth.postman_collection.json',
  'renivet-backend-otp.postman_collection.json',
].map((name) => JSON.parse(readFileSync(resolve(root, 'postman/collections', name), 'utf8')));

function visit(items) {
  return items.flatMap((item) => item.item ? visit(item.item) : [item]);
}

const operations = new Set();
const requests = collections.flatMap((collection) => {
  const apiBase = collection.variable.find((variable) => variable.key === 'apiBaseUrl')?.value;
  if (!apiBase) throw new Error(`${collection.info.name}: must define apiBaseUrl`);
  const apiBasePath = new URL(apiBase).pathname.replace(/\/$/, '');
  return visit(collection.item).map((item) => ({ collection, apiBasePath, item }));
});
for (const { collection, apiBasePath, item } of requests) {
  const request = item.request;
  const url = typeof request.url === 'string' ? request.url : request.url?.raw;
  if (!url?.startsWith('{{apiBaseUrl}}/')) throw new Error(`${item.name}: URL must use {{apiBaseUrl}}`);
  if (/https?:\/\/(?!\{\{apiBaseUrl\}\})/i.test(url)) throw new Error(`${item.name}: hardcoded URL is not permitted`);
  const path = `${apiBasePath}${url.slice('{{apiBaseUrl}}'.length)}`
    .replace(/\{\{(?:otpChallengeId|unknownChallengeId)\}\}/g, '{challengeId}')
    .replace(/\{\{[^}]+\}\}/g, 'synthetic');
  const key = `${request.method.toLowerCase()} ${path}`;
  operations.add(key);
  if (!/REN2-\d+/.test(item.request.description ?? '')) throw new Error(`${item.name}: description must reference a Linear issue`);
  if (!Array.isArray(item.event) || !item.event.some((event) => event.listen === 'test')) {
    throw new Error(`${item.name}: runnable Postman test assertions are required`);
  }
}

for (const operation of operations) {
  const [method, path] = operation.split(' ');
  if (!openapi.paths[path]?.[method]) throw new Error(`Postman operation ${operation} is missing from generated OpenAPI`);
}

for (const path of ['/api/v1/auth/register', '/api/v1/auth/sessions']) {
  if (!openapi.paths[path]) throw new Error(`Expected implemented identity route ${path} is absent from OpenAPI`);
}
for (const path of ['/api/v1/auth/challenges', '/api/v1/auth/challenges/{challengeId}/verify']) {
  if (!openapi.paths[path]) throw new Error(`Expected implemented OTP route ${path} is absent from OpenAPI`);
}

process.stdout.write(`Postman/OpenAPI drift check passed (${requests.length} requests, ${operations.size} unique operations, 4 implemented routes).\n`);
