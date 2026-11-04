'use strict';

const brandId = '91a1beaf-5b2f-4189-a33b-cc31c50f12d2';
const userId = '1b8d95ea-26e6-4f19-ae2b-7543c02a3a70';
const productId = 'c6e4fb84-4e31-4b38-95c9-3259a4531a10';
const linkId = 'a8364f3c-47b6-442e-a3d9-f031c782d88c';
const mediaAssetId = '08f1bba5-80a5-4979-8984-84279507eb4f';
const csrfToken = 'session-bound-csrf-token';

function setup() {
  const calls = [];
  const service = {
    async attach(...args) { calls.push(['attach', ...args]); return { id: linkId, mediaAssetId, productId, displayOrder: 0, rowVersion: 1 }; },
    async update(...args) { calls.push(['update', ...args]); return { id: linkId, mediaAssetId, productId, displayOrder: 0, rowVersion: 2 }; },
    async detach(...args) { calls.push(['detach', ...args]); return { id: linkId, status: 'DETACHED', rowVersion: 2 }; },
  };
  const sessions = { async authenticate() { return { userId, sessionId: 'session-1' }; }, expectedCsrf() { return csrfToken; } };
  const config = { get(name) { return name === 'AUTH_ALLOWED_ORIGINS' ? ['https://brand.example'] : undefined; } };
  const request = { id: 'request-67', headers: { cookie: `__Host-renivet_session=${'A'.repeat(43)}`,
    origin: 'https://brand.example', 'sec-fetch-site': 'same-origin', 'x-csrf-token': csrfToken },
    brandAccess: { brandId, userId, permission: 'catalog.write' } };
  return { calls, service, sessions, config, request, controllerArgs: [service, sessions, config],
    brandId, userId, productId, linkId, mediaAssetId };
}
module.exports = { setup };
