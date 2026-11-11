'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { W2OperationalMetricsReader, evaluateW2OperationalAlerts } = require('../dist/workers/w2-operational-metrics.js');

test('operational metrics read one consistent snapshot and release the connection', async () => {
  const statements = [];
  let released = false;
  const values = {
    qc_submitted: '3', batches_last_hour: '4', rows_last_hour: '12', failed_rows_last_hour: '2',
    oldest_submitted_age_seconds: '120', pending_media_scans: '1', oldest_pending_media_scan_seconds: '90', open_reconciliation_cases: '1',
    drifted_stock_pools: '0', pending_jobs: '2', leased_jobs: '1', dead_letter_jobs: '1',
    oldest_pending_job_seconds: '30', active_job_kinds: '2', largest_kind_backlog: '2',
    smallest_kind_backlog: '1', pending_backlog_skew: '1', outdated_search_projections: '1', oldest_outdated_projection_seconds: '60',
    restricted_published_documents: '0',
  };
  const client = {
    query: async (sql) => {
      statements.push(sql.trim());
      if (sql.includes('WITH\nqc AS')) return { rows: [values], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => { released = true; },
  };
  const reader = new W2OperationalMetricsReader({ connect: async () => client });

  const snapshot = await reader.readSnapshot();

  assert.deepEqual(statements.slice(0, 3), [
    'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    statements[1],
    'COMMIT',
  ]);
  assert.equal(snapshot.catalog.qcSubmitted, 3);
  assert.equal(snapshot.imports.rowsLastHour, 12);
  assert.equal(snapshot.imports.failedRowsLastHour, 2);
  assert.equal(snapshot.inventory.driftedStockPools, 0);
  assert.equal(snapshot.workers.deadLetterJobs, 1);
  assert.equal(snapshot.workers.pendingBacklogSkew, 1);
  assert.equal(snapshot.search.restrictedPublishedDocuments, 0);
  assert.equal(JSON.stringify(snapshot).includes('brandId'), false);
  assert.equal(released, true);
});

test('operational metrics roll back and release after a failed query', async () => {
  const statements = [];
  let released = false;
  const client = {
    query: async (sql) => {
      statements.push(sql.trim());
      if (sql.includes('WITH\nqc AS')) throw new Error('supplier private row data');
      return { rows: [], rowCount: 0 };
    },
    release: () => { released = true; },
  };
  const reader = new W2OperationalMetricsReader({ connect: async () => client });

  await assert.rejects(reader.readSnapshot(), /supplier private row data/);
  assert.equal(statements.at(-1), 'ROLLBACK');
  assert.equal(released, true);
});

test('alert evaluation requires explicit measured thresholds and only emits safe aggregate signals', () => {
  const snapshot = {
    catalog: { qcSubmitted: 3, oldestSubmittedAgeSeconds: 120 },
    imports: { batchesLastHour: 4, rowsLastHour: 12, failedRowsLastHour: 2 },
    media: { pendingScans: 1, oldestPendingScanAgeSeconds: 90 },
    inventory: { openReconciliationCases: 1, driftedStockPools: 0 },
    workers: { pendingJobs: 2, leasedJobs: 1, deadLetterJobs: 1, oldestPendingJobAgeSeconds: 30, activeJobKinds: 2,
      largestKindBacklog: 2, smallestKindBacklog: 1, pendingBacklogSkew: 1 },
    search: { outdatedProjections: 1, oldestOutdatedProjectionAgeSeconds: 60, restrictedPublishedDocuments: 1 },
  };

  assert.throws(() => evaluateW2OperationalAlerts(snapshot), /thresholds/i);
  assert.throws(() => evaluateW2OperationalAlerts(snapshot, { qcAgeSeconds: 1, importFailureRate: 2, mediaScanAgeSeconds: 1,
    pendingJobAgeSeconds: 1, searchProjectionAgeSeconds: 1, pendingBacklogSkew: 1 }), /thresholds/i);
  const alerts = evaluateW2OperationalAlerts(snapshot, {
    qcAgeSeconds: 60, importFailureRate: 0.1, mediaScanAgeSeconds: 30, pendingJobAgeSeconds: 20,
    searchProjectionAgeSeconds: 30, pendingBacklogSkew: 0,
  });
  assert.deepEqual(alerts.map(({ signal }) => signal), [
    'catalog.qc_backlog_age', 'imports.row_failure_rate', 'media.scan_lag', 'inventory.reconciliation_case',
    'worker.dead_letter', 'worker.pending_age', 'worker.backlog_skew', 'search.projection_lag', 'search.restricted_document_visible',
  ]);
  assert.equal(JSON.stringify(alerts).includes('supplier private row data'), false);
  assert.ok(alerts.every((alert) => Object.keys(alert).sort().join(',') === 'count,signal'));
});
