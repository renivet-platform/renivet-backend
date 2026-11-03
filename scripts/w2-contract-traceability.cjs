'use strict';

const { createHash } = require('node:crypto');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const yaml = require('js-yaml');

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace']);
const MUTATING_METHODS = new Set(['post', 'put', 'patch', 'delete']);
const W2_TAGS = new Set(['Catalog', 'Pricing', 'Review', 'Media', 'Imports', 'Inventory']);
const IGNORED_CONTRACT_FIELDS = new Set(['description', 'summary', 'title', 'example', 'examples', 'externalDocs']);

function extractOperations(spec) {
  const operations = [];
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (HTTP_METHODS.has(method.toLowerCase())) operations.push({ path, method: method.toLowerCase(), operation });
    }
  }
  return operations;
}

function resolveReference(value, spec, seen = new Set()) {
  if (Array.isArray(value)) return value.map((item) => resolveReference(item, spec, seen));
  if (!value || typeof value !== 'object') return value;
  if (typeof value.$ref === 'string' && value.$ref.startsWith('#/')) {
    if (seen.has(value.$ref)) return value;
    const target = value.$ref.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce((current, part) => current?.[part], spec);
    if (!target) return value;
    const resolved = resolveReference(target, spec, new Set([...seen, value.$ref]));
    const siblings = Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$ref'));
    return { ...(resolved && typeof resolved === 'object' ? resolved : {}), ...resolveReference(siblings, spec, seen) };
  }
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, resolveReference(nested, spec, seen)]));
}

