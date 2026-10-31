const assert = require('node:assert/strict');
const test = require('node:test');
const { readSessionToken } = require('../dist/modules/identity/session.service.js');

const token = 'A'.repeat(43);

test('shared parser accepts exactly one well-formed first-party session cookie', () => {
  assert.equal(readSessionToken(`other=value; __Host-renivet_session=${token}; theme=dark`), token);
});

test('shared parser rejects missing, malformed, duplicate and ambiguous session cookies', () => {
  for (const header of [undefined, '', '__Host-renivet_session=short', `__Host-renivet_session=${token}; __Host-renivet_session=${token}`]) {
    assert.equal(readSessionToken(header), undefined);
  }
  assert.equal(readSessionToken([`__Host-renivet_session=${token}`, `__Host-renivet_session=${token}`]), undefined);
});
