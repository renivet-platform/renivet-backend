import type { Pool, PoolClient } from 'pg';

export type W2OperationalMetrics = Readonly<{
  catalog: Readonly<{ qcSubmitted: number; oldestSubmittedAgeSeconds: number }>;
  imports: Readonly<{ batchesLastHour: number; rowsLastHour: number; failedRowsLastHour: number }>;
  media: Readonly<{ pendingScans: number; oldestPendingScanAgeSeconds: number }>;
  inventory: Readonly<{ openReconciliationCases: number; driftedStockPools: number }>;
  workers: Readonly<{
    pendingJobs: number; leasedJobs: number; deadLetterJobs: number; oldestPendingJobAgeSeconds: number;
    activeJobKinds: number; largestKindBacklog: number; smallestKindBacklog: number; pendingBacklogSkew: number;
  }>;
  search: Readonly<{
    outdatedProjections: number; oldestOutdatedProjectionAgeSeconds: number; restrictedPublishedDocuments: number;
  }>;
}>;

type MetricRow = {
  qc_submitted: string | number;
  oldest_submitted_age_seconds: string | number;
  batches_last_hour: string | number;
  rows_last_hour: string | number;
  failed_rows_last_hour: string | number;
  pending_media_scans: string | number;
  oldest_pending_media_scan_seconds: string | number;
  open_reconciliation_cases: string | number;
  drifted_stock_pools: string | number;
  pending_jobs: string | number;
  leased_jobs: string | number;
  dead_letter_jobs: string | number;
  oldest_pending_job_seconds: string | number;
  active_job_kinds: string | number;
  largest_kind_backlog: string | number;
  smallest_kind_backlog: string | number;
  pending_backlog_skew: string | number;
  outdated_search_projections: string | number;
  oldest_outdated_projection_seconds: string | number;
  restricted_published_documents: string | number;
};

