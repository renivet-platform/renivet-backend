import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';
import { ProductMediaPostgresRepository } from './product-media.repository';
import { AttachProductMediaDto } from './product-media.dto';
import { ProductMediaMutationContext } from './product-media.service';
import { MediaZipImage } from './media-zip-ingestion';

export interface MediaZipBatchRecord {
  id: string; brandId: string; createdBy: string; fileUploadId: string | null; sourceKind: 'MEDIA_ZIP' | 'REMOTE_URL'; state: string; mappingManifestId: string;
  rightsAttestedBy: string; storageKey: string; byteLength: number; sha256: string;
  manifest: Readonly<Record<string, { productId: string; variantId: string }>>;
  remoteImages: ReadonlyArray<{ sku: string; slot: number; url: string; sourceUrlSha256: string }>;
}

@Injectable()
export class MediaZipPostgresRepository {
  constructor(private readonly infrastructure: IdentityInfrastructure,
    private readonly productMedia: ProductMediaPostgresRepository) {}

  async loadBatch(batchId: string, transaction: PoolClient): Promise<MediaZipBatchRecord | null> {
    const batch = await transaction.query<{
      id: string; brand_id: string; created_by: string; file_upload_id: string; mapping_manifest_id: string; rights_attested_by: string;
      storage_key: string | null; byte_length: number | null; source_sha256: string | null; source_kind: 'MEDIA_ZIP' | 'REMOTE_URL'; state: string;
    }>(`SELECT b.id,b.brand_id,b.created_by,b.file_upload_id,b.source_kind,b.mapping_manifest_id,m.created_by AS rights_attested_by,u.storage_key,u.byte_length,u.source_sha256
       FROM media.zip_import_batches b LEFT JOIN imports.import_uploads u ON u.id=b.file_upload_id AND u.brand_id=b.brand_id
       JOIN media.zip_mapping_manifests m ON m.id=b.mapping_manifest_id AND m.brand_id=b.brand_id
       WHERE b.id=$1`, [batchId]);
    if (!batch.rows[0]) return null;
    const row = batch.rows[0];
    const mappings = await transaction.query<{ sku: string; product_id: string; variant_id: string }>(
      `SELECT sku,product_id,variant_id FROM media.zip_mapping_manifest_items
       WHERE manifest_id=$1 AND brand_id=$2 ORDER BY sku_norm`, [row.mapping_manifest_id, row.brand_id]);
    const remoteImages = row.source_kind === 'REMOTE_URL' ? await transaction.query<{ sku: string; slot: number; source_url: string; source_url_sha256: string }>(
      `SELECT sku,slot,source_url,source_url_sha256 FROM media.zip_import_remote_items
       WHERE batch_id=$1 AND brand_id=$2 ORDER BY sku_norm,slot`, [row.id, row.brand_id]) : { rows: [] };
    return { id: row.id, brandId: row.brand_id, createdBy: row.created_by, fileUploadId: row.file_upload_id, sourceKind: row.source_kind, state: row.state,
      mappingManifestId: row.mapping_manifest_id, rightsAttestedBy: row.rights_attested_by, storageKey: row.storage_key ?? '', byteLength: Number(row.byte_length ?? 0),
      sha256: row.source_sha256?.trim() ?? '', manifest: Object.fromEntries(mappings.rows.map((item) => [item.sku.toUpperCase(),
        { productId: item.product_id, variantId: item.variant_id }])), remoteImages: remoteImages.rows.map((item) => ({
        sku: item.sku, slot: Number(item.slot), url: item.source_url, sourceUrlSha256: item.source_url_sha256.trim(),
      })) };
  }

  async resolveProducts(brandId: string, mappings: Readonly<Record<string, { productId: string; variantId: string }>>):
  Promise<Readonly<Record<string, { brandId: string; productId: string; variantId: string; sku: string }>>> {
    const pool = this.requirePool();
    const entries = Object.entries(mappings);
    if (entries.length === 0) return {};
    const result = await pool.query<{ brand_id: string; product_id: string; variant_id: string; sku: string; sku_norm: string }>(
      `SELECT v.brand_id,v.product_id,v.id AS variant_id,v.sku,v.sku_norm
       FROM catalogue.product_variants v JOIN catalogue.products p ON p.id=v.product_id AND p.brand_id=v.brand_id
       WHERE v.brand_id=$1 AND v.id=ANY($2::uuid[]) AND v.variant_state <> 'ARCHIVED'`,
      [brandId, entries.map(([, item]) => item.variantId)]);
    return Object.fromEntries(result.rows.map((row) => [row.sku_norm, { brandId: row.brand_id,
      productId: row.product_id, variantId: row.variant_id, sku: row.sku }]));
  }

