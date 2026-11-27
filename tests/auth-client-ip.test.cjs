const assert = require('node:assert/strict');
const test = require('node:test');
const { createHmac } = require('node:crypto');
const { resolveAuthClientIp } = require('../dist/modules/identity/auth-client-ip.js');
const key = 'test-only-proxy-key-that-is-at-least-32-characters';
const now = 1795780000000;
const path = '/auth/sessions';
function proof(ip, at = now, operation = path) {
  const ts = String(Math.floor(at / 1000));
  return ['v1', ts, ip, createHmac('sha256', key).update(['v1', operation, ts, ip].join('\n')).digest('hex')].join(';');
}
test('signed BFF evidence distinguishes two browser clients and binds the auth operation', () => {
  for (const ip of ['203.0.113.1', '203.0.113.2', '2001:db8::1']) {
    const headers = { 'x-renivet-client-ip-proof': proof(ip), 'do-connecting-ip': '192.0.2.5' };
    assert.equal(resolveAuthClientIp(headers, '192.0.2.1', path, key, true, now), ip);
    assert.equal(resolveAuthClientIp(headers, '192.0.2.1', '/auth/register', key, false, now), '192.0.2.1');
  }
});
test('rejects altered, expired, multi-value and unsigned proxy evidence; ingress trust is opt-in', () => {
  for (const value of [proof('203.0.113.1').replace('203.0.113.1','203.0.113.9'), proof('203.0.113.1', now-31_000), [proof('203.0.113.1')]]) {
    assert.equal(resolveAuthClientIp({'x-renivet-client-ip-proof':value}, '192.0.2.1', path, key, false, now), '192.0.2.1');
  }
  assert.equal(resolveAuthClientIp({'x-forwarded-for':'203.0.113.1','do-connecting-ip':'203.0.113.2'}, '192.0.2.1', path, key, false, now), '192.0.2.1');
  assert.equal(resolveAuthClientIp({'do-connecting-ip':'203.0.113.2'}, '192.0.2.1', path, key, true, now), '203.0.113.2');
});
