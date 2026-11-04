'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { HttpException } = require('@nestjs/common');
const { MediaExceptionFilter } = require('../dist/modules/media/media-exception.filter.js');

function host() {
  const reply = { statusCode: null, payload: null, status(code) { this.statusCode = code; return this; }, send(payload) { this.payload = payload; } };
  return {
    reply,
    switchToHttp() {
      return { getRequest: () => ({ id: 'request-66' }), getResponse: () => reply };
    },
  };
}

test('REN2-66 preserves safe client errors and redacts server exception details', () => {
  const filter = new MediaExceptionFilter();
  const client = host();
  filter.catch(new HttpException({ code: 'MEDIA_UPLOAD_INVALID', message: 'The image is invalid.' }, 422), client);
  assert.equal(client.reply.statusCode, 422);
  assert.deepEqual(client.reply.payload, { code: 'MEDIA_UPLOAD_INVALID', message: 'The image is invalid.', requestId: 'request-66' });

  const server = host();
  filter.catch(new HttpException({ code: 'DB_PASSWORD_LEAK', message: 'secret database host', details: { query: 'sensitive' } }, 500), server);
  assert.equal(server.reply.statusCode, 500);
  assert.deepEqual(server.reply.payload, {
    code: 'MEDIA_INTERNAL_ERROR', message: 'The media request could not be completed.', requestId: 'request-66',
  });
});