const SNAPSHOT_SQL = `WITH
qc AS (
  SELECT count(*) FILTER (WHERE review_state = 'SUBMITTED')::bigint AS submitted,
         coalesce(floor(extract(epoch FROM now() - min(created_at) FILTER (WHERE review_state = 'SUBMITTED'))), 0)::bigint AS oldest_age_seconds
  FROM catalogue.product_revisions
),
imports AS (
  SELECT count(DISTINCT batch.id)::bigint AS batches_last_hour,
         count(row.id)::bigint AS rows_last_hour,
         count(row.id) FILTER (WHERE row.row_state IN ('FAILED','PARTIAL') OR
           CASE WHEN jsonb_typeof(row.validation_errors) = 'array' THEN jsonb_array_length(row.validation_errors) > 0 ELSE false END)::bigint AS failed_rows_last_hour
  FROM imports.import_batches AS batch
  LEFT JOIN imports.import_rows AS row ON row.batch_id = batch.id AND row.brand_id = batch.brand_id
  WHERE batch.created_at >= now() - interval '1 hour'
),
media AS (
  SELECT count(*) FILTER (WHERE scan_state = 'PENDING')::bigint AS pending_scans,
         coalesce(floor(extract(epoch FROM now() - min(created_at) FILTER (WHERE scan_state = 'PENDING'))), 0)::bigint AS oldest_age_seconds
  FROM media.media_assets
),
stock AS (
  SELECT count(*) FILTER (WHERE
      balance.physical_on_hand <> coalesce(events.physical, 0)
      OR balance.quarantined <> coalesce(events.quarantined, 0)
      OR balance.other_non_sellable <> coalesce(events.other_non_sellable, 0)
      OR balance.allocated_not_dispatched <> coalesce(events.allocated, 0)
      OR balance.safety_buffer <> coalesce(events.buffer, 0)
      OR balance.row_version <> coalesce(events.max_sequence, 0)
      OR coalesce(events.event_count, 0) <> coalesce(events.max_sequence, 0))::bigint AS drifted_pools
  FROM inventory.stock_balances AS balance
  LEFT JOIN LATERAL (
    SELECT count(*)::bigint AS event_count, coalesce(max(pool_sequence),0)::bigint AS max_sequence,
           coalesce(sum(delta_physical),0)::bigint AS physical,
           coalesce(sum(delta_quarantined),0)::bigint AS quarantined,
           coalesce(sum(delta_other_non_sellable),0)::bigint AS other_non_sellable,
           coalesce(sum(delta_allocated),0)::bigint AS allocated,
           coalesce(sum(delta_buffer),0)::bigint AS buffer
    FROM inventory.stock_events AS event
    WHERE event.brand_id=balance.brand_id AND event.variant_id=balance.variant_id AND event.location_id=balance.location_id
  ) AS events ON true
),
cases AS (
  SELECT count(*) FILTER (WHERE case_state IN ('OPEN','UNDER_REVIEW'))::bigint AS open_cases FROM inventory.reconciliation_cases
),
worker AS (
  SELECT count(*) FILTER (WHERE state='pending')::bigint AS pending,
         count(*) FILTER (WHERE state='leased')::bigint AS leased,
         count(*) FILTER (WHERE state='dead_letter')::bigint AS dead_letter,
         coalesce(floor(extract(epoch FROM now() - min(scheduled_for) FILTER (WHERE state='pending' AND scheduled_for <= now()))),0)::bigint AS oldest_pending_seconds
  FROM platform.durable_jobs
),
fairness AS (
  SELECT count(*)::bigint AS active_kinds, coalesce(max(backlog),0)::bigint AS largest,
         coalesce(min(backlog),0)::bigint AS smallest
  FROM (SELECT job_kind, count(*) FILTER (WHERE state IN ('pending','leased'))::bigint AS backlog
        FROM platform.durable_jobs GROUP BY job_kind HAVING count(*) FILTER (WHERE state IN ('pending','leased')) > 0) AS per_kind
),
search AS (
  SELECT count(*) FILTER (WHERE projection.product_id IS NULL OR projection.publication_version <> product.publication_version
                            OR projection.document_state <> 'PUBLISHED')::bigint AS outdated,
         coalesce(floor(extract(epoch FROM now() - min(coalesce(projection.updated_at,product.updated_at)) FILTER (
           WHERE projection.product_id IS NULL OR projection.publication_version <> product.publication_version OR projection.document_state <> 'PUBLISHED'))),0)::bigint AS oldest_outdated_seconds,
         count(*) FILTER (WHERE product.publication_state='RESTRICTED' AND projection.document_state='PUBLISHED')::bigint AS restricted_published
  FROM catalogue.products AS product
  LEFT JOIN catalogue.search_projection_state AS projection ON projection.product_id=product.id AND projection.brand_id=product.brand_id
  WHERE product.publication_state='PUBLISHED' OR product.publication_state='RESTRICTED'
)
SELECT qc.submitted AS qc_submitted, qc.oldest_age_seconds AS oldest_submitted_age_seconds,
       imports.batches_last_hour, imports.rows_last_hour, imports.failed_rows_last_hour,
       media.pending_scans AS pending_media_scans, media.oldest_age_seconds AS oldest_pending_media_scan_seconds,
       cases.open_cases AS open_reconciliation_cases, stock.drifted_pools AS drifted_stock_pools,
       worker.pending AS pending_jobs, worker.leased AS leased_jobs, worker.dead_letter AS dead_letter_jobs,
       worker.oldest_pending_seconds AS oldest_pending_job_seconds,
       fairness.active_kinds AS active_job_kinds, fairness.largest AS largest_kind_backlog,
       fairness.smallest AS smallest_kind_backlog, (fairness.largest-fairness.smallest)::bigint AS pending_backlog_skew,
       search.outdated AS outdated_search_projections, search.oldest_outdated_seconds AS oldest_outdated_projection_seconds,
       search.restricted_published AS restricted_published_documents
FROM qc CROSS JOIN imports CROSS JOIN media CROSS JOIN cases CROSS JOIN stock CROSS JOIN worker CROSS JOIN fairness CROSS JOIN search`;

function asNonNegativeInteger(value: string | number, name: string): number {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) throw new TypeError(`invalid operational metric: ${name}`);
  return numberValue;
}

/** Read aggregate-only operational signals from authoritative W2 PostgreSQL state. */
export class W2OperationalMetricsReader {
  constructor(private readonly pool: Pick<Pool, 'connect'>) {}

