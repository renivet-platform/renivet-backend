import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';
import { ImportResultFormat } from './import-recovery.dto';
import type { PoolClient } from 'pg';
import type { DurableEvent } from '../../workers/durable-worker';
import type { WorkerAuthorizationContext } from '../../workers/worker-authorization';
import { ImportConfirmationService, ConfirmInput } from './import-confirmation.service';

export type ImportRecoveryInput = { brandId: string; batchId: string; actorUserId: string; requestId: string };
export type ImportRetryInput = ImportRecoveryInput & { idempotencyKey: string; previewRevision: number; errorCodes: string[] };

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function hash(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }
function safeCsvCell(value: unknown): string {
  let cell = String(value ?? '');
  if (/^[=+\-@]/.test(cell.trimStart())) cell = `'${cell}`;
  return `"${cell.replace(/"/g, '""')}"`;
}
function errorCodes(receipt: unknown): string[] {
  const value = receipt && typeof receipt === 'object' ? receipt as Record<string, unknown> : {};
  const codes = new Set<string>();
  if (typeof value.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code)) codes.add(value.code);
  if (Array.isArray(value.failures)) for (const failure of value.failures) {
    const code = failure && typeof failure === 'object' ? (failure as Record<string, unknown>).code : undefined;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) codes.add(code);
  }
  return [...codes].sort();
}

@Injectable()
export class ImportRecoveryService {
  constructor(private readonly infrastructure: IdentityInfrastructure, private readonly confirmation: ImportConfirmationService) {}

