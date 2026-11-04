'use strict';

const brandId = '91a1beaf-5b2f-4189-a33b-cc31c50f12d2';
const userId = '1b8d95ea-26e6-4f19-ae2b-7543c02a3a70';
const mediaId = '08f1bba5-80a5-4979-8984-84279507eb4f';
const sessionToken = 'A'.repeat(43);
const csrfToken = 'session-bound-csrf-token';

function setup() {
  const calls = [];
  const service = {
    async begin(body, context) { calls.push(['begin', body, context]); return { mediaAssetId: mediaId, uploadMethod: 'PUT' }; },
    async complete(id, body, context) { calls.push(['complete', id, body, context]); return { id, status: 'CLEAN', requestId: context.requestId, rowVersion: 2 }; },
    async status(id, context) { calls.push(['status', id, context]); return { id, scanState: 'CLEAN', rightsState: 'ATTESTED', derivativeState: 'READY', safePreviewUrl: null }; },
  };
  const sessions = { async authenticate() { return { userId, sessionId: 'session-1' }; }, expectedCsrf() { return csrfToken; } };
  const config = { get(name) { return name === 'AUTH_ALLOWED_ORIGINS' ? ['https://brand.example'] : undefined; } };
  const request = {
    id: 'request-66',
    headers: { cookie: `__Host-renivet_session=${sessionToken}`, origin: 'https://brand.example',
      'sec-fetch-site': 'same-origin', 'x-csrf-token': csrfToken },
    brandAccess: { brandId, userId, permission: 'media.write' },
  };
  return { service, calls, request, controllerArgs: [service, sessions, config], brandId, userId, mediaId, csrfToken };
}

module.exports = { setup };
