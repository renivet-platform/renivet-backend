'use strict';

const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');
const openapi = JSON.parse(readFileSync(resolve(root, 'openapi/renivet.openapi.json'), 'utf8'));
const collections = [
  'renivet-backend-auth.postman_collection.json',
  'renivet-backend-otp.postman_collection.json',
  'renivet-backend-taxonomy-admin.postman_collection.json',
  'renivet-backend-taxonomy-read.postman_collection.json',
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
    .replace(/\{\{(?:otpChallengeId|unknownChallengeId|recoveryChallengeId)\}\}/g, '{challengeId}')
    .replace(/\{\{brandId\}\}/g, '{brandId}')
    .replace(/\{\{categoryId\}\}/g, '{categoryId}')
    .replace(/\{\{schemaVersion\}\}/g, '{version}')
    .replace(/\{\{[^}]+\}\}/g, 'synthetic').split('?')[0];
  const key = `${request.method.toLowerCase()} ${path}`;
  operations.add(key);
  if (!/REN2-\d+/.test(item.request.description ?? '')) throw new Error(`${item.name}: description must reference a Linear issue`);
  if (!Array.isArray(item.event) || !item.event.some((event) => event.listen === 'test')) {
    throw new Error(`${item.name}: runnable Postman test assertions are required`);
  }
  if (request.header?.some((header) => header.key.toLowerCase() === 'cookie') && item.protocolProfileBehavior?.disableCookies !== true) {
    throw new Error(`${item.name}: disable Postman cookie-jar injection when supplying an explicit session Cookie header`);
  }
}

for (const operation of operations) {
  const [method, path] = operation.split(' ');
  if (!openapi.paths[path]?.[method]) throw new Error(`Postman operation ${operation} is missing from generated OpenAPI`);
}

for (const path of ['/api/v1/auth/register', '/api/v1/auth/sessions', '/api/v1/auth/session']) {
  if (!openapi.paths[path]) throw new Error(`Expected implemented identity route ${path} is absent from OpenAPI`);
}
for (const path of ['/api/v1/auth/challenges', '/api/v1/auth/challenges/{challengeId}/verify']) {
  if (!openapi.paths[path]) throw new Error(`Expected implemented OTP route ${path} is absent from OpenAPI`);
}
for (const path of ['/api/v1/auth/mfa', '/api/v1/auth/mfa/enrollments', '/api/v1/auth/mfa/enrollments/verify', '/api/v1/auth/mfa/step-up', '/api/v1/auth/mfa/factor']) {
  if (!openapi.paths[path]) throw new Error(`Expected implemented MFA route ${path} is absent from OpenAPI`);
  if (!operations.has(`${path.endsWith('/mfa') ? 'get' : path.endsWith('/factor') ? 'delete' : 'post'} ${path}`)) {
    throw new Error(`Implemented MFA operation ${path} is missing from the handwritten Postman collection`);
  }
}
for (const [method, path] of [
  ['post', '/api/v1/admin/catalog/categories/{categoryId}/schema-versions'],
  ['post', '/api/v1/admin/catalog/categories/{categoryId}/schema-versions/{version}/publish'],
]) {
  if (!openapi.paths[path]?.[method]) throw new Error(`Expected implemented taxonomy route ${method.toUpperCase()} ${path} is absent from OpenAPI`);
  if (!operations.has(`${method} ${path}`)) throw new Error(`Implemented taxonomy operation ${method.toUpperCase()} ${path} is missing from the handwritten Postman collection`);
}
for (const [method, path] of [
  ['get', '/api/v1/brands/{brandId}/categories'],
  ['get', '/api/v1/brands/{brandId}/categories/{categoryId}/attributes'],
  ['get', '/api/v1/brands/{brandId}/categories/{categoryId}/schema-versions/{version}'],
]) {
  if (!openapi.paths[path]?.[method]) throw new Error(`Expected implemented taxonomy read route ${method.toUpperCase()} ${path} is absent from OpenAPI`);
  if (!operations.has(`${method} ${path}`)) throw new Error(`Implemented taxonomy read operation ${method.toUpperCase()} ${path} is missing from the handwritten Postman collection`);
}
const mfaRequests = requests.filter(({ item }) => item.name.includes('MFA') || item.name.includes('factor') || item.name.includes('authenticator'));
for (const { item } of mfaRequests) {
  const description = item.request.description ?? '';
  for (const section of ['Purpose:', 'Parameters:', 'Body:', 'Authentication/permissions:', 'Responses:', 'Linear: REN2-24']) {
    if (!description.includes(section)) throw new Error(`${item.name}: MFA request description must include ${section}`);
  }
}

const implementedRoutes = Object.keys(openapi.paths).filter((path) => path.startsWith('/api/v1/auth/') || path.startsWith('/api/v1/admin/') || path === '/api/v1/health').length;
process.stdout.write(`Postman/OpenAPI drift check passed (${requests.length} requests, ${operations.size} unique operations, ${implementedRoutes} implemented routes).\n`);