  async processRetryEvent(event: DurableEvent, client: PoolClient, authorization: WorkerAuthorizationContext): Promise<void> {
    if (event.eventType !== 'imports.retry_requested' || event.eventVersion !== 1 || event.aggregateType !== 'imports.import_batch') {
      throw Object.assign(new Error('unsupported import retry event'), { code: 'IMPORT_EVENT_INVALID' });
    }
    const payload = event.eventPayload && typeof event.eventPayload === 'object' ? event.eventPayload as Record<string, unknown> : {};
    const retryId = typeof payload.retryRequestId === 'string' ? payload.retryRequestId : '';
    if (!/^[0-9a-f-]{36}$/i.test(retryId)) throw Object.assign(new Error('retry request is invalid'), { code: 'IMPORT_EVENT_INVALID' });
    const requestResult = await client.query(`SELECT id,brand_id,batch_id,preview_revision,preview_hash,error_codes,state,requested_by
      FROM imports.import_retry_requests WHERE id=$1 AND batch_id=$2 FOR UPDATE`, [retryId,event.aggregateId]);
    const request = requestResult.rows[0];
    if (!request || String(request.brand_id) !== authorization.brandId) throw Object.assign(new Error('retry request is unavailable'), { code: 'IMPORT_RETRY_NOT_FOUND' });
    if (request.state !== 'QUEUED') return;
    await authorization.authorizeEffect('imports.retry', String(request.brand_id));
    const confirmation = await client.query(`SELECT 1 FROM imports.import_confirmations WHERE batch_id=$1 AND brand_id=$2
      ORDER BY confirmed_at DESC LIMIT 1`, [request.batch_id,request.brand_id]);
    if (!confirmation.rowCount) throw Object.assign(new Error('confirmation actor is unavailable'), { code: 'IMPORT_CONFIRMATION_NOT_FOUND' });
    const preview = await client.query(`SELECT preview_snapshot FROM imports.import_previews WHERE batch_id=$1 AND brand_id=$2
      AND preview_revision=$3 AND preview_hash=$4 FOR SHARE`, [request.batch_id,request.brand_id,request.preview_revision,String(request.preview_hash).trim()]);
    if (!preview.rowCount) throw Object.assign(new Error('retry preview is unavailable'), { code: 'PREVIEW_STALE' });
    const frozen = preview.rows[0].preview_snapshot && typeof preview.rows[0].preview_snapshot === 'object' ? preview.rows[0].preview_snapshot as Record<string,unknown> : {};
    const frozenRows = Array.isArray(frozen.rows) ? frozen.rows as Array<Record<string,unknown>> : [];
    const rows = await client.query(`SELECT id,source_row_number,row_state,result_receipt FROM imports.import_rows WHERE batch_id=$1 AND brand_id=$2
      AND row_state IN ('FAILED','PARTIAL') ORDER BY source_row_number FOR UPDATE`, [request.batch_id,request.brand_id]);
    const requestedCodes = Array.isArray(request.error_codes) ? request.error_codes as string[] : [];
    let stillFailed = 0;
    for (const row of rows.rows as Array<Record<string,unknown>>) {
      const previous = row.result_receipt && typeof row.result_receipt === 'object' ? row.result_receipt as Record<string,unknown> : {};
      const codes = errorCodes(previous);
      if (requestedCodes.length && !requestedCodes.some((code) => codes.includes(code))) continue;
      const rowNumber = Number(row.source_row_number);
      const source = frozenRows.find((candidate) => Number(candidate.sourceRowNumber) === rowNumber);
      if (!source) { stillFailed += 1; continue; }
      const input: ConfirmInput = { brandId: String(request.brand_id), batchId: String(request.batch_id), actorUserId: String(request.requested_by),
        idempotencyKey: `imp:${request.batch_id}:${row.id}:product`, previewRevision: Number(request.preview_revision),
        previewHash: String(request.preview_hash).trim(), allowPartial: true, requestId: `retry:${retryId}` };
      const outcome = await this.confirmation.applyRetryRow(client,input,String(row.id),source as never);
      const failed = outcome.failures.length > 0;
      if (failed) stillFailed += 1;
      const receiptCount = await client.query(`SELECT count(*)::integer AS count FROM imports.import_effect_receipts WHERE batch_id=$1 AND brand_id=$2 AND row_id=$3`, [request.batch_id,request.brand_id,row.id]);
      const rowReceipt = { status: failed ? 'PARTIAL' : 'APPLIED', effectCount: Number(receiptCount.rows[0].count), failedEffectCount: outcome.failures.length,
        failures: outcome.failures };
      await client.query(`UPDATE imports.import_rows SET row_state=$4,result_receipt=$5::jsonb WHERE id=$1 AND batch_id=$2 AND brand_id=$3`,
        [row.id,request.batch_id,request.brand_id,failed ? 'PARTIAL' : 'APPLIED',JSON.stringify(rowReceipt)]);
    }
    const remaining = await client.query(`SELECT count(*)::integer AS count FROM imports.import_rows WHERE batch_id=$1 AND brand_id=$2 AND row_state IN ('FAILED','PARTIAL')`, [request.batch_id,request.brand_id]);
    const batchState = Number(remaining.rows[0].count) ? 'PARTIAL' : 'COMPLETED';
    const retryState = stillFailed || Number(remaining.rows[0].count) ? 'PARTIAL' : 'COMPLETED';
    await client.query(`UPDATE imports.import_batches SET job_state=$3,updated_at=now() WHERE id=$1 AND brand_id=$2`, [request.batch_id,request.brand_id,batchState]);
    await client.query(`UPDATE imports.import_retry_requests SET state=$2,updated_at=now() WHERE id=$1 AND state='QUEUED'`, [retryId,retryState]);
    await client.query(`INSERT INTO access.security_audit_events(actor_user_id,action,subject_type,subject_id,request_id,payload_hash)
      VALUES($1,'imports.retry_completed','imports.batch',$2,$3,$4)`, [request.requested_by,request.batch_id,`retry:${retryId}`,hash({ retryId,batchState,retryState })]);
  }

