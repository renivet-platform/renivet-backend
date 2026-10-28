'use strict';

const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const root = resolve(__dirname, '..');
const collection = JSON.parse(readFileSync(resolve(root, 'postman/collections/renivet-backend-auth.postman_collection.json'), 'utf8'));
const openapi = JSON.parse(readFileSync(resolve(root, 'openapi/renivet.openapi.json'), 'utf8'));
const apiBase = collection.variable.find((variable) => variable.key === 'apiBaseUrl')?.value;
if (!apiBase) throw new Error('Postman collection must define apiBaseUrl');
const apiBasePath = new URL(apiBase).pathname.replace(/\/$/, '');

function visit(items) {
  return items.flatMap((item) => item.item ? visit(item.item) : [item]);
}

const operations = new Set();
const requests = visit(collection.item);
for (const item of requests) {
  const request = item.request;
  const url = typeof request.url === 'string' ? request.url : request.url?.raw;
  if (!url?.startsWith('{{apiBaseUrl}}/')) throw new Error(`${item.name}: URL must use {{apiBaseUrl}}`);
  if (/https?:\/\/(?!\{\{apiBaseUrl\}\})/i.test(url)) throw new Error(`${item.name}: hardcoded URL is not permitted`);
  const path = `${apiBasePath}${url.slice('{{apiBaseUrl}}'.length)}`;
  const key = `${request.method.toLowerCase()} ${path}`;
  operations.add(key);
  if (!item.request.description?.includes('REN2-21')) throw new Error(`${item.name}: description must reference Linear REN2-21`);
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

process.stdout.write(`Postman/OpenAPI drift check passed (${requests.length} requests, ${operations.size} unique operations, 2 implemented routes).\n`);
