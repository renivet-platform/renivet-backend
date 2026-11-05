'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const yaml = require('js-yaml');
const { checkTraceability, compareOperationContracts, extractOperations } = require('../scripts/w2-contract-traceability.cjs');

const candidateSpec = yaml.load(readFileSync('openapi/W2_v1_5_CANDIDATE.yaml', 'utf8'));
const traceability = JSON.parse(readFileSync('openapi/w2-operation-traceability.json', 'utf8'));
const activeSpec = JSON.parse(readFileSync('openapi/renivet.openapi.json', 'utf8'));
const generatedSdk = readFileSync('src/generated/api-schema.d.ts', 'utf8');

function validate(candidate = candidateSpec, manifest = traceability, active = activeSpec, options = {}) {
  return checkTraceability({ ...options, candidateSpec: candidate, traceability: manifest, activeSpec: active });
}

test('REN2-52 loads exactly 44 unique v1.5 candidate operations and verifies the implemented subset', () => {
  const operations = extractOperations(candidateSpec);
  assert.equal(operations.length, 44);
  assert.equal(new Set(operations.map(({ operation }) => operation.operationId)).size, 44);
  assert.ok(operations.every(({ operation }) => operation['x-renivet-implementation-wave'] === 'W2'));
  assert.deepEqual(validate(), []);
  for (const { path, method, operation } of operations) {
    const manifestEntry = traceability.operations.find(({ operationId }) => operationId === operation.operationId);
    const live = activeSpec.paths[`/api/v1${path}`]?.[method];
    if (manifestEntry.implementation.status === 'design_only') {
      assert.equal(live, undefined, `${operation.operationId} remains design-only`);
      assert.equal(generatedSdk.includes(operation.operationId), false, `${operation.operationId} is absent from the SDK`);
    } else {
      assert.equal(live?.operationId, operation.operationId, `${operation.operationId} is live`);
      assert.equal(generatedSdk.includes(operation.operationId), true, `${operation.operationId} is included in the SDK`);
    }
  }
});

test('REN2-52 requires owner, source, test and PR traceability for every operation', () => {
  const broken = structuredClone(traceability);
  broken.operations[0].ownerIssue = null;
  broken.backlogIssues[0].url = 'https://linear.app/renivet/issue/REN2-999';
  broken.operations[1].sourceIds = [];
  broken.operations[2].implementation.test.path = null;
  broken.operations[3].implementation.pullRequest.url = 'not-a-pr';
  const errors = validate(candidateSpec, broken);
  assert.ok(errors.some((error) => /owner issue/i.test(error)));
  assert.ok(errors.some((error) => /invalid Linear backlog snapshot entry/i.test(error)));
  assert.ok(errors.some((error) => /source id/i.test(error)));
  const invalidSource = structuredClone(traceability);
  invalidSource.operations[0].sourceIds = ['QA-99'];
  assert.ok(validate(candidateSpec, invalidSource).some((error) => /valid source ID/i.test(error)));
  const invalidGate = structuredClone(traceability);
  invalidGate.qualityGates = ['G01'];
  assert.ok(validate(candidateSpec, invalidGate).some((error) => /quality gate G08/i.test(error)));
  assert.ok(errors.some((error) => /test path/i.test(error)));
  assert.ok(errors.some((error) => /pull request/i.test(error)));
});

test('REN2-52 detects an undocumented live W2 route', () => {
  const active = structuredClone(activeSpec);
  active.paths['/api/v1/brands/{brandId}/secret-export'] = {
    get: { responses: { 200: { description: 'Export' } } },
  };
  const errors = validate(candidateSpec, traceability, active);
  assert.ok(errors.some((error) => /undocumented W2 route.*missing operationId/i.test(error)));
  active.paths['/api/v1/admin/brands/applications'] = { get: { 'x-renivet-implementation-wave': 'W1', responses: { 200: { description: 'W1 route' } } } };
  assert.ok(!validate(candidateSpec, traceability, active).some((error) => error.includes('/admin/brands/applications')));
});