  async getResults(input: Omit<ImportRecoveryInput, 'requestId'> & { cursor: string | null; limit: number; format: ImportResultFormat }): Promise<{
    page: Record<string, unknown>; csv: string;
  }> {
    const pool = this.infrastructure.pool;
    if (!pool) throw new ServiceUnavailableException({ code: 'IMPORT_DATABASE_UNAVAILABLE', message: 'Import storage is unavailable.' });
    const after = input.cursor === null ? 0 : Number(input.cursor);
    if ((input.cursor !== null && !/^[1-9][0-9]{0,9}$/.test(input.cursor)) || !Number.isSafeInteger(after) || after < 0) {
      throw new ConflictException({ code: 'IMPORT_RESULTS_CURSOR_INVALID', message: 'The results cursor is invalid.' });
    }
    const result = await pool.query(`SELECT b.job_state AS "batchState",r.id,r.source_row_number AS "rowNumber",r.row_state AS status,
        r.result_receipt AS receipt,COALESCE(array_agg(e.id) FILTER (WHERE e.id IS NOT NULL),'{}') AS "effectReceiptIds"
      FROM imports.import_batches b
      JOIN imports.import_rows r ON r.batch_id=b.id AND r.brand_id=b.brand_id
      LEFT JOIN imports.import_effect_receipts e ON e.batch_id=r.batch_id AND e.row_id=r.id AND e.brand_id=r.brand_id
      WHERE b.id=$1 AND b.brand_id=$2 AND r.source_row_number>$3
        AND EXISTS (SELECT 1 FROM access.effective_permissions p WHERE p.user_id=$4 AND p.permission_code='imports.read'
          AND ((p.scope_type='global' AND p.brand_id IS NULL) OR (p.scope_type='brand' AND p.brand_id=$2)))
      GROUP BY b.job_state,r.id,r.source_row_number,r.row_state,r.result_receipt
      ORDER BY r.source_row_number LIMIT $5`, [input.batchId, input.brandId, after, input.actorUserId, input.limit + 1]);
    if (!result.rows.length) {
      const exists = await pool.query(`SELECT 1 FROM imports.import_batches b WHERE b.id=$1 AND b.brand_id=$2
        AND EXISTS (SELECT 1 FROM access.effective_permissions p WHERE p.user_id=$3 AND p.permission_code='imports.read'
          AND ((p.scope_type='global' AND p.brand_id IS NULL) OR (p.scope_type='brand' AND p.brand_id=$2)))`, [input.batchId, input.brandId, input.actorUserId]);
      if (!exists.rowCount) throw new NotFoundException({ code: 'IMPORT_BATCH_NOT_FOUND', message: 'The import batch is not available.' });
    }
    const hasMore = result.rows.length > input.limit;
    const selected = result.rows.slice(0, input.limit);
    const items = selected.map((row: Record<string, unknown>) => ({ rowNumber: Number(row.rowNumber), status: String(row.status),
      errorCodes: errorCodes(row.receipt), effectReceiptIds: Array.isArray(row.effectReceiptIds) ? row.effectReceiptIds.map(String) : [] }));
    const retryJobs = await pool.query(`SELECT r.id,r.state,r.row_count AS "rowCount",r.created_at AS "createdAt",j.state AS "jobState",j.last_error_code AS "lastErrorCode"
      FROM imports.import_retry_requests r
      LEFT JOIN platform.outbox_events o ON o.aggregate_type='imports.import_batch' AND o.aggregate_id=r.batch_id
        AND o.event_type='imports.retry_requested' AND o.event_payload->>'retryRequestId'=r.id::text
      LEFT JOIN platform.durable_jobs j ON j.job_kind='imports.retry' AND j.business_key=o.id::text
      WHERE r.batch_id=$1 AND r.brand_id=$2 AND EXISTS (SELECT 1 FROM access.effective_permissions p WHERE p.user_id=$3
        AND p.permission_code='imports.read' AND ((p.scope_type='global' AND p.brand_id IS NULL) OR (p.scope_type='brand' AND p.brand_id=$2)))
      ORDER BY r.created_at DESC LIMIT 20`, [input.batchId, input.brandId, input.actorUserId]);
    const page = { batchId: input.batchId, items, nextCursor: hasMore ? String(items[items.length - 1].rowNumber) : null,
      retryRequests: retryJobs.rows.map((row: Record<string, unknown>) => ({ retryRequestId: String(row.id), state: row.jobState === 'dead_letter' ? 'FAILED' : String(row.state),
        rowCount: Number(row.rowCount), errorCode: typeof row.lastErrorCode === 'string' ? row.lastErrorCode : null })) };
    const lines = [['row_number','status','error_codes','effect_receipt_ids'].map(safeCsvCell).join(','),
      ...items.map((row) => [row.rowNumber, row.status, row.errorCodes.join(';'), row.effectReceiptIds.join(';')].map(safeCsvCell).join(','))];
    return { page, csv: `${lines.join('\r\n')}\r\n` };
  }