function normalizeContract(value) {
  if (Array.isArray(value)) return value.map(normalizeContract);
  if (!value || typeof value !== 'object') return value;
  const normalized = Object.fromEntries(Object.entries(value)
    .filter(([key]) => !IGNORED_CONTRACT_FIELDS.has(key) && !key.startsWith('x-'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => [key, key === 'required' && Array.isArray(nested)
      ? [...nested].sort()
      : normalizeContract(nested)]));
  if (normalized.required === false) delete normalized.required;
  if (normalized.nullable === true && ['string', 'object', 'number', 'integer', 'boolean'].includes(normalized.type)) {
    normalized.type = [normalized.type, 'null'];
    delete normalized.nullable;
  }
  return normalized;
}

function effectiveParameters(spec, pathItem = {}, operation = {}) {
  const parameters = resolveReference([...(pathItem.parameters ?? []), ...(operation.parameters ?? [])], spec);
  const byLocationAndName = new Map();
  for (const parameter of parameters) {
    if (parameter?.in && parameter.name) byLocationAndName.set(`${parameter.in}:${parameter.name.toLowerCase()}`, parameter);
  }
  return [...byLocationAndName.values()].sort((a, b) => `${a.in}:${a.name.toLowerCase()}`.localeCompare(`${b.in}:${b.name.toLowerCase()}`));
}

function effectiveSecurity(spec, pathItem = {}, operation = {}) {
  const security = operation.security ?? pathItem.security ?? spec.security ?? [];
  return security.map((requirement) => Object.entries(requirement).map(([name, scopes]) => {
    const scheme = spec.components?.securitySchemes?.[name] ?? {};
    return { type: scheme.type, in: scheme.in, name: scheme.name, scopes: [...(scopes ?? [])].sort() };
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function compareOperationContracts(expected, actual, expectedSpec, actualSpec, expectedPathItem = {}, actualPathItem = {}) {
  const errors = [];
  if (!actual) return ['implementation operation is missing'];
  if (expected.operationId !== actual.operationId) {
    errors.push(`operationId differs: expected ${expected.operationId}, received ${actual.operationId ?? '(missing)'}`);
  }
  for (const field of ['x-renivet-permission', 'x-renivet-guard', 'x-renivet-mfa-required', 'x-renivet-admin-target-brand-check']) {
    if (expected[field] !== actual[field]) errors.push(`${field} authorization contract differs`);
  }
  if (expected['x-renivet-csrf-policy'] && (!/x-csrf-token/i.test(String(actual['x-renivet-csrf-policy'] ?? '')) || !/(?:W1 session|session-bound)/i.test(String(actual['x-renivet-csrf-policy'] ?? '')))) {
    errors.push('session-bound CSRF contract differs');
  }
  const expectedResponses = resolveReference(expected.responses ?? {}, expectedSpec ?? {});
  const actualResponses = resolveReference(actual.responses ?? {}, actualSpec ?? {});
  const isTaxonomyRead = ['listCategories', 'getCategoryAttributes', 'getCategorySchemaVersion'].includes(expected.operationId);
  const expectedCodes = Object.keys(expectedResponses).sort();
  const actualCodes = Object.keys(actualResponses).sort();
  const allowedAdditions = isTaxonomyRead ? new Set(['304', ...(expectedCodes.includes('400') ? [] : ['400'])]) : new Set();
  if (expectedCodes.some((code) => !actualCodes.includes(code))
      || actualCodes.some((code) => !expectedCodes.includes(code) && !allowedAdditions.has(code))) {
    errors.push(`response status codes differ: expected ${expectedCodes.join(', ')}, received ${actualCodes.join(', ')}`);
  }
  for (const code of expectedCodes.filter((item) => actualCodes.includes(item))) {
    const expectedResponse = structuredClone(expectedResponses[code]);
    const actualResponse = structuredClone(actualResponses[code]);
    if (isTaxonomyRead && code === '200') {
      for (const name of ['ETag', 'Cache-Control']) {
        const schema = actualResponse.headers?.[name]?.schema;
        if (schema && schema.type !== 'string') errors.push(`response 200 ${name} cache header must be a string`);
      }
      for (const name of ['ETag', 'Cache-Control']) delete expectedResponse.headers?.[name];
      for (const name of ['ETag', 'Cache-Control']) delete actualResponse.headers?.[name];
      if (actualResponse.headers && Object.keys(actualResponse.headers).length === 0) delete actualResponse.headers;
      if (expectedResponse.headers && Object.keys(expectedResponse.headers).length === 0) delete expectedResponse.headers;
    }
    if (JSON.stringify(normalizeContract(expectedResponse)) !== JSON.stringify(normalizeContract(actualResponse))) {
      errors.push(`response ${code} schema/headers differ`);
    }
  }
  const expectedBody = normalizeContract(resolveReference(expected.requestBody ?? null, expectedSpec ?? {}));
  const actualBody = normalizeContract(resolveReference(actual.requestBody ?? null, actualSpec ?? {}));
  if (JSON.stringify(expectedBody) !== JSON.stringify(actualBody)) errors.push('request DTO contract differs');
  let expectedParametersRaw = effectiveParameters(expectedSpec ?? {}, expectedPathItem, expected);
  let actualParametersRaw = effectiveParameters(actualSpec ?? {}, actualPathItem, actual);
  if (isTaxonomyRead) {
    actualParametersRaw = actualParametersRaw.filter((parameter) => parameter.name?.toLowerCase() !== 'if-none-match');
    if (expected.operationId === 'getCategoryAttributes') {
      expectedParametersRaw = [...expectedParametersRaw,
        resolveReference({ $ref: '#/components/parameters/cursor' }, expectedSpec ?? {}),
        resolveReference({ $ref: '#/components/parameters/limit' }, expectedSpec ?? {}),
      ];
    }
    const byName = (a, b) => `${a.in}:${a.name}`.localeCompare(`${b.in}:${b.name}`);
    expectedParametersRaw = [...expectedParametersRaw].sort(byName);
    actualParametersRaw = [...actualParametersRaw].sort(byName);
  }
  const expectedParameters = normalizeContract(expectedParametersRaw);
  const actualParameters = normalizeContract(actualParametersRaw);
  if (JSON.stringify(expectedParameters) !== JSON.stringify(actualParameters)) errors.push('parameter contract differs');
  const expectedSecurity = effectiveSecurity(expectedSpec ?? {}, expectedPathItem, expected);
  const actualSecurity = effectiveSecurity(actualSpec ?? {}, actualPathItem, actual);
  if (JSON.stringify(expectedSecurity) !== JSON.stringify(actualSecurity)) errors.push('authentication contract differs');
  return errors;
}

function isW2Route(path, operation, candidateIds) {
  if (candidateIds.has(operation.operationId)) return true;
  if (operation['x-renivet-implementation-wave'] === 'W1') return false;
  if ((operation.tags ?? []).some((tag) => W2_TAGS.has(tag))) return true;
  return /^\/api\/v1\/(?:brands|admin)\//.test(path);
}

function sha1GitBlob(content) {
  const normalizedContent = Buffer.from(content.toString('utf8').replace(/\r\n/g, '\n'));
  const header = Buffer.concat([Buffer.from(`blob ${normalizedContent.length}`), Buffer.from([0])]);
  return createHash('sha1').update(header).update(normalizedContent).digest('hex');
}

function checkTraceability({ candidateSpec, traceability, activeSpec, fileExists = existsSync, requireLinkedPullRequest = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true' }) {
  const errors = [];
  const candidateOps = extractOperations(candidateSpec);
  const manifestOps = traceability.operations ?? [];
  const candidateIds = candidateOps.map(({ operation }) => operation.operationId).filter(Boolean);
  const manifestIds = manifestOps.map(({ operationId }) => operationId).filter(Boolean);
  const candidateIdSet = new Set(candidateIds);
  const manifestById = new Map(manifestOps.map((entry) => [entry.operationId, entry]));
  const backlogIssues = new Map((traceability.backlogIssues ?? []).map((issue) => [issue.id, issue]));
  const basePath = (candidateSpec.servers?.[0]?.url ?? '').replace(/\/$/, '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(traceability.backlogSnapshotVerifiedAt ?? '')) errors.push('Linear backlog snapshot verification date is required');
  for (const issue of backlogIssues.values()) {
    if (!/^REN2-\d+$/.test(issue.id ?? '') || !issue.title || issue.url !== 'https://linear.app/renivet/issue/' + issue.id || issue.verifiedAt !== traceability.backlogSnapshotVerifiedAt) {
      errors.push(`invalid Linear backlog snapshot entry: ${issue.id ?? '(missing id)'}`);
    }
  }

  if (!String(candidateSpec.info?.title ?? '').includes('PROPOSED')) errors.push('candidate title must remain marked PROPOSED');
  if (!String(candidateSpec.info?.version ?? '').includes('CANDIDATE')) errors.push('candidate version must remain marked DESIGN CANDIDATE');
  if (traceability.expectedOperationCount !== 44 || candidateOps.length !== 44) {
    errors.push(`candidate must contain exactly 44 operations; found ${candidateOps.length}`);
  }
  for (const gate of ['G08', 'G17']) if (!traceability.qualityGates?.includes(gate)) errors.push(`traceability must record quality gate ${gate}`);
  if (new Set(candidateIds).size !== candidateIds.length) errors.push('candidate contains duplicate operationIds');
  if (manifestOps.length !== candidateOps.length || new Set(manifestIds).size !== manifestIds.length) {
    errors.push('traceability manifest must contain one unique entry per candidate operation');
  }
  for (const id of candidateIdSet) if (!manifestById.has(id)) errors.push(`${id}: missing traceability entry`);
  for (const id of manifestIds) if (!candidateIdSet.has(id)) errors.push(`${id}: traceability entry has no candidate operation`);

  if (traceability.candidateBlob && traceability.candidateFile) {
    const candidateBytes = readFileSync(resolve(process.cwd(), traceability.candidateFile));
    if (sha1GitBlob(candidateBytes) !== traceability.candidateBlob) errors.push('candidate file does not match the recorded Engineering OS source blob');
  }
  const candidateSecurity = effectiveSecurity(candidateSpec);
  if (!candidateSecurity.some((requirement) => requirement.some((scheme) =>
    scheme.type === 'apiKey' && scheme.in === 'cookie' && scheme.name === '__Host-renivet_session'))) {
    errors.push('candidate must use the W1 __Host-renivet_session cookie security scheme');
  }

  for (const { path, method, operation } of candidateOps) {
    const id = operation.operationId;
    if (!id) {
      errors.push(`${method.toUpperCase()} ${path}: candidate operationId is required`);
      continue;
    }
    if (operation['x-renivet-implementation-wave'] !== 'W2') errors.push(`${id}: expected W2 implementation wave`);
    if (!operation['x-renivet-permission']) errors.push(`${id}: explicit permission mapping is required`);
    if (MUTATING_METHODS.has(method)) {
      const headerNames = effectiveParameters(candidateSpec, candidateSpec.paths[path], operation)
        .filter((parameter) => parameter.in === 'header').map((parameter) => parameter.name.toLowerCase());
      if (!headerNames.includes('idempotency-key')) errors.push(`${id}: mutation requires Idempotency-Key`);
      if (!/bound to W1 session|session-bound/i.test(String(operation['x-renivet-csrf-policy'] ?? ''))) errors.push(`${id}: cookie mutation requires a session-bound CSRF policy`);
    }
    const entry = manifestById.get(id);
    if (!entry) continue;
    if (entry.path !== path || entry.method?.toLowerCase() !== method) errors.push(`${id}: manifest method/path differs from candidate`);
    if (!/^REN2-\d+$/.test(entry.ownerIssue ?? '') || !backlogIssues.has(entry.ownerIssue) || entry.ownerIssueUrl !== backlogIssues.get(entry.ownerIssue)?.url) {
      errors.push(`${id}: owner issue must exist in the W2 backlog index and link to Linear`);
    }
    if (!Array.isArray(entry.sourceIds) || entry.sourceIds.length === 0 || entry.sourceIds.some((source) => !/^(?:A[1-6]|QA-(?:0[1-9]|1[0-9]|20))$/.test(source))) {
      errors.push(`${id}: at least one valid source ID is required`);
    }
    const implementation = entry.implementation ?? {};
    const actualPath = `${basePath}${path}` || path;
    const activeOperation = activeSpec.paths?.[actualPath]?.[method];
    if (implementation.status === 'design_only') {
      if (activeOperation) errors.push(`${id}: design-only operation appears in executable OpenAPI`);
      if (implementation.test?.status !== 'pending' || !/^tests\/w2\/.+\.test\.cjs$/.test(implementation.test?.path ?? '')) {
        errors.push(`${id}: design-only test path must be explicitly pending`);
      }
      if (implementation.pullRequest?.status !== 'pending' || implementation.pullRequest?.url != null) {
        errors.push(`${id}: design-only pull request must be explicitly pending`);
      }
    } else if (implementation.status === 'implemented') {
      if (!activeOperation) errors.push(`${id}: implemented operation is missing from executable OpenAPI`);
      else for (const mismatch of compareOperationContracts(
        operation, activeOperation, candidateSpec, activeSpec, candidateSpec.paths[path], activeSpec.paths[actualPath],
      )) errors.push(`${id}: ${mismatch}`);
      const testPath = implementation.test?.path;
      if (implementation.test?.status !== 'verified' || !testPath || !fileExists(resolve(process.cwd(), testPath))) {
        errors.push(`${id}: implemented operation requires an existing verified test path`);
      }
      const pullRequestStatus = implementation.pullRequest?.status;
      const pullRequestUrl = implementation.pullRequest?.url;
      const hasPullRequestUrl = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(pullRequestUrl ?? '');
      if (!((pullRequestStatus === 'pending' && pullRequestUrl == null) || (['open', 'merged'].includes(pullRequestStatus) && hasPullRequestUrl))) {
        errors.push(`${id}: implemented operation requires a pending or linked open/merged pull request`);
      } else if (requireLinkedPullRequest && pullRequestStatus === 'pending') {
        errors.push(`${id}: CI requires an open or merged pull request URL`);
      }
    } else {
      errors.push(`${id}: implementation status must be design_only or implemented`);
    }
  }

  for (const { path, method, operation } of extractOperations(activeSpec)) {
    if (!isW2Route(path, operation, candidateIdSet)) continue;
    const entry = manifestById.get(operation.operationId);
    if (!entry || entry.path !== path.slice(basePath.length) || entry.method?.toLowerCase() !== method) {
      errors.push(`undocumented W2 route ${method.toUpperCase()} ${path} (${operation.operationId ?? 'missing operationId'})`);
    } else if (entry.implementation?.status !== 'implemented') {
      errors.push(`${operation.operationId}: live W2 route is not marked implemented in traceability manifest`);
    }
  }
  return errors;
}

function main() {
  const root = resolve(__dirname, '..');
  const candidateSpec = yaml.load(readFileSync(resolve(root, 'openapi/W2_v1_5_CANDIDATE.yaml'), 'utf8'));
  const traceability = JSON.parse(readFileSync(resolve(root, 'openapi/w2-operation-traceability.json'), 'utf8'));
  const activeSpec = JSON.parse(readFileSync(resolve(root, 'openapi/renivet.openapi.json'), 'utf8'));
  const errors = checkTraceability({ candidateSpec, traceability, activeSpec, fileExists: existsSync });
  if (errors.length) {
    for (const error of errors) process.stderr.write(`W2 contract traceability: ${error}\n`);
    process.exitCode = 1;
    return;
  }
  const implemented = traceability.operations.filter(({ implementation }) => implementation.status === 'implemented').length;
  process.stdout.write(`W2 contract traceability check passed (44 design-candidate operations, ${implemented} implemented W2 routes; active OpenAPI/SDK remain route-generated).\n`);
}

if (require.main === module) main();

module.exports = { checkTraceability, compareOperationContracts, extractOperations };
