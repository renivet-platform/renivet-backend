import { Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';
import { MediaDerivative } from './media-ports';
import { MediaAccessContext, MediaAssetRecord, MediaMutationContext, MediaRepositoryPort } from './media.service';
import { MediaUploadInit } from './media-validation';

interface MediaRow {
  id: string; brand_id: string; storage_key: string; upload_key: string; mime_type: string; file_name: string;
  byte_length: string | number; expected_sha256: string | null; scan_state: MediaAssetRecord['scanState'];
  rights_state: MediaAssetRecord['rightsState']; derivative_state: MediaAssetRecord['derivativeState'];
  upload_expires_at: Date | string; sha256: string | null; width: number | null; height: number | null;
  upload_request_sha256: string | null;
  rejection_code: string | null; completion_idempotency_key: string | null; completion_request_sha256: string | null; row_version: string | number;
}

export class MediaRepositoryError extends Error {
  constructor(readonly status: number, readonly code: string, message = 'The media request could not be completed.') {
    super(message); this.name = 'MediaRepositoryError';
  }
}

@Injectable()
export class MediaPostgresRepository implements MediaRepositoryPort {
  constructor(private readonly infrastructure: IdentityInfrastructure) {}

  async createIntent(input: {
    assetId: string; storageKey: string; uploadKey: string; request: MediaUploadInit; requestSha256: string; context: MediaMutationContext;
  }): Promise<MediaAssetRecord> {
    return this.transaction(async (client) => {
      const created = await client.query<MediaRow>(
        `INSERT INTO media.media_assets (
           id, brand_id, storage_key, upload_key, sha256, expected_sha256, mime_type, file_name, byte_length,
           scan_state, rights_state, rights_attested_by, rights_attested_at, upload_expires_at,
           upload_idempotency_key, upload_request_sha256, derivative_state, row_version
         )
         SELECT $1,$2,$3,$4,NULL,$5,$6,$7,$8,'PENDING',
           CASE WHEN $9 THEN 'ATTESTED' ELSE 'UNVERIFIED' END,
           CASE WHEN $9 THEN $10::uuid ELSE NULL END,
           CASE WHEN $9 THEN now() ELSE NULL END,
           now() + interval '5 minutes',$11,$12,'PENDING',1
         WHERE EXISTS (
           SELECT 1 FROM brands.brands b
           JOIN access.effective_permissions ep ON ep.user_id=$10 AND ep.permission_code=$13
           WHERE b.id=$2 AND b.onboarding_state='approved'
             AND ((ep.scope_type='global' AND ep.brand_id IS NULL)
               OR (ep.scope_type='brand' AND ep.brand_id=b.id))
         )
         ON CONFLICT (brand_id, upload_idempotency_key) WHERE upload_idempotency_key IS NOT NULL DO NOTHING
         RETURNING *`,
        [input.assetId, input.context.brandId, input.storageKey, input.uploadKey, input.request.sha256,
          input.request.mimeType, input.request.fileName, input.request.byteLength, input.request.rightsAttested,
          input.context.userId, input.context.idempotencyKey, input.requestSha256, input.context.permission],
      );
      if (created.rows[0]) {
        await this.audit(client, created.rows[0], input.context, 'upload_intent_issued', null);
        return mapMediaRow(created.rows[0]);
      }
      const existing = await client.query<MediaRow>(
        `SELECT ma.* FROM media.media_assets ma
         WHERE ma.brand_id=$1 AND ma.upload_idempotency_key=$2
           AND EXISTS (SELECT 1 FROM access.effective_permissions ep
             WHERE ep.user_id=$3 AND ep.permission_code=$4
               AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=ma.brand_id)))
         FOR UPDATE OF ma`,
        [input.context.brandId, input.context.idempotencyKey, input.context.userId, input.context.permission],
      );
      const row = existing.rows[0];
      if (!row) throw notFound();
      if (trimHash(row.upload_request_sha256) !== input.requestSha256) {
        throw new MediaRepositoryError(409, 'MEDIA_IDEMPOTENCY_CONFLICT');
      }
      if (row.scan_state === 'PENDING') {
        const renewed = await client.query<MediaRow>(
          `UPDATE media.media_assets SET upload_expires_at=now()+interval '5 minutes', row_version=row_version+1
           WHERE id=$1 AND brand_id=$2 AND scan_state='PENDING' RETURNING *`, [row.id, input.context.brandId],
        );
        return mapMediaRow(renewed.rows[0]);
      }
      return mapMediaRow(row);
    });
  }

  async getForComplete(mediaId: string, context: MediaMutationContext): Promise<MediaAssetRecord> {
    const result = await this.requirePool().query<MediaRow>(
      `SELECT ma.* FROM media.media_assets ma
       WHERE ma.id=$1 AND ma.brand_id=$2 AND EXISTS (
         SELECT 1 FROM access.effective_permissions ep
         JOIN brands.brands b ON b.id=ma.brand_id AND b.onboarding_state='approved'
         WHERE ep.user_id=$3 AND ep.permission_code=$4
           AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=ma.brand_id))
       )`, [mediaId, context.brandId, context.userId, context.permission],
    );
    if (!result.rows[0]) throw notFound();
    return mapMediaRow(result.rows[0]);
  }

  async markRejected(input: {
    asset: MediaAssetRecord; context: MediaMutationContext; reasonCode: string; sha256: string | null; completionRequestSha256: string;
  }): Promise<MediaAssetRecord> {
    return this.transaction(async (client) => {
      const row = await this.lockAsset(client, input.asset.id, input.context);
      if (row.scan_state !== 'PENDING') return this.terminalResult(row, input.context, input.sha256, input.completionRequestSha256);
      const updated = await client.query<MediaRow>(
        `UPDATE media.media_assets SET scan_state='REJECTED', derivative_state='FAILED', rejection_code=$3,
           sha256=COALESCE($4,sha256), completed_at=now(), completion_idempotency_key=$5,
           completion_request_sha256=$6, row_version=row_version+1
         WHERE id=$1 AND brand_id=$2 RETURNING *`,
        [input.asset.id, input.context.brandId, input.reasonCode, input.sha256, input.context.idempotencyKey, input.completionRequestSha256],
      );
      await this.audit(client, updated.rows[0], input.context, 'upload_rejected', input.reasonCode);
      return mapMediaRow(updated.rows[0]);
    });
  }

  async markClean(input: {
    asset: MediaAssetRecord; context: MediaMutationContext; sha256: string; width: number; height: number;
    derivatives: MediaDerivative[]; completionRequestSha256: string;
  }): Promise<MediaAssetRecord> {
    return this.transaction(async (client) => {
      const row = await this.lockAsset(client, input.asset.id, input.context);
      if (row.scan_state !== 'PENDING') return this.terminalResult(row, input.context, input.sha256, input.completionRequestSha256);
      for (const derivative of input.derivatives) await this.insertDerivative(client, input.asset, derivative);
      const updated = await client.query<MediaRow>(
        `UPDATE media.media_assets SET scan_state='CLEAN', derivative_state='READY', sha256=$3,
           width=$4, height=$5, completed_at=now(), completion_idempotency_key=$6,
           completion_request_sha256=$7, row_version=row_version+1
         WHERE id=$1 AND brand_id=$2 RETURNING *`,
        [input.asset.id, input.context.brandId, input.sha256, input.width, input.height,
          input.context.idempotencyKey, input.completionRequestSha256],
      );
      await this.audit(client, updated.rows[0], input.context, 'upload_cleaned', null);
      return mapMediaRow(updated.rows[0]);
    });
  }

  async getStatus(mediaId: string, context: MediaAccessContext): Promise<MediaAssetRecord> {
    const result = await this.requirePool().query<MediaRow>(
      `SELECT ma.* FROM media.media_assets ma
       WHERE ma.id=$1 AND ma.brand_id=$2 AND EXISTS (
         SELECT 1 FROM access.effective_permissions ep
         JOIN brands.brands b ON b.id=ma.brand_id AND b.onboarding_state='approved'
         WHERE ep.user_id=$3 AND ep.permission_code=$4
           AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=ma.brand_id))
       )`, [mediaId, context.brandId, context.userId, context.permission],
    );
    if (!result.rows[0]) throw notFound();
    return mapMediaRow(result.rows[0]);
  }

  private async lockAsset(client: PoolClient, mediaId: string, context: MediaMutationContext): Promise<MediaRow> {
    const result = await client.query<MediaRow>(
      `SELECT ma.* FROM media.media_assets ma
       WHERE ma.id=$1 AND ma.brand_id=$2 AND EXISTS (
         SELECT 1 FROM access.effective_permissions ep
         JOIN brands.brands b ON b.id=ma.brand_id AND b.onboarding_state='approved'
         WHERE ep.user_id=$3 AND ep.permission_code=$4
           AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=ma.brand_id))
       ) FOR UPDATE OF ma`, [mediaId, context.brandId, context.userId, context.permission],
    );
    if (!result.rows[0]) throw notFound();
    return result.rows[0];
  }

  private async terminalResult(row: MediaRow, context: MediaMutationContext, sha256: string | null, requestSha256: string): Promise<MediaAssetRecord> {
    if ((row.completion_idempotency_key === context.idempotencyKey
        && trimHash(row.completion_request_sha256) !== requestSha256)
      || (sha256 !== null && trimHash(row.sha256) !== sha256)) {
      throw new MediaRepositoryError(409, 'MEDIA_IDEMPOTENCY_CONFLICT');
    }
    return mapMediaRow(row);
  }

  private async insertDerivative(client: PoolClient, asset: MediaAssetRecord, derivative: MediaDerivative): Promise<void> {
    const result = await client.query(
      `INSERT INTO media.media_derivatives(brand_id,media_asset_id,derivative_kind,storage_key,sha256,mime_type,byte_length,width,height)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(media_asset_id,derivative_kind) DO NOTHING`,
      [asset.brandId, asset.id, derivative.kind, derivative.key, derivative.sha256, derivative.mimeType,
        derivative.bytes.length, derivative.width, derivative.height],
    );
    if (result.rowCount === 0) {
      const existing = await client.query<{ storage_key: string; sha256: string }>(
        `SELECT storage_key, sha256 FROM media.media_derivatives WHERE media_asset_id=$1 AND derivative_kind=$2`,
        [asset.id, derivative.kind],
      );
      if (existing.rows[0]?.storage_key !== derivative.key || trimHash(existing.rows[0]?.sha256) !== derivative.sha256) {
        throw new MediaRepositoryError(409, 'MEDIA_DERIVATIVE_CONFLICT');
      }
    }
  }

  private async audit(client: PoolClient, row: MediaRow, context: MediaMutationContext,
    event: 'upload_intent_issued' | 'upload_cleaned' | 'upload_rejected', reasonCode: string | null): Promise<void> {
    await client.query(
      `INSERT INTO media.upload_audit_events(brand_id,media_asset_id,actor_user_id,request_id,event_name,scan_state,rights_state,reason_code)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [row.brand_id, row.id, context.userId, context.requestId, event, row.scan_state, row.rights_state, reasonCode],
    );
  }

  private async transaction<T>(run: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.requirePool().connect();
    try {
      await client.query('BEGIN');
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private requirePool(): Pool {
    if (!this.infrastructure.pool) throw new MediaRepositoryError(503, 'MEDIA_DATABASE_UNAVAILABLE');
    return this.infrastructure.pool;
  }
}

function mapMediaRow(row: MediaRow): MediaAssetRecord {
  return {
    id: row.id, brandId: row.brand_id, storageKey: row.storage_key, uploadKey: row.upload_key,
    mimeType: row.mime_type, fileName: row.file_name, byteLength: Number(row.byte_length),
    expectedSha256: trimHash(row.expected_sha256), scanState: row.scan_state, rightsState: row.rights_state,
    derivativeState: row.derivative_state, uploadExpiresAt: new Date(row.upload_expires_at).toISOString(),
    sha256: trimHash(row.sha256), width: row.width, height: row.height, rejectionCode: row.rejection_code,
    completionIdempotencyKey: row.completion_idempotency_key,
    completionRequestSha256: trimHash(row.completion_request_sha256), rowVersion: Number(row.row_version),
  };
}

function trimHash(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

function notFound(): MediaRepositoryError {
  return new MediaRepositoryError(404, 'MEDIA_NOT_FOUND');
}
