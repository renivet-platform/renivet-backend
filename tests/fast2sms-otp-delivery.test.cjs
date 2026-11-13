const test = require('node:test');
const assert = require('node:assert/strict');
let Fast2SmsOtpDelivery;
try {
  ({ Fast2SmsOtpDelivery } = require('../dist/modules/identity/fast2sms-otp-delivery'));
} catch {
  // The first RED run must fail on the missing adapter export, not module loading.
}

const completeConfig = {
  apiKey: 'synthetic-fast2sms-api-key',
  messageId: '1077206490123456789',
  senderId: 'RENIVT',
  entityId: '1234567890123456789',
};
const phoneMessage = {
  channel: 'phone',
  purpose: 'phone_verification',
  destination: '+919876543210',
  code: '123456',
  expiresInSeconds: 301,
};
const successResponse = () => ({ ok: true, status: 200, json: async () => ({ return: true, status_code: 200 }) });

test('Fast2SMS DLT adapter is exported', () => {
  assert.equal(typeof Fast2SmsOtpDelivery, 'function');
});

test('partial configuration leaves delivery unavailable and makes no request', async () => {
  let requests = 0;
  const delivery = new Fast2SmsOtpDelivery({ ...completeConfig, apiKey: '' }, async () => { requests += 1; return successResponse(); });
  assert.equal(delivery.available, false);
  assert.equal(delivery.availableFor('phone', 'phone_verification'), false);
  await assert.rejects(delivery.send(phoneMessage), /delivery failed/i);
  assert.equal(requests, 0);
});

test('complete configuration sends Renivet OTP and expiry through the approved DLT message ID', async () => {
  let request;
  const delivery = new Fast2SmsOtpDelivery(completeConfig, async (url, options) => {
    request = { url, options };
    return successResponse();
  });
  assert.equal(delivery.available, true);
  assert.equal(delivery.availableFor('phone', 'phone_verification'), true);
  assert.equal(delivery.availableFor('email', 'email_verification'), false);
  await delivery.send(phoneMessage);
  assert.equal(request.url, 'https://www.fast2sms.com/dev/bulkV2');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.authorization, completeConfig.apiKey);
  assert.deepEqual(JSON.parse(request.options.body), {
    sender_id: completeConfig.senderId,
    message: completeConfig.messageId,
    variables_values: '123456|6',
    route: 'dlt',
    numbers: '9876543210',
  });
});

test('Fast2SMS explicitly allows login OTPs and keeps verification-purpose isolation', async () => {
  const delivery = new Fast2SmsOtpDelivery(completeConfig, async () => successResponse());
  assert.equal(delivery.availableFor('phone', 'phone_login'), true);
  assert.equal(delivery.availableFor('email', 'phone_login'), false);
});

test('provider rejection maps to generic error without exposing API key, OTP, or destination', async () => {
  const delivery = new Fast2SmsOtpDelivery(completeConfig, async () => ({
    ok: true, status: 200, json: async () => ({ return: false, message: 'private provider error' }),
  }));
  await assert.rejects(delivery.send(phoneMessage), (error) => {
    assert.match(error.message, /delivery failed/i);
    assert.doesNotMatch(error.message, /synthetic-fast2sms-api-key|123456|9876543210|private provider error/);
    return true;
  });
});

test('HTTP errors and malformed JSON map to generic errors', async () => {
  const httpFailure = new Fast2SmsOtpDelivery(completeConfig, async () => ({ ok: false, status: 401, json: async () => ({ message: 'secret token rejected' }) }));
  await assert.rejects(httpFailure.send(phoneMessage), /delivery failed/i);
  const malformed = new Fast2SmsOtpDelivery(completeConfig, async () => ({ ok: true, status: 200, json: async () => { throw new Error('raw response'); } }));
  await assert.rejects(malformed.send(phoneMessage), /delivery failed/i);
});

test('network timeout aborts the request and maps to a generic error', async () => {
  let aborted = false;
  const delivery = new Fast2SmsOtpDelivery(completeConfig, async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('transport details')); }, { once: true });
  }), 10);
  await assert.rejects(delivery.send(phoneMessage), /delivery failed/i);
  assert.equal(aborted, true);
});

test('caller cancellation is passed through to the provider request', async () => {
  let requestSignal;
  const delivery = new Fast2SmsOtpDelivery(completeConfig, async (_url, options) => {
    requestSignal = options.signal;
    return successResponse();
  });
  const controller = new AbortController();
  await delivery.send(phoneMessage, controller.signal);
  assert.equal(requestSignal.aborted, false);
  controller.abort();
  assert.equal(requestSignal.aborted, true);
});

test('non-India numbers, wrong channel, and wrong purpose are rejected before network I/O', async () => {
  let requests = 0;
  const delivery = new Fast2SmsOtpDelivery(completeConfig, async () => { requests += 1; return successResponse(); });
  await assert.rejects(delivery.send({ ...phoneMessage, destination: '+14155550100' }), /delivery failed/i);
  await assert.rejects(delivery.send({ ...phoneMessage, channel: 'email' }), /delivery failed/i);
  await assert.rejects(delivery.send({ ...phoneMessage, purpose: 'password_recovery' }), /delivery failed/i);
  assert.equal(requests, 0);
});

test('caller cancellation aborts an in-flight Fast2SMS request', async () => {
  let aborted = false;
  const delivery = new Fast2SmsOtpDelivery(completeConfig, async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('transport details')); }, { once: true });
  }), 1_000);
  const controller = new AbortController();
  const pending = delivery.send(phoneMessage, controller.signal);
  controller.abort();
  await assert.rejects(pending, /delivery failed/i);
  assert.equal(aborted, true);
});
