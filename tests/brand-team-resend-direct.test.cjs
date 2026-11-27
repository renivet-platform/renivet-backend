const test = require('node:test');
const assert = require('node:assert/strict');
const { BrandTeamController } = require('../dist/modules/access/brand-team.controller.js');
test('resend_direct team invitations use HTTPS instead of falling through to SMTP', async (t) => {
  const old = global.fetch;
  t.after(() => { global.fetch = old; });
  const settings = { EMAIL_OTP_PROVIDER: 'resend_direct', RESEND_API_KEY: 'test-key', RESEND_FROM: 'Renivet <test@example.test>', AUTH_ALLOWED_ORIGINS: ['https://app.example.test'] };
  const controller = new BrandTeamController({}, {}, {get: name => settings[name]});
  let called = false;
  global.fetch = async (url, init) => {
    called = true;
    assert.equal(url, 'https://api.resend.com/emails');
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    assert.deepEqual(body.to, ['member@example.test']);
    assert.match(body.text, /https:\/\/app\.example\.test\/brands\/invitations\/accept/);
    return new Response(JSON.stringify({id:'test-message'}), {status:200});
  };
  await controller.sendInvitation('member@example.test', 'brand-1', 'synthetic-token');
  assert.equal(called, true);
});