test('REN2-52 detects success-status, error-schema, header and DTO drift', () => {
  const expected = {
    operationId: 'createBrandProduct',
    'x-renivet-permission': 'catalog.write',
    'x-renivet-guard': 'brand',
    'x-renivet-mfa-required': false,
    'x-renivet-csrf-policy': 'W1 session-bound X-CSRF-Token',
    parameters: [
      { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } },
    ],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object', required: ['title'] } } },
    },
    responses: {
      201: {
        description: 'Created',
        headers: { ETag: { schema: { type: 'string' } } },
        content: {
          'application/json': {
            schema: { type: 'object', properties: { id: { type: 'string' } } },
          },
        },
      },
      409: {
        description: 'Conflict',
        content: {
          'application/json': {
            schema: { type: 'object', properties: { code: { const: 'CONFLICT' } } },
          },
        },
      },
    },
  };
  const actual = structuredClone(expected);
  actual.responses[409].content['application/json'].schema.properties.code.const = 'OTHER';
  actual.responses[201].headers.ETag.schema.type = 'integer';
  actual.requestBody.content['application/json'].schema.required = ['name'];
  actual.parameters[0].name = 'X-Idempotency-Key';
  actual['x-renivet-permission'] = 'taxonomy.manage';
  actual['x-renivet-csrf-policy'] = undefined;
  const errors = compareOperationContracts(expected, actual);
  assert.ok(errors.some((error) => /409.*schema/i.test(error)));
  assert.ok(errors.some((error) => /201.*schema/i.test(error)));
  assert.ok(errors.some((error) => /request DTO/i.test(error)));
  assert.ok(errors.some((error) => /parameter contract/i.test(error)));
  const ifMatchExpected = structuredClone(expected);
  ifMatchExpected.parameters.push({ name: 'If-Match', in: 'header', required: true, schema: { type: 'string' } });
  assert.ok(compareOperationContracts(ifMatchExpected, expected).some((error) => /parameter contract differs/i.test(error)));
  assert.ok(errors.some((error) => /permission authorization contract/i.test(error)));
  assert.ok(errors.some((error) => /session-bound CSRF contract/i.test(error)));

  const wrongStatus = structuredClone(expected);
  wrongStatus.responses[202] = wrongStatus.responses[201];
  delete wrongStatus.responses[201];
  assert.ok(compareOperationContracts(expected, wrongStatus).some((error) => /response status codes differ/i.test(error)));
});

test('REN2-59 permits documented read revalidation extensions while preserving response schema checks', () => {
  const candidate = structuredClone(candidateSpec);
  const active = structuredClone(activeSpec);
  const id = 'listCategories';
  const candidateOperation = candidate.paths['/brands/{brandId}/categories'].get;
  const activeOperation = active.paths['/api/v1/brands/{brandId}/categories'].get;
  activeOperation.responses['304'] = { description: 'Not modified' };
  activeOperation.responses['400'] = { description: 'Invalid cursor' };
  activeOperation.responses['200'].headers = {
    ETag: { schema: { type: 'string' } },
    'Cache-Control': { schema: { type: 'string' } },
  };
  activeOperation.parameters = [
    ...(activeOperation.parameters ?? []),
    { name: 'If-None-Match', in: 'header', required: false, schema: { type: 'string' } },
  ];
  activeOperation.operationId = id;
  assert.deepEqual(compareOperationContracts(
    candidateOperation,
    activeOperation,
    candidate,
    active,
    candidate.paths['/brands/{brandId}/categories'],
    active.paths['/api/v1/brands/{brandId}/categories'],
  ), []);

  activeOperation.responses['200'].headers.ETag.schema.type = 'integer';
  assert.ok(compareOperationContracts(
    candidateOperation,
    activeOperation,
    candidate,
    active,
    candidate.paths['/brands/{brandId}/categories'],
    active.paths['/api/v1/brands/{brandId}/categories'],
  ).some((error) => /200.*cache header/i.test(error)));
});

