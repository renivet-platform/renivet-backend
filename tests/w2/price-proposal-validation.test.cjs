'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PriceService, normalizePriceProposal, parsePriceIfMatch } = require('../../dist/modules/catalog/price.service.js');

test('REN2-64 normalizes an INR paise proposal and timezone instants without changing money', () => {
  assert.deepEqual(normalizePriceProposal({
    currency: 'INR', sellingPriceMinor: 125050, mrpMinor: 150000,
    validFrom: '2026-11-04T12:00:00+05:30', validTo: '2026-11-05T06:30:00Z', ruleVersion: 1,
  }), {
    currency: 'INR', sellingPriceMinor: 125050, mrpMinor: 150000,
    validFrom: '2026-11-04T06:30:00.000Z', validTo: '2026-11-05T06:30:00.000Z', ruleVersion: 1,
  });
});

test('REN2-64 rejects non-INR, fractional or unsafe paise, invalid MRP, and invalid effective windows', () => {
  const base = { currency: 'INR', sellingPriceMinor: 100, mrpMinor: 200,
    validFrom: '2026-11-04T12:00:00Z', validTo: null, ruleVersion: 1 };
  for (const patch of [
    { currency: 'USD' }, { sellingPriceMinor: 100.5 }, { sellingPriceMinor: Number.MAX_SAFE_INTEGER + 1 },
    { mrpMinor: 0 }, { sellingPriceMinor: 201 }, { validFrom: '2026-11-04T12:00:00' },
    { validFrom: '2026-02-30T12:00:00Z' }, { validFrom: '2026-11-04T24:00:00Z' },
    { validTo: '2026-11-04T12:00:00Z' }, { ruleVersion: 0 }, { unexpected: true },
  ]) assert.throws(() => normalizePriceProposal({ ...base, ...patch }), (error) => error?.code === 'PRICE_PROPOSAL_INVALID');
});

test('REN2-64 requires a quoted positive If-Match row version', () => {
  assert.equal(parsePriceIfMatch('"12"'), 12);
  for (const value of [undefined, '12', '"0"', 'W/"1"', ['"1"'], '"9007199254740992"']) {
    assert.throws(() => parsePriceIfMatch(value), (error) => error?.code === 'PRICE_IF_MATCH_INVALID');
  }
});

test('REN2-64 proposal command passes normalized proposal and expected variant version to its repository', async () => {
  let received;
  const service = new PriceService({
    propose: async (...args) => { received = args; return { id: 'price-1', status: 'PENDING', requestId: 'request-1', rowVersion: 1 }; },
    list: async () => ({ items: [], nextCursor: null }),
  });
  const context = { userId: '19f234c6-280a-4b51-9e6f-836f44d2f49e', brandId: '19f234c6-280a-4b51-9e6f-836f44d2f49f', permission: 'pricing.write', requestId: 'request-1', idempotencyKey: 'price-1' };
  const receipt = await service.propose('19f234c6-280a-4b51-9e6f-836f44d2f49d', {
    currency: 'INR', sellingPriceMinor: 100, mrpMinor: 200, validFrom: '2026-11-04T12:00:00Z', ruleVersion: 1,
  }, '"7"', context);
  assert.equal(receipt.status, 'PENDING');
  assert.equal(received[0], '19f234c6-280a-4b51-9e6f-836f44d2f49d');
  assert.equal(received[1].sellingPriceMinor, 100);
  assert.equal(received[2], 7);
  assert.equal(received[3], context);
});
