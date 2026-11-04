'use strict';

const assert = require('node:assert/strict');
const net = require('node:net');
const test = require('node:test');
const { ClamAvMediaScanner } = require('../dist/modules/media/clamav-media-scanner.js');
const { SharpMediaImageProcessor } = require('../dist/modules/media/sharp-media-image-processor.js');
const { SpacesMediaStorage, mediaObjectKey, validateSpacesEndpoint } = require('../dist/modules/media/spaces-media-storage.js');

function configuration(values) { return { get: (key) => values[key] }; }

async function fakeClamd(response) {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const commandEnd = buffer.indexOf(0);
      if (commandEnd < 0 || buffer.subarray(0, commandEnd).toString() !== 'zINSTREAM') return;
      let offset = commandEnd + 1;
      while (offset + 4 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        offset += 4;
        if (length === 0) { socket.end(`${response}\0`); return; }
        if (offset + length > buffer.length) return;
        offset += length;
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, port };
}

test('REN2-66 sends image bytes with ClamAV INSTREAM and distinguishes infected content', async (t) => {
  const clean = await fakeClamd('stream: OK');
  const infected = await fakeClamd('stream: Eicar-Test-Signature FOUND');
  t.after(() => { clean.server.close(); infected.server.close(); });
  const bytes = Buffer.from('bounded image bytes');
  assert.equal(await new ClamAvMediaScanner(configuration({ MEDIA_CLAMD_HOST: '127.0.0.1', MEDIA_CLAMD_PORT: clean.port })).scan(bytes), 'CLEAN');
  assert.equal(await new ClamAvMediaScanner(configuration({ MEDIA_CLAMD_HOST: '127.0.0.1', MEDIA_CLAMD_PORT: infected.port })).scan(bytes), 'INFECTED');
});

test('REN2-66 refuses to scan when ClamAV is not configured', async () => {
  const scanner = new ClamAvMediaScanner(configuration({}));
  assert.equal(scanner.isConfigured(), false);
  await assert.rejects(scanner.scan(Buffer.from('x')), { name: 'MediaScannerUnavailableError' });
});

test('REN2-66 makes private, brand-scoped Spaces upload intents with short expiry', async () => {
  const storage = new SpacesMediaStorage(configuration({
    MEDIA_SPACES_ENDPOINT: 'https://nyc3.digitaloceanspaces.com', MEDIA_SPACES_REGION: 'nyc3',
    MEDIA_SPACES_BUCKET: 'renivet-private-media', MEDIA_SPACES_ACCESS_KEY_ID: 'test-key',
    MEDIA_SPACES_SECRET_ACCESS_KEY: 'test-secret',
  }));
  assert.equal(storage.isConfigured(), true);
  const intent = await storage.createUploadIntent({ key: mediaObjectKey('brand-a', 'asset-1', 'incoming', 'n1'),
    mimeType: 'image/png', byteLength: 100, brandId: 'brand-a', assetId: 'asset-1' });
  const signed = new URL(intent.uploadUrl);
  assert.equal(signed.protocol, 'https:');
  assert.equal(signed.searchParams.get('X-Amz-Expires'), '300');
  assert.equal(signed.searchParams.has('X-Amz-Signature'), true);
  assert.deepEqual(intent.headers, {
    'content-type': 'image/png', 'x-amz-acl': 'private', 'x-amz-meta-renivet-brand-id': 'brand-a', 'x-amz-meta-renivet-media-asset-id': 'asset-1',
  });
  assert.equal(intent.uploadUrl.includes('test-secret'), false);
});

test('REN2-66 accepts only HTTPS DigitalOcean Spaces endpoints and derives non-user-controlled object keys', () => {
  assert.equal(validateSpacesEndpoint('https://nyc3.digitaloceanspaces.com'), 'https://nyc3.digitaloceanspaces.com');
  assert.equal(validateSpacesEndpoint('http://127.0.0.1:9000'), null);
  assert.equal(validateSpacesEndpoint('https://bucket.digitaloceanspaces.com.attacker.invalid'), null);
  assert.equal(mediaObjectKey('brand-a', 'asset-1', 'preview'), 'brands/brand-a/media/asset-1/derivatives/preview.webp');
});

test('REN2-66 creates stripped WebP preview and thumbnail derivatives', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg==', 'base64');
  const derivatives = await new SharpMediaImageProcessor().createDerivatives(png, 'image/png', 'brand-a', 'asset-1');
  assert.deepEqual(derivatives.map(({ kind }) => kind), ['PREVIEW', 'THUMBNAIL']);
  assert.ok(derivatives.every(({ mimeType, width, height, bytes, sha256, key }) =>
    mimeType === 'image/webp' && width === 1 && height === 1 && bytes.length > 0 && /^[a-f0-9]{64}$/.test(sha256) && key.includes('brand-a')));
  await assert.rejects(new SharpMediaImageProcessor().createDerivatives(Buffer.from('<svg/>'), 'image/svg+xml', 'brand-a', 'asset-2'),
    { name: 'InvalidMediaImageError' });
});