test('REN2-70 permits only the explicit product list filters, count and ETag extensions', () => {
  const candidate = { operationId: 'listBrandProducts', 'x-renivet-permission': 'catalog.read', responses: { 200: { content: { 'application/json': { schema: { type: 'object', required: ['items'], properties: { items: { type: 'array' } } } } } } }, parameters: [] };
  const active = structuredClone(candidate);
  active.responses['200'].headers = { ETag: { schema: { type: 'string' } }, 'Cache-Control': { schema: { type: 'string' } } };
  active.responses['200'].content['application/json'].schema.properties.totalCount = { type: 'integer', minimum: 0 };
  active.responses['200'].content['application/json'].schema.required = ['items', 'totalCount'];
  active.responses['304'] = { description: 'Not modified' };
  active.parameters = [
    { name: 'If-None-Match', in: 'header', required: false, schema: { type: 'string' } },
    { name: 'categoryId', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
    { name: 'reviewState', in: 'query', required: false, schema: { type: 'string', enum: ['NOT_SUBMITTED','DRAFT','SUBMITTED','APPROVED','REJECTED','SUPERSEDED'] } },
    { name: 'visibility', in: 'query', required: false, schema: { type: 'string', enum: ['PUBLIC','PRIVATE','RESTRICTED'] } },
  ];
  assert.deepEqual(compareOperationContracts(candidate, active), []);
  const badFilter = structuredClone(active); badFilter.parameters.push({ name: 'unbounded', in: 'query', required: false, schema: { type: 'string' } });
  assert.ok(compareOperationContracts(candidate, badFilter).some((error) => /parameter contract differs/i.test(error)));
  const no304 = structuredClone(active); delete no304.responses['304'];
  assert.ok(compareOperationContracts(candidate, no304).some((error) => /must support 304/i.test(error)));
  const badEtag = structuredClone(active); badEtag.parameters[0].schema.type = 'integer';
  assert.ok(compareOperationContracts(candidate, badEtag).some((error) => /If-None-Match extension/i.test(error)));
});

test('REN2-52 rejects mutations without the W1 session cookie CSRF and idempotency policy', () => {
  const candidate = structuredClone(candidateSpec);
  const productCreate = candidate.paths['/brands/{brandId}/products'].post;
  productCreate.parameters = [];
  delete productCreate['x-renivet-csrf-policy'];
  const errors = validate(candidate);
  assert.ok(errors.some((error) => /createBrandProduct.*Idempotency-Key/i.test(error)));
  assert.ok(errors.some((error) => /createBrandProduct.*CSRF policy/i.test(error)));
});

test('REN2-52 permits a live slice only with a matching operation, verified test and PR trace', () => {
  const candidatePath = '/brands/{brandId}/products';
  const activePath = '/api/v1' + candidatePath;
  const candidate = structuredClone(candidateSpec);
  const manifest = structuredClone(traceability);
  const active = structuredClone(activeSpec);
  for (const entry of manifest.operations.filter(({ ownerIssue }) => ['REN2-58', 'REN2-59', 'REN2-61', 'REN2-62', 'REN2-64', 'REN2-65', 'REN2-67', 'REN2-68', 'REN2-70'].includes(ownerIssue))) {
    entry.implementation = {
      status: 'design_only',
      test: { status: 'pending', path: `tests/w2/${entry.operationId}.test.cjs` },
      pullRequest: { status: 'pending', url: null },
    };
    const path = `/api/v1${entry.path}`;
    if (active.paths[path]) {
      for (const [method, operation] of Object.entries(active.paths[path])) {
        if (operation.operationId === entry.operationId) delete active.paths[path][method];
      }
      if (Object.keys(active.paths[path]).length === 0) delete active.paths[path];
    }
  }
  const entry = manifest.operations.find(({ operationId }) => operationId === 'createBrandProduct');
  entry.implementation = {
    status: 'implemented',
    test: { status: 'verified', path: 'tests/w2-contract-traceability.test.cjs' },
    pullRequest: { status: 'open', url: 'https://github.com/renivet-platform/renivet-backend/pull/999' },
  };
  active.paths[activePath] = structuredClone(candidate.paths[candidatePath]);
  delete active.paths[activePath].get;
  active.components = structuredClone(candidate.components);
  active.security = structuredClone(candidate.security);
  assert.deepEqual(validate(candidate, manifest, active), []);

  active.components.parameters.idempotencyKey.required = false;
  assert.ok(validate(candidate, manifest, active).some((error) => /createBrandProduct.*parameter contract differs/i.test(error)));
  active.components.parameters.idempotencyKey.required = true;
  entry.implementation.pullRequest = { status: 'pending', url: null };
  assert.deepEqual(validate(candidate, manifest, active, { requireLinkedPullRequest: false }), []);
  assert.ok(validate(candidate, manifest, active, { requireLinkedPullRequest: true }).some((error) => /CI requires an open or merged pull request URL/i.test(error)));
  entry.implementation.pullRequest = { status: 'open', url: 'https://github.com/renivet-platform/renivet-backend/pull/999' };
  entry.implementation.test.path = 'tests/missing-w2-test.test.cjs';
  assert.ok(validate(candidate, manifest, active).some((error) => /existing verified test path/i.test(error)));
  assert.ok(existsSync('tests/w2-contract-traceability.test.cjs'));
});