  async readSnapshot(): Promise<W2OperationalMetrics> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await client.query<MetricRow>(SNAPSHOT_SQL);
      if (result.rowCount !== 1) throw new Error('operational metrics snapshot was not returned');
      const row = result.rows[0];
      const metric = (key: keyof MetricRow) => asNonNegativeInteger(row[key], key);
      const snapshot = {
        catalog: { qcSubmitted: metric('qc_submitted'), oldestSubmittedAgeSeconds: metric('oldest_submitted_age_seconds') },
        imports: { batchesLastHour: metric('batches_last_hour'), rowsLastHour: metric('rows_last_hour'), failedRowsLastHour: metric('failed_rows_last_hour') },
        media: { pendingScans: metric('pending_media_scans'), oldestPendingScanAgeSeconds: metric('oldest_pending_media_scan_seconds') },
        inventory: { openReconciliationCases: metric('open_reconciliation_cases'), driftedStockPools: metric('drifted_stock_pools') },
        workers: {
          pendingJobs: metric('pending_jobs'), leasedJobs: metric('leased_jobs'), deadLetterJobs: metric('dead_letter_jobs'),
          oldestPendingJobAgeSeconds: metric('oldest_pending_job_seconds'), activeJobKinds: metric('active_job_kinds'),
          largestKindBacklog: metric('largest_kind_backlog'), smallestKindBacklog: metric('smallest_kind_backlog'),
          pendingBacklogSkew: metric('pending_backlog_skew'),
        },
        search: {
          outdatedProjections: metric('outdated_search_projections'), oldestOutdatedProjectionAgeSeconds: metric('oldest_outdated_projection_seconds'),
          restrictedPublishedDocuments: metric('restricted_published_documents'),
        },
      } as const;
      await client.query('COMMIT');
      return snapshot;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export type W2OperationalAlertThresholds = Readonly<{
  qcAgeSeconds: number;
  importFailureRate: number;
  mediaScanAgeSeconds: number;
  pendingJobAgeSeconds: number;
  searchProjectionAgeSeconds: number;
  pendingBacklogSkew: number;
}>;

export type W2OperationalAlert = Readonly<{ signal: string; count: number }>;

/** Compare measured snapshots with explicitly supplied, owner-reviewed thresholds; never invent SLAs. */
export function evaluateW2OperationalAlerts(
  snapshot: W2OperationalMetrics,
  thresholds?: W2OperationalAlertThresholds,
): W2OperationalAlert[] {
  if (!thresholds || Object.values(thresholds).some((value) => !Number.isFinite(value) || value < 0) || thresholds.importFailureRate > 1) {
    throw new TypeError('explicit non-negative operational thresholds are required');
  }
  const alerts: W2OperationalAlert[] = [];
  const add = (signal: string, count: number) => { if (count > 0) alerts.push({ signal, count }); };
  if (snapshot.catalog.qcSubmitted > 0 && snapshot.catalog.oldestSubmittedAgeSeconds > thresholds.qcAgeSeconds) {
    add('catalog.qc_backlog_age', snapshot.catalog.qcSubmitted);
  }
  if (snapshot.imports.rowsLastHour > 0 && snapshot.imports.failedRowsLastHour / snapshot.imports.rowsLastHour > thresholds.importFailureRate) {
    add('imports.row_failure_rate', snapshot.imports.failedRowsLastHour);
  }
  if (snapshot.media.pendingScans > 0 && snapshot.media.oldestPendingScanAgeSeconds > thresholds.mediaScanAgeSeconds) {
    add('media.scan_lag', snapshot.media.pendingScans);
  }
  add('inventory.reconciliation_case', snapshot.inventory.openReconciliationCases);
  add('inventory.journal_drift', snapshot.inventory.driftedStockPools);
  add('worker.dead_letter', snapshot.workers.deadLetterJobs);
  if (snapshot.workers.pendingJobs > 0 && snapshot.workers.oldestPendingJobAgeSeconds > thresholds.pendingJobAgeSeconds) {
    add('worker.pending_age', snapshot.workers.pendingJobs);
  }
  if (snapshot.workers.activeJobKinds > 1 && snapshot.workers.pendingBacklogSkew > thresholds.pendingBacklogSkew) {
    add('worker.backlog_skew', snapshot.workers.pendingBacklogSkew);
  }
  if (snapshot.search.outdatedProjections > 0 && snapshot.search.oldestOutdatedProjectionAgeSeconds > thresholds.searchProjectionAgeSeconds) {
    add('search.projection_lag', snapshot.search.outdatedProjections);
  }
  add('search.restricted_document_visible', snapshot.search.restrictedPublishedDocuments);
  return alerts;
}