  async attachEffect(image: MediaZipImage, mediaAssetId: string, context: ProductMediaMutationContext): Promise<void> {
    const client = await this.requirePool().connect();
    try {
      await client.query('BEGIN');
      const batch = await client.query<{ created_by: string; brand_id: string; mapping_manifest_id: string }>(
        'SELECT created_by,brand_id,mapping_manifest_id FROM media.zip_import_batches WHERE id=$1 AND brand_id=$2 FOR UPDATE',
        [image.batchId, image.brandId]);
      if (!batch.rows[0] || batch.rows[0].created_by !== context.userId) throw new Error('MEDIA_ZIP_BATCH_NOT_FOUND');
      const manifestItem = await client.query(`SELECT 1 FROM media.zip_mapping_manifest_items
        WHERE manifest_id=$1 AND brand_id=$2 AND sku_norm=$3 AND product_id=$4 AND variant_id=$5 FOR SHARE`,
      [batch.rows[0].mapping_manifest_id, image.brandId, image.sku.toUpperCase(), image.productId, image.variantId]);
      if (!manifestItem.rowCount) throw new Error('MEDIA_ZIP_MAPPING_CHANGED');
      const existing = await client.query<{ id: string; state: string; media_asset_id: string | null; effect_key: string; source_sha256: string; source_path: string }>(
        `SELECT id,state,media_asset_id,effect_key,source_sha256,source_path FROM media.zip_import_effects WHERE batch_id=$1 AND variant_id=$2 AND slot=$3 FOR UPDATE`,
        [image.batchId, image.variantId, image.slot]);
      if (existing.rows[0] && (existing.rows[0].effect_key.trim() !== image.effectKey
        || existing.rows[0].source_sha256.trim() !== (image.sourceSha256 ?? image.sha256) || existing.rows[0].source_path !== image.archivePath)) {
        throw new Error('MEDIA_ZIP_EFFECT_CONFLICT');
      }
      if (existing.rows[0]?.state === 'SUCCEEDED') {
        if (existing.rows[0].media_asset_id !== mediaAssetId) throw new Error('MEDIA_ZIP_EFFECT_CONFLICT');
        await client.query('COMMIT'); return;
      }
      const effectId = existing.rows[0]?.id ?? image.effectKey.slice(0,8)+'-'+image.effectKey.slice(8,12)+'-5'+image.effectKey.slice(13,16)+'-8'+image.effectKey.slice(17,20)+'-'+image.effectKey.slice(20,32);
      if (existing.rows[0]) await client.query(`UPDATE media.zip_import_effects SET state='PENDING',error_code=NULL,completed_at=NULL,media_asset_id=NULL
        WHERE id=$1`, [effectId]);
      else await client.query(`INSERT INTO media.zip_import_effects(id,batch_id,brand_id,product_id,variant_id,sku,slot,source_path,source_sha256,effect_key,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING')`,
      [effectId, image.batchId, image.brandId, image.productId, image.variantId, image.sku, image.slot, image.archivePath, image.sourceSha256 ?? image.sha256, image.effectKey]);
      const input: Omit<AttachProductMediaDto, 'displayOrder'> = { mediaAssetId, variantId: image.variantId, displayRole: 'GALLERY',
        altText: `${image.sku} image ${String(image.slot).padStart(2,'0')}` };
      await this.productMedia.attachImportedInTransaction(image.productId, input, context, client);
      await client.query(`UPDATE media.zip_import_effects SET state='SUCCEEDED',media_asset_id=$2,error_code=NULL,completed_at=now()
        WHERE id=$1`, [effectId, mediaAssetId]);
      await client.query(`INSERT INTO media.zip_import_audit_events(brand_id,batch_id,manifest_id,effect_id,actor_user_id,request_id,event_name,payload_sha256)
        VALUES($1,$2,$3,$4,$5,$6,'image_attached',$7) ON CONFLICT(effect_id,event_name,payload_sha256) DO NOTHING`, [image.brandId, image.batchId, batch.rows[0].mapping_manifest_id,
        effectId, context.userId, context.requestId, image.sha256]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async recordRejectedEffect(image: MediaZipImage, code: string, context: ProductMediaMutationContext): Promise<void> {
    const client = await this.requirePool().connect();
    try {
      await client.query('BEGIN');
      const effectId = image.effectKey.slice(0,8)+'-'+image.effectKey.slice(8,12)+'-5'+image.effectKey.slice(13,16)+'-8'+image.effectKey.slice(17,20)+'-'+image.effectKey.slice(20,32);
      const existing = await client.query<{ state: string; effect_key: string; source_sha256: string }>(
        'SELECT state,effect_key,source_sha256 FROM media.zip_import_effects WHERE batch_id=$1 AND variant_id=$2 AND slot=$3 FOR UPDATE',
        [image.batchId, image.variantId, image.slot]);
      if (existing.rows[0]?.state === 'SUCCEEDED') { await client.query('COMMIT'); return; }
      if (existing.rows[0] && (existing.rows[0].effect_key.trim() !== image.effectKey
        || existing.rows[0].source_sha256.trim() !== (image.sourceSha256 ?? image.sha256))) {
        throw new Error('MEDIA_ZIP_EFFECT_CONFLICT');
      }
      await client.query(`INSERT INTO media.zip_import_effects(id,batch_id,brand_id,product_id,variant_id,sku,slot,source_path,source_sha256,effect_key,state,error_code,completed_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'FAILED',$11,now()) ON CONFLICT(batch_id,variant_id,slot)
        DO UPDATE SET state='FAILED',error_code=EXCLUDED.error_code,completed_at=now() WHERE media.zip_import_effects.state <> 'SUCCEEDED'
          AND media.zip_import_effects.effect_key=EXCLUDED.effect_key AND media.zip_import_effects.source_sha256=EXCLUDED.source_sha256`,
      [effectId, image.batchId, image.brandId, image.productId, image.variantId, image.sku, image.slot, image.archivePath,
        image.sourceSha256 ?? image.sha256, image.effectKey, code]);
      const batch = await client.query<{ mapping_manifest_id: string }>('SELECT mapping_manifest_id FROM media.zip_import_batches WHERE id=$1 AND brand_id=$2',
        [image.batchId, image.brandId]);
      if (batch.rows[0]) await client.query(`INSERT INTO media.zip_import_audit_events(brand_id,batch_id,manifest_id,effect_id,actor_user_id,request_id,event_name,payload_sha256)
        VALUES($1,$2,$3,$4,$5,$6,'image_rejected',$7) ON CONFLICT(effect_id,event_name,payload_sha256) DO NOTHING`, [image.brandId, image.batchId, batch.rows[0].mapping_manifest_id, effectId,
        context.userId, context.requestId, image.sha256]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  async finishBatch(batchId: string, transaction: PoolClient): Promise<void> {
    await transaction.query(`UPDATE media.zip_import_batches b SET state=CASE
      WHEN EXISTS(SELECT 1 FROM media.zip_import_effects e WHERE e.batch_id=b.id AND e.state='FAILED') THEN 'PARTIAL' ELSE 'SUCCEEDED' END,
      completed_at=now(),failure_code=NULL,row_version=row_version+1 WHERE b.id=$1 AND b.state IN ('QUEUED','PROCESSING')`, [batchId]);
  }

  async markProcessing(batchId: string): Promise<void> {
    await this.requirePool().query(`UPDATE media.zip_import_batches SET state='PROCESSING',failure_code=NULL,row_version=row_version+1
      WHERE id=$1 AND state IN ('QUEUED','PROCESSING') AND completed_at IS NULL`, [batchId]);
  }

  async returnToQueue(batchId: string): Promise<void> {
    await this.requirePool().query(`UPDATE media.zip_import_batches SET state='QUEUED',row_version=row_version+1
      WHERE id=$1 AND state='PROCESSING' AND completed_at IS NULL`, [batchId]);
  }

  async markFailed(batchId: string, code: string): Promise<void> {
    const safeCode = /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'MEDIA_IMPORT_FAILED';
    const client = await this.requirePool().connect();
    try {
      await client.query('BEGIN');
      const batch = await client.query<{ brand_id: string; mapping_manifest_id: string; created_by: string }>(
        `UPDATE media.zip_import_batches b SET state=CASE
           WHEN EXISTS(SELECT 1 FROM media.zip_import_effects e WHERE e.batch_id=b.id AND e.state='SUCCEEDED') THEN 'PARTIAL'
           ELSE 'FAILED' END,
         failure_code=$2,completed_at=now(),row_version=row_version+1
         WHERE b.id=$1 AND b.state IN ('QUEUED','PROCESSING') AND b.completed_at IS NULL
         RETURNING brand_id,mapping_manifest_id,created_by`, [batchId, safeCode]);
      if (batch.rows[0]) {
        const payloadHash = createHash('sha256').update(safeCode).digest('hex');
        await client.query(`INSERT INTO media.zip_import_audit_events(brand_id,batch_id,manifest_id,actor_user_id,request_id,event_name,payload_sha256)
          VALUES($1,$2,$3,$4,$5,'batch_failed',$6) ON CONFLICT DO NOTHING`, [batch.rows[0].brand_id, batchId,
          batch.rows[0].mapping_manifest_id, batch.rows[0].created_by, `media-zip:${batchId}`, payloadHash]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }

  private requirePool(): Pool {
    if (!this.infrastructure.pool) throw Object.assign(new Error('MEDIA_DATABASE_UNAVAILABLE'), { code: 'MEDIA_DATABASE_UNAVAILABLE' });
    return this.infrastructure.pool;
  }
}
