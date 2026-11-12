const assert = require('node:assert/strict');
const test = require('node:test');
const { SmtpOtpDelivery } = require('../dist/modules/identity/smtp-otp-delivery');
const { CompositeOtpDelivery } = require('../dist/modules/identity/otp-delivery');

const config = {
  host: 'smtp.example.test',
  port: 587,
  from: 'no-reply@example.test',
  username: 'renivet-smtp-user',
  password: 'private-smtp-password',
};

const emailMessage = {
  channel: 'email',
  destination: 'buyer@example.test',
  purpose: 'email_verification',
  code: '083104',
  expiresInSeconds: 300,
};

test('REN2-22 incomplete SMTP configuration leaves email delivery disabled without creating a transport', async () => {
  let created = false;
  const delivery = new SmtpOtpDelivery({ ...config, password: undefined }, () => { created = true; });

  assert.equal(delivery.available, false);
  assert.equal(delivery.availableFor('email', 'email_verification'), false);
  await assert.rejects(delivery.send(emailMessage), /Email delivery failed/);
  assert.equal(created, false);
});

test('REN2-22 SMTP delivery supports only email verification and password recovery', async () => {
  const delivery = new SmtpOtpDelivery(config, () => ({ sendMail: async () => ({ messageId: 'synthetic' }) }));

  assert.equal(delivery.available, true);
  assert.equal(delivery.availableFor('email', 'email_verification'), true);
  assert.equal(delivery.availableFor('email', 'password_recovery'), true);
  assert.equal(delivery.availableFor('phone', 'phone_verification'), false);
  assert.equal(delivery.availableFor('email', 'phone_verification'), false);
});

test('REN2-22 renders a bounded verification email without a sign-in link or PII in subject', async () => {
  let transportOptions;
  let sent;
  const delivery = new SmtpOtpDelivery(config, (options) => {
    transportOptions = options;
    return { sendMail: async (message) => { sent = message; return { messageId: 'synthetic' }; } };
  });

  await delivery.send(emailMessage);

  assert.equal(transportOptions.host, config.host);
  assert.equal(transportOptions.port, config.port);
  assert.equal(transportOptions.requireTLS, true);
  assert.equal(sent.to, emailMessage.destination);
  assert.equal(sent.from, config.from);
  assert.match(sent.subject, /verification/i);
  assert.match(sent.text, /083104/);
  assert.match(sent.text, /5 minutes/);
  assert.match(sent.html, /083104/);
  assert.doesNotMatch(sent.subject, /buyer@example\.test|083104/);
  assert.doesNotMatch(sent.text, /sign in automatically|password.*link/i);
});

test('REN2-22 password-recovery email has a neutral reset subject and omits OTP from subject', async () => {
  let sent;
  const delivery = new SmtpOtpDelivery(config, () => ({ sendMail: async (message) => { sent = message; return {}; } }));

  await delivery.send({ ...emailMessage, purpose: 'password_recovery' });

  assert.match(sent.subject, /reset/i);
  assert.match(sent.text, /083104/);
  assert.doesNotMatch(sent.subject, /083104|buyer@example\.test/);
});

test('REN2-22 rejects invalid destinations and proof values before opening a transport', async () => {
  let created = false;
  const delivery = new SmtpOtpDelivery(config, () => { created = true; return { sendMail: async () => ({}) }; });

  await assert.rejects(delivery.send({ ...emailMessage, destination: 'not-an-email' }), /Email delivery failed/);
  await assert.rejects(delivery.send({ ...emailMessage, code: '1234567' }), /Email delivery failed/);
  await assert.rejects(delivery.send({ ...emailMessage, expiresInSeconds: 0 }), /Email delivery failed/);
  await assert.rejects(delivery.send({ ...emailMessage, purpose: 'phone_verification' }), /Email delivery failed/);
  assert.equal(created, false);
});

test('REN2-22 provider rejection is redacted and does not expose recipient, OTP, or credentials', async () => {
  const delivery = new SmtpOtpDelivery(config, () => ({
    sendMail: async () => { throw new Error('SMTP rejected buyer@example.test code 083104 with private-smtp-password'); },
  }));

  await assert.rejects(delivery.send(emailMessage), (error) => {
    assert.equal(error.message, 'Email delivery failed.');
    assert.equal(error.cause, undefined);
    return true;
  });
});

test('REN2-22 SMTP timeout closes the transport and returns a bounded generic error', async () => {
  let closed = false;
  const delivery = new SmtpOtpDelivery(config, () => ({
    sendMail: () => new Promise(() => {}),
    close: () => { closed = true; },
  }), 100);

  await assert.rejects(delivery.send(emailMessage), /Email delivery failed/);
  assert.equal(closed, true);
});

test('REN2-22 pre-aborted delivery never creates a transport', async () => {
  let created = false;
  const delivery = new SmtpOtpDelivery(config, () => { created = true; return { sendMail: async () => ({}) }; });
  const abort = new AbortController();
  abort.abort();

  await assert.rejects(delivery.send(emailMessage, abort.signal), /Email delivery failed/);
  assert.equal(created, false);
});

test('REN2-22 composite delivery routes email to SMTP and leaves phone on its own adapter', async () => {
  const sent = [];
  const email = new SmtpOtpDelivery(config, () => ({ sendMail: async (message) => { sent.push(['email', message.to]); return {}; } }));
  const phone = {
    available: true,
    availableFor: (channel, purpose) => channel === 'phone' && purpose === 'phone_verification',
    send: async (message) => { sent.push(['phone', message.destination]); },
  };
  const delivery = new CompositeOtpDelivery([email, phone]);

  await delivery.send(emailMessage);
  await delivery.send({ ...emailMessage, channel: 'phone', destination: '+919876543210', purpose: 'phone_verification' });

  assert.deepEqual(sent, [['email', 'buyer@example.test'], ['phone', '+919876543210']]);
  assert.equal(delivery.availableFor('email', 'password_recovery'), true);
  assert.equal(delivery.availableFor('phone', 'email_verification'), false);
});