  async retryFailures(input: ImportRetryInput): Promise<Record<string, unknown>> {
    const pool = this.infrastructure.pool;
    if (!pool) throw new ServiceUnavailableException({ code: 'IMPORT_DATABASE_UNAVAILABLE', message: 'Import storage is unavailable.' });
    const client = await pool.connect();
    const codes = [...new Set(input.errorCodes)].sort();
    const requestHash = hash({ brandId: input.brandId, batchId: input.batchId, previewRevision: input.previewRevision, mode: 'FAILED_ONLY', errorCodes: codes });
    try {
      await client.query('BEGIN');
      const batch = await client.query(`SELECT id,preview_revision,preview_hash,job_state FROM imports.import_batches b
        WHERE id=$1 AND brand_id=$2 AND EXISTS (SELECT 1 FROM access.effective_permissions p WHERE p.user_id=$3 AND p.permission_code='imports.write'
          AND ((p.scope_type='global' AND p.brand_id IS NULL) OR (p.scope_type='brand' AND p.brand_id=$2))) FOR UPDATE`, [input.batchId, input.brandId, input.actorUserId]);
      if (!batch.rowCount) throw new NotFoundException({ code: 'IMPORT_BATCH_NOT_FOUND', message: 'The import batch is not available.' });
      const prior = await client.query(`SELECT request_hash,response_payload FROM imports.import_retry_requests WHERE brand_id=$1 AND idempotency_key=$2`, [input.brandId, input.idempotencyKey]);
      if (prior.rows[0]) {
        if (String(prior.rows[0].request_hash).trim() !== requestHash) throw new ConflictException({ code: 'IMPORT_IDEMPOTENCY_CONFLICT', message: 'The retry key was used for different retry data.' });
        await client.query('COMMIT');
        return prior.rows[0].response_payload;
      }
      if (Number(batch.rows[0].preview_revision) !== input.previewRevision || !batch.rows[0].preview_hash) throw new ConflictException({ code: 'PREVIEW_STALE', message: 'The import preview changed. Refresh results before retrying.' });
      if (!['PARTIAL','FAILED'].includes(String(batch.rows[0].job_state))) throw new ConflictException({ code: 'IMPORT_BATCH_STATE_CONFLICT', message: 'Only a partially failed import can be retried.' });
      const candidates = await client.query(`SELECT count(*)::integer AS count FROM imports.import_rows r WHERE r.batch_id=$1 AND r.brand_id=$2
        AND r.row_state IN ('FAILED','PARTIAL') AND (cardinality($3::text[])=0
          OR r.result_receipt->>'code'=ANY($3::text[])
          OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.result_receipt->'failures')='array' THEN r.result_receipt->'failures' ELSE '[]'::jsonb END) f WHERE f->>'code'=ANY($3::text[])))`, [input.batchId, input.brandId, codes]);
      const id = randomUUID();
      if (Number(candidates.rows[0].count) < 1) throw new ConflictException({ code: 'IMPORT_RETRY_NO_ELIGIBLE_ROWS', message: 'No failed rows match the selected retry filters.' });
      const response = { batchId: input.batchId, retryRequestId: id, state: 'QUEUED', rowCount: Number(candidates.rows[0].count) };
      await client.query(`INSERT INTO imports.import_retry_requests(id,brand_id,batch_id,preview_revision,preview_hash,idempotency_key,request_hash,error_codes,row_count,requested_by,response_payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11::jsonb)`, [id,input.brandId,input.batchId,input.previewRevision,String(batch.rows[0].preview_hash).trim(),input.idempotencyKey,requestHash,codes,response.rowCount,input.actorUserId,JSON.stringify(response)]);
      const eventKey = `retry:${createHash('sha256').update(input.idempotencyKey).digest('hex')}`;
      await client.query(`INSERT INTO platform.outbox_events(aggregate_type,aggregate_id,event_type,event_version,event_payload,event_key)
        VALUES('imports.import_batch',$1,'imports.retry_requested',1,$2::jsonb,$3)`, [input.batchId,JSON.stringify({ brandId: input.brandId, retryRequestId: id }),eventKey]);
      await client.query(`INSERT INTO access.security_audit_events(actor_user_id,action,subject_type,subject_id,request_id,payload_hash)
        VALUES($1,'imports.retry_requested','imports.batch',$2,$3,$4)`, [input.actorUserId,input.batchId,input.requestId,requestHash]);
      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof ConflictException || error instanceof NotFoundException) throw error;
      const code = (error as { code?: string } | null)?.code;
      if (code?.startsWith('08') || ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','57P01'].includes(code ?? '')) throw new ServiceUnavailableException({ code: 'IMPORT_DATABASE_UNAVAILABLE', message: 'Import storage is unavailable.' });
      throw error;
    } finally { client.release(); }
  }
}
