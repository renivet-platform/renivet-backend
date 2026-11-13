const test = require('node:test');
const assert = require('node:assert/strict');
const { ResendTemplateOtpDelivery } = require('../dist/modules/identity/resend-template-otp-delivery');
const { SmtpOtpDelivery } = require('../dist/modules/identity/smtp-otp-delivery');
const { createEmailOtpDelivery } = require('../dist/modules/identity/email-otp-delivery');

const validConfiguration = {
  apiKey: 're_test_private',
  from: 'Renivet <account@renivet.com>',
  emailVerificationTemplateId: 'email-verification',
  passwordRecoveryTemplateId: 'reset_password',
};

function message(overrides = {}) {
  return {
    channel: 'email',
    destination: 'customer@example.test',
    purpose: 'email_verification',
    code: '004281',
    expiresInSeconds: 301,
    ...overrides,
  };
}

test('Resend template delivery sends the published purpose template and preserves a leading-zero code', async () => {
  let request;
  const delivery = new ResendTemplateOtpDelivery(validConfiguration, async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 });
  });

  await delivery.send(message());

  assert.equal(request.url, 'https://api.resend.com/emails');
  assert.equal(request.options.headers.authorization, 'Bearer re_test_private');
  assert.deepEqual(JSON.parse(request.options.body), {
    from: 'Renivet <account@renivet.com>',
    to: ['customer@example.test'],
    subject: 'Verify your Renivet email',
    template: { id: 'email-verification', variables: { OTP_CODE: '004281', EXPIRY_MINUTES: '6' } },
  });
});

test('password recovery uses its own published template alias', async () => {
  let payload;
  const delivery = new ResendTemplateOtpDelivery(validConfiguration, async (_url, options) => {
    payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 });
  });

  await delivery.send(message({ purpose: 'password_recovery' }));

  assert.equal(payload.template.id, 'reset_password');
  assert.equal(payload.subject, 'Reset your Renivet password');
});

test('Resend delivery is limited to configured email verification and password recovery', () => {
  const delivery = new ResendTemplateOtpDelivery(validConfiguration, async () => {
    throw new Error('must not send');
  });

  assert.equal(delivery.available, true);
  assert.equal(delivery.availableFor('email', 'email_verification'), true);
  assert.equal(delivery.availableFor('email', 'password_recovery'), true);
  assert.equal(delivery.availableFor('phone', 'phone_login'), false);
  assert.equal(delivery.availableFor('email', 'phone_verification'), false);
});

test('email provider selector defaults to SMTP and explicitly selects Resend without changing phone delivery', () => {
  const smtp = createEmailOtpDelivery({
    smtpHost: 'smtp.example.test',
    smtpFrom: 'account@example.test',
    smtpUsername: 'user',
    smtpPassword: 'secret',
  });
  const resend = createEmailOtpDelivery({
    provider: 'resend',
    smtpHost: 'smtp.resend.com',
    smtpFrom: 'Renivet <account@example.test>',
    smtpPassword: 're_test_secret',
  });
  const otherSmtp = createEmailOtpDelivery({
    provider: 'resend',
    smtpHost: 'smtp.other.test',
    smtpFrom: 'account@example.test',
    smtpPassword: 'not-an-api-key',
  });

  assert.equal(smtp instanceof SmtpOtpDelivery, true);
  assert.equal(resend instanceof ResendTemplateOtpDelivery, true);
  assert.equal(resend.availableFor('email', 'email_verification'), true);
  assert.equal(otherSmtp.available, false);
});

test('partial Resend configuration stays unavailable and performs no request', async () => {
  let called = false;
  const delivery = new ResendTemplateOtpDelivery({ ...validConfiguration, apiKey: undefined }, async () => {
    called = true;
    return new Response(JSON.stringify({ id: 'unexpected' }), { status: 200 });
  });

  assert.equal(delivery.available, false);
  await assert.rejects(delivery.send(message()), { message: 'Email delivery failed.' });
  assert.equal(called, false);
});

test('provider failures and malformed success responses are mapped to a generic error', async (t) => {
  for (const [name, fetcher] of [
    ['HTTP error', async () => new Response('private provider response', { status: 401 })],
    ['malformed JSON', async () => new Response('not-json', { status: 200 })],
    ['missing message ID', async () => new Response(JSON.stringify({}), { status: 200 })],
    ['network failure', async () => { throw new Error('private network detail'); }],
  ]) {
    await t.test(name, async () => {
      const delivery = new ResendTemplateOtpDelivery(validConfiguration, fetcher);
      await assert.rejects(delivery.send(message()), { message: 'Email delivery failed.' });
    });
  }
});

test('Resend failures emit safe diagnostics without exposing the recipient, code, or provider message', async () => {
  const failures = [];
  const delivery = new ResendTemplateOtpDelivery({
    ...validConfiguration,
    onDeliveryFailure: (failure) => failures.push(failure),
  }, async () => new Response(JSON.stringify({
    name: 'validation_error',
    message: 'Rejected customer@example.test code 004281 secret provider detail',
  }), { status: 422 }));

  await assert.rejects(delivery.send(message()), { message: 'Email delivery failed.' });

  assert.deepEqual(failures, [{ provider: 'resend', kind: 'http_error', status: 422, code: 'validation_error' }]);
});

test('invalid messages and an already-aborted request do not contact Resend', async () => {
  let calls = 0;
  const delivery = new ResendTemplateOtpDelivery(validConfiguration, async () => {
    calls += 1;
    return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 });
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(delivery.send(message({ code: '12' })), { message: 'Email delivery failed.' });
  await assert.rejects(delivery.send(message(), controller.signal), { message: 'Email delivery failed.' });
  assert.equal(calls, 0);
});

test('timeout aborts a pending Resend request and does not reveal provider details', async () => {
  let sawAbort = false;
  const delivery = new ResendTemplateOtpDelivery(validConfiguration, (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      sawAbort = true;
      reject(new Error('secret detail'));
    }, { once: true });
  }), 100);

  await assert.rejects(delivery.send(message()), { message: 'Email delivery failed.' });
  assert.equal(sawAbort, true);
});
