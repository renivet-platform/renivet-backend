import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { ProductDraftPostgresRepository } from '../catalog/product-draft.repository';
import { normalizeProductCreate, normalizeProductPatch, ProductMutationContext } from '../catalog/product-draft.service';
import { AttachProductMediaDto } from '../media/product-media.dto';
import { ProductMediaPostgresRepository } from '../media/product-media.repository';
import { ProductMediaMutationContext } from '../media/product-media.service';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';
import { deriveImportEffectKey, ImportEffectKind } from './import-effect-keys';

export type ConfirmInput = { brandId: string; batchId: string; actorUserId: string; idempotencyKey: string;
  previewRevision: number; previewHash: string; allowPartial: boolean; requestId: string };
type TargetVersion = { sourceRowNumber: number; productId: string; variantId: string | null;
  productRowVersion: number; variantRowVersion: number; contentVersion: number };
type PreviewRow = { sourceRowNumber: number; action: string; proposed: Record<string, unknown>;
  fieldMask: string[]; targetVersion: Omit<TargetVersion, 'sourceRowNumber'> | null; conflicts: Array<{ code: string }> };

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function digest(value: unknown): string { return createHash('sha256').update(stable(value)).digest('hex'); }
function asRecord(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function apiError(error: unknown): { code: string } {
  const value = error as { code?: string; status?: number };
  return { code: typeof value?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.code) ? value.code : 'IMPORT_EFFECT_FAILED' };
}

@Injectable()
export class ImportConfirmationService {
  constructor(private readonly infrastructure: IdentityInfrastructure,
    private readonly products: ProductDraftPostgresRepository,
    private readonly productMedia: ProductMediaPostgresRepository) {}

  async confirm(input: ConfirmInput): Promise<Record<string, unknown>> {
    const pool = this.infrastructure.pool;
    if (!pool) throw new ServiceUnavailableException({ code: 'IMPORT_DATABASE_UNAVAILABLE', message: 'Import storage is unavailable.' });
    const client = await pool.connect();
    const requestHash = digest({ brandId: input.brandId, batchId: input.batchId, previewRevision: input.previewRevision,
      previewHash: input.previewHash, allowPartial: input.allowPartial });
    try {
      await client.query('BEGIN');
      const batchResult = await client.query(`SELECT b.id,b.brand_id,b.source_sha256,b.preview_revision,b.preview_hash,b.job_state
        FROM imports.import_batches b WHERE b.id=$1 AND b.brand_id=$2
          AND EXISTS (SELECT 1 FROM access.effective_permissions p WHERE p.user_id=$3 AND p.permission_code='imports.confirm'
            AND ((p.scope_type='global' AND p.brand_id IS NULL) OR (p.scope_type='brand' AND p.brand_id=$2)))
        FOR UPDATE OF b`, [input.batchId, input.brandId, input.actorUserId]);
      const batch = batchResult.rows[0];
      if (!batch) throw new NotFoundException({ code: 'IMPORT_BATCH_NOT_FOUND', message: 'The import batch is not available.' });

      const prior = await client.query(`SELECT id,request_hash,response_payload FROM imports.import_confirmations
        WHERE brand_id=$1 AND idempotency_key=$2`, [input.brandId, input.idempotencyKey]);
      if (prior.rows[0]) {
        if (String(prior.rows[0].request_hash).trim() !== requestHash) throw new ConflictException({ code: 'IMPORT_IDEMPOTENCY_CONFLICT', message: 'The idempotency key was used with different confirmation data.' });
        await client.query('COMMIT');
        return prior.rows[0].response_payload;
      }
      if (Number(batch.preview_revision) !== input.previewRevision || String(batch.preview_hash ?? '').trim() !== input.previewHash) {
        throw new ConflictException({ code: 'PREVIEW_STALE', message: 'The import preview changed. Generate a fresh preview before confirming.' });
      }
      if (!['PREVIEWED', 'PARTIAL', 'FAILED'].includes(String(batch.job_state))) {
        throw new ConflictException({ code: 'IMPORT_BATCH_STATE_CONFLICT', message: 'The import batch cannot be confirmed in its current state.' });
      }

      const previewResult = await client.query(`SELECT p.preview_snapshot,p.source_sha256,p.mapping_version,p.taxonomy_snapshot_sha256
        FROM imports.import_previews p WHERE p.batch_id=$1 AND p.brand_id=$2 AND p.preview_revision=$3 AND p.preview_hash=$4
        FOR SHARE`, [input.batchId, input.brandId, input.previewRevision, input.previewHash]);
      const previewRow = previewResult.rows[0];
      if (!previewRow) throw new ConflictException({ code: 'PREVIEW_STALE', message: 'The frozen preview is no longer available.' });
      const snapshot = asRecord(previewRow.preview_snapshot);
      const rows = Array.isArray(snapshot.rows) ? snapshot.rows as PreviewRow[] : [];
      if (String(previewRow.source_sha256).trim() !== String(batch.source_sha256).trim()
        || Number(snapshot.mappingVersion) !== Number(previewRow.mapping_version)
        || String(snapshot.taxonomySnapshotSha256) !== String(previewRow.taxonomy_snapshot_sha256).trim()) {
        throw new ConflictException({ code: 'PREVIEW_STALE', message: 'The preview identity does not match its frozen import inputs.' });
      }

      await this.assertMappingAndTaxonomyCurrent(client, input, Number(previewRow.mapping_version), String(previewRow.taxonomy_snapshot_sha256).trim());
      await this.assertTargetsCurrent(client, input.brandId, Array.isArray(snapshot.targetVersions) ? snapshot.targetVersions as TargetVersion[] : []);

      const blockedRows = rows.filter((row) => !['CREATE', 'UPDATE', 'NOOP'].includes(row.action));
      if (blockedRows.length && !input.allowPartial) {
        throw new UnprocessableEntityException({ code: 'IMPORT_PREVIEW_HAS_BLOCKED_ROWS', message: 'Resolve preview conflicts and create a new preview before confirming all rows.' });
      }

      const confirmationId = randomUUID();
      const applied: Array<Record<string, unknown>> = [];
      const failed: Array<Record<string, unknown>> = blockedRows.map((row) => ({ sourceRowNumber: row.sourceRowNumber, code: row.conflicts?.[0]?.code ?? 'IMPORT_ROW_BLOCKED' }));
      const importRows = await client.query(`SELECT id,source_row_number FROM imports.import_rows WHERE batch_id=$1 AND brand_id=$2 ORDER BY source_row_number FOR UPDATE`, [input.batchId, input.brandId]);
      const rowIds = new Map<number, string>(importRows.rows.map((row: { id: string; source_row_number: number }) => [Number(row.source_row_number), row.id]));
      let noopRows = 0;
      for (const row of rows.filter((candidate) => candidate.action === 'NOOP' || blockedRows.includes(candidate))) {
        const rowId = rowIds.get(Number(row.sourceRowNumber));
        if (!rowId) throw new ConflictException({ code: 'PREVIEW_STALE', message: 'A staged source row is missing. Generate a fresh preview.' });
        if (row.action === 'NOOP') {
          noopRows += 1;
          await client.query(`UPDATE imports.import_rows SET row_state='NOOP',target_product_id=$3,target_variant_id=$4,result_receipt=$5::jsonb
            WHERE id=$1 AND batch_id=$2 AND brand_id=$6`, [rowId, input.batchId, row.targetVersion?.productId ?? null,
            row.targetVersion?.variantId ?? null, JSON.stringify({ status: 'NOOP' }), input.brandId]);
        } else {
          await client.query(`UPDATE imports.import_rows SET row_state='FAILED',result_receipt=$3::jsonb WHERE id=$1 AND batch_id=$2 AND brand_id=$4`,
            [rowId, input.batchId, JSON.stringify({ status: 'FAILED', code: row.conflicts?.[0]?.code ?? 'IMPORT_ROW_BLOCKED' }), input.brandId]);
        }
      }

      for (const row of rows) {
        if (row.action === 'NOOP' || blockedRows.includes(row)) continue;
        const rowId = rowIds.get(Number(row.sourceRowNumber));
        if (!rowId) throw new ConflictException({ code: 'PREVIEW_STALE', message: 'A staged source row is missing. Generate a fresh preview.' });
        await client.query('SAVEPOINT import_row_effect');
        try {
          const outcome = await this.applyRow(client, input, rowId, row);
          const rowState = outcome.failures.length ? 'PARTIAL' : 'APPLIED';
          await client.query(`UPDATE imports.import_rows SET row_state=$7,target_product_id=$3,target_variant_id=$4,result_receipt=$5::jsonb
            WHERE id=$1 AND batch_id=$2 AND brand_id=$6`, [rowId, input.batchId, outcome.productId ?? null, outcome.variantId ?? null,
            JSON.stringify({ effectCount: outcome.effectCount, failedEffectCount: outcome.failures.length, failures: outcome.failures, status: rowState }), input.brandId, rowState]);
          await client.query('RELEASE SAVEPOINT import_row_effect');
          applied.push({ sourceRowNumber: row.sourceRowNumber, effectCount: outcome.effectCount, productId: outcome.productId ?? null });
          failed.push(...outcome.failures.map((failure) => ({ sourceRowNumber: row.sourceRowNumber, ...failure })));
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT import_row_effect');
          await client.query('RELEASE SAVEPOINT import_row_effect');
          if (!input.allowPartial) throw new UnprocessableEntityException({ code: apiError(error).code, message: 'An import row could not be applied; no confirmation effects were saved.' });
          const code = apiError(error).code;
          failed.push({ sourceRowNumber: row.sourceRowNumber, code });
          await client.query(`UPDATE imports.import_rows SET row_state='FAILED',result_receipt=$3::jsonb WHERE id=$1 AND batch_id=$2 AND brand_id=$4`,
            [rowId, input.batchId, JSON.stringify({ status: 'FAILED', code }), input.brandId]);
        }
      }

      const state = failed.length ? 'PARTIAL' : 'COMPLETED';
      const response = { confirmationId, batchId: input.batchId, previewRevision: input.previewRevision,
        previewHash: input.previewHash, state, appliedRows: applied.length,
        failedRows: new Set(failed.map((row) => row.sourceRowNumber)).size,
        noopRows, effectsApplied: applied.reduce((total, row) => total + Number(row.effectCount), 0), applied, failed };
      await client.query(`UPDATE imports.import_batches SET job_state=$3,updated_at=now() WHERE id=$1 AND brand_id=$2`, [input.batchId, input.brandId, state]);
      await client.query(`INSERT INTO imports.import_confirmations
        (id,brand_id,batch_id,preview_revision,preview_hash,idempotency_key,request_hash,confirmation_state,confirmed_by,response_payload)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`, [confirmationId, input.brandId, input.batchId, input.previewRevision,
        input.previewHash, input.idempotencyKey, requestHash, state, input.actorUserId, JSON.stringify(response)]);
      await client.query(`INSERT INTO access.security_audit_events(actor_user_id,action,subject_type,subject_id,request_id,payload_hash)
        VALUES($1,'imports.confirmed','imports.batch',$2,$3,$4)`, [input.actorUserId, input.batchId, input.requestId, digest({ requestHash, state, appliedRows: applied.length, failedRows: failed.length })]);
      await client.query('COMMIT');
      return response;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof ConflictException || error instanceof NotFoundException || error instanceof UnprocessableEntityException) throw error;
      const code = (error as { code?: string } | null)?.code;
      if (code === '23505') throw new ConflictException({ code: 'IMPORT_IDEMPOTENCY_CONFLICT', message: 'This import preview has already been confirmed.' });
      if (code === '40001' || code === '40P01') throw new ConflictException({ code: 'PREVIEW_STALE', message: 'The import changed while confirmation was in progress. Generate a fresh preview and retry.' });
      if (code?.startsWith('08') || ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','57P01'].includes(code ?? '')) {
        throw new ServiceUnavailableException({ code: 'IMPORT_DATABASE_UNAVAILABLE', message: 'Import storage is unavailable.' });
      }
      throw error;
    } finally { client.release(); }
  }

  private async assertMappingAndTaxonomyCurrent(client: PoolClient, input: ConfirmInput, version: number, taxonomyHash: string): Promise<void> {
    const mapping = await client.query(`SELECT max(version)::integer AS version FROM imports.import_mapping_profiles WHERE batch_id=$1 AND brand_id=$2`, [input.batchId, input.brandId]);
    if (Number(mapping.rows[0]?.version) !== version) throw new ConflictException({ code: 'PREVIEW_STALE', message: 'The mapping changed after preview. Generate a fresh preview.' });
    const taxonomy = await client.query(`SELECT c.id AS category_id,c.code,c.active,c.schema_version,v.id AS schema_version_id,v.validator_version,
        COALESCE(v.ruleset_sha256,repeat('0',64)) AS ruleset_sha256,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'attributeId',r.attribute_id,'code',r.attribute_code,'scope',r.scope_type,
          'valueType',r.value_type,'allowedValues',r.allowed_values,'unitCode',r.unit_code,'requiredByDefault',r.required_by_default,
          'conditionalAst',r.conditional_ast,'minValues',r.min_values,'maxValues',r.max_values) ORDER BY r.attribute_code,r.scope_type)
          FROM catalogue.category_schema_attribute_rules r WHERE r.schema_version_id=v.id), '[]'::jsonb) AS attribute_rules
      FROM catalogue.categories c LEFT JOIN catalogue.category_schema_versions v ON v.category_id=c.id AND v.version=c.schema_version
      WHERE NOT EXISTS (SELECT 1 FROM catalogue.categories child WHERE child.parent_id=c.id) ORDER BY c.code FOR SHARE OF c`);
    const snapshot = taxonomy.rows.map((row: Record<string, unknown>) => ({ categoryId: String(row.category_id), code: String(row.code), active: Boolean(row.active),
      version: Number(row.schema_version ?? 0), schemaVersionId: row.schema_version_id ? String(row.schema_version_id) : null,
      validatorVersion: row.validator_version ? String(row.validator_version) : null, schemaSha256: String(row.ruleset_sha256).trim(),
      attributes: Array.isArray(row.attribute_rules) ? row.attribute_rules : [] }));
    if (digest(snapshot) !== taxonomyHash) throw new ConflictException({ code: 'PREVIEW_STALE', message: 'The category rules changed after preview. Generate a fresh preview.' });
  }

  private async assertTargetsCurrent(client: PoolClient, brandId: string, targets: TargetVersion[]): Promise<void> {
    if (!targets.length) return;
    const productIds = [...new Set(targets.map((target) => target.productId))];
    const current = await client.query(`SELECT p.id AS product_id,p.row_version AS product_row_version,p.content_version,
        v.id AS variant_id,v.row_version AS variant_row_version
      FROM catalogue.products p JOIN catalogue.product_variants v ON v.product_id=p.id AND v.brand_id=p.brand_id
      WHERE p.brand_id=$1 AND p.id=ANY($2::uuid[]) ORDER BY p.id,v.id FOR UPDATE OF p,v`, [brandId, productIds]);
    const versions = new Map<string, { productRowVersion: number; variantRowVersion: number; contentVersion: number }>();
    for (const row of current.rows as Array<Record<string, unknown>>) versions.set(`${row.product_id}:${row.variant_id}`, {
      productRowVersion: Number(row.product_row_version), variantRowVersion: Number(row.variant_row_version), contentVersion: Number(row.content_version) });
    for (const target of targets) {
      const value = versions.get(`${target.productId}:${target.variantId}`);
      if (!value || value.productRowVersion !== Number(target.productRowVersion) || value.variantRowVersion !== Number(target.variantRowVersion)
        || value.contentVersion !== Number(target.contentVersion)) {
        throw new ConflictException({ code: 'PREVIEW_STALE', message: 'A target product changed after preview. No rows were applied; generate a fresh preview.' });
      }
    }
  }

  async applyRetryRow(client: PoolClient, input: ConfirmInput, rowId: string, row: PreviewRow): Promise<{
    effectCount: number; productId: string | null; variantId: string | null; failures: Array<{ target: string; code: string }>;
  }> {
    const prior = await client.query(`SELECT effect_kind,logical_target_key,target_product_id,target_variant_id FROM imports.import_effect_receipts
      WHERE batch_id=$1 AND brand_id=$2 AND row_id=$3 ORDER BY effect_kind,logical_target_key`, [input.batchId,input.brandId,rowId]);
    if (!prior.rowCount) return this.applyRow(client, input, rowId, row);
    const productId = prior.rows.find((effect: Record<string, unknown>) => effect.target_product_id)?.target_product_id as string | undefined;
    if (!productId) throw new ConflictException({ code: 'IMPORT_EFFECT_RECEIPT_INVALID', message: 'The saved import effects cannot be reconciled.' });
    const proposed = asRecord(row.proposed);
    const variants = Array.isArray(proposed.variants) ? proposed.variants as Array<Record<string, unknown>> : [{ sku: proposed.sku, options: asRecord(proposed.options) }];
    const variantBySku = new Map<string,string>();
    for (const effect of prior.rows as Array<Record<string, unknown>>) {
      if (String(effect.effect_kind) === 'VARIANT_UPSERT' && String(effect.logical_target_key).startsWith('sku:') && effect.target_variant_id) {
        variantBySku.set(String(effect.logical_target_key).slice(4), String(effect.target_variant_id));
      }
    }
    const media = Array.isArray(proposed.mediaAssets) ? proposed.mediaAssets as Array<Record<string, unknown>> : [];
    const failures: Array<{target: string;code: string}> = [];
    let effectCount = 0;
    for (let index = 0; index < media.length; index += 1) {
      const asset = media[index];
      const logicalKey = `media:${String(asset.mediaAssetId)}:${index}`;
      const existing = prior.rows.some((effect: Record<string, unknown>) => String(effect.effect_kind) === 'MEDIA_LINK' && String(effect.logical_target_key) === logicalKey);
      if (existing) continue;
      const variantIndex = asset.variantSku ? variants.findIndex((variant) => variant.sku === asset.variantSku) : -1;
      if (asset.variantSku && variantIndex < 0) { failures.push({target:`media-${index + 1}`,code:'IMPORT_MEDIA_VARIANT_NOT_FOUND'}); continue; }
      const sku = variantIndex < 0 ? null : String(variants[variantIndex].sku).normalize('NFC').trim().toUpperCase();
      const attach: AttachProductMediaDto = { mediaAssetId: String(asset.mediaAssetId), variantId: sku ? variantBySku.get(sku) ?? null : null,
        displayRole: String(asset.displayRole ?? 'GALLERY'), displayOrder: Number(asset.displayOrder ?? index), altText: String(asset.altText ?? '') };
      if (sku && !attach.variantId) { failures.push({target:`media-${index + 1}`,code:'IMPORT_MEDIA_VARIANT_NOT_FOUND'}); continue; }
      const mediaContext: ProductMediaMutationContext = { brandId: input.brandId, userId: input.actorUserId, permission: 'catalog.write',
        requestId: input.requestId, idempotencyKey: `imp:${input.batchId}:${rowId}:media:${index}` };
      await client.query('SAVEPOINT import_retry_media_effect');
      try {
        await this.productMedia.attachInTransaction(productId, attach, mediaContext, client);
        await this.insertEffect(client,input,row.sourceRowNumber,rowId,'MEDIA_LINK',logicalKey,{mediaAssetId:attach.mediaAssetId,productId,
          variantId:attach.variantId,displayRole:attach.displayRole,displayOrder:attach.displayOrder,altText:attach.altText ?? ''},productId,attach.variantId ?? null,String(asset.mediaAssetId),'APPLIED');
        await client.query('RELEASE SAVEPOINT import_retry_media_effect');
        effectCount += 1;
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT import_retry_media_effect');
        await client.query('RELEASE SAVEPOINT import_retry_media_effect');
        failures.push({target:`media-${index + 1}`,code:apiError(error).code});
      }
    }
    return { effectCount, productId, variantId: String(prior.rows.find((effect: Record<string,unknown>) => effect.target_variant_id)?.target_variant_id ?? row.targetVersion?.variantId ?? '') || null, failures };
  }

  private async applyRow(client: PoolClient, input: ConfirmInput, rowId: string, row: PreviewRow): Promise<{
    effectCount: number; productId: string | null; variantId: string | null; failures: Array<{ target: string; code: string }>;
  }> {
    const proposed = asRecord(row.proposed);
    const rowKey = `${input.batchId}:${rowId}`;
    const productContext: ProductMutationContext = { brandId: input.brandId, userId: input.actorUserId,
      permission: 'catalog.write', requestId: input.requestId, idempotencyKey: `imp:${rowKey}:product`, sourceKind: 'IMPORT', sourceReference: input.batchId };
    let productId: string;
    let variantIds: string[] = [];
    let updatePayload: Record<string, unknown> | null = null;
    if (row.action === 'CREATE') {
      const category = await client.query(`SELECT c.schema_version FROM catalogue.categories c WHERE c.code=$1 AND c.active=true`, [String(proposed.categoryCode)]);
      if (!category.rows[0]) throw new UnprocessableEntityException({ code: 'PRODUCT_CATEGORY_INVALID', message: 'The mapped category is no longer available.' });
      const variants = Array.isArray(proposed.variants) ? proposed.variants as Array<Record<string, unknown>> : [{ sku: proposed.sku, options: asRecord(proposed.options) }];
      const normalized = normalizeProductCreate({ styleCode: proposed.styleCode, categoryCode: proposed.categoryCode,
        categorySchemaVersion: Number(category.rows[0].schema_version), title: proposed.title, description: proposed.description ?? '',
        attributes: proposed.attributes ?? {}, variants });
      const created = await this.products.createInTransaction(normalized, productContext, client);
      productId = String(created.productId);
      variantIds = Array.isArray(created.variantIds) ? created.variantIds.map(String) : [];
      if (variantIds.length !== variants.length || !variantIds.length) throw new UnprocessableEntityException({ code: 'IMPORT_VARIANT_RECEIPT_MISMATCH', message: 'The created variants could not be reconciled.' });
    } else {
      if (!row.targetVersion?.productId) throw new ConflictException({ code: 'PREVIEW_STALE', message: 'The update target is missing from the frozen preview.' });
      productId = row.targetVersion.productId;
      const patch: Record<string, unknown> = {};
      const attrs: Record<string, unknown> = {};
      for (const field of row.fieldMask ?? []) {
        if (field === 'title' || field === 'description') patch[field] = proposed[field];
        else if (field.startsWith('attributes.')) attrs[field.slice('attributes.'.length)] = asRecord(proposed.attributes)[field.slice('attributes.'.length)];
      }
      if (Object.keys(attrs).length) patch.attributes = attrs;
      if (!Object.keys(patch).length) throw new UnprocessableEntityException({ code: 'IMPORT_UPDATE_FIELDS_EMPTY', message: 'The update preview has no supported product fields.' });
      updatePayload = { productId, expectedRowVersion: row.targetVersion.productRowVersion, patch };
      await this.products.updateInTransaction(productId, normalizeProductPatch(patch), Number(row.targetVersion.productRowVersion), productContext, client);
    }

    let effectCount = 0;
    const failures: Array<{ target: string; code: string }> = [];
    if (row.action === 'CREATE') {
      const variants = Array.isArray(proposed.variants) ? proposed.variants as Array<Record<string, unknown>> : [{ sku: proposed.sku, options: asRecord(proposed.options) }];
      for (let index = 0; index < variantIds.length; index += 1) {
        const variant = variants[index];
        await this.insertEffect(client, input, row.sourceRowNumber, rowId, 'VARIANT_UPSERT', `sku:${String(variant.sku).normalize('NFC').trim().toUpperCase()}`,
          { productId, variantId: variantIds[index], ...variant }, productId, variantIds[index], null, 'APPLIED');
        effectCount += 1;
      }
    } else {
      await this.insertEffect(client, input, row.sourceRowNumber, rowId, 'PRODUCT_UPDATE', `product:${productId}`,
        updatePayload, productId, row.targetVersion?.variantId ?? null, null, 'APPLIED');
      effectCount += 1;
    }

    const media = Array.isArray(proposed.mediaAssets) ? proposed.mediaAssets as Array<Record<string, unknown>> : [];
    for (let index = 0; index < media.length; index += 1) {
      const asset = media[index];
      const variantIndex = asset.variantSku ? (Array.isArray(proposed.variants) ? (proposed.variants as Array<Record<string, unknown>>).findIndex((variant) => variant.sku === asset.variantSku) : -1) : -1;
      if (asset.variantSku && (variantIndex < 0 || !variantIds[variantIndex])) throw new UnprocessableEntityException({ code: 'IMPORT_MEDIA_VARIANT_NOT_FOUND', message: 'The media target references a variant that is not part of this row.' });
      const attach: AttachProductMediaDto = { mediaAssetId: String(asset.mediaAssetId), variantId: variantIndex < 0 ? null : variantIds[variantIndex],
        displayRole: String(asset.displayRole ?? 'GALLERY'), displayOrder: Number(asset.displayOrder ?? index), altText: String(asset.altText ?? '') };
      const mediaContext: ProductMediaMutationContext = { brandId: input.brandId, userId: input.actorUserId, permission: 'catalog.write',
        requestId: input.requestId, idempotencyKey: `imp:${rowKey}:media:${index}` };
      await client.query('SAVEPOINT import_media_effect');
      try {
        await this.productMedia.attachInTransaction(productId, attach, mediaContext, client);
        await this.insertEffect(client, input, row.sourceRowNumber, rowId, 'MEDIA_LINK', `media:${String(asset.mediaAssetId)}:${index}`,
          { mediaAssetId: attach.mediaAssetId, productId, variantId: attach.variantId, displayRole: attach.displayRole,
            displayOrder: attach.displayOrder, altText: attach.altText ?? '' }, productId,
          attach.variantId ?? null, String(asset.mediaAssetId), 'APPLIED');
        await client.query('RELEASE SAVEPOINT import_media_effect');
        effectCount += 1;
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT import_media_effect');
        await client.query('RELEASE SAVEPOINT import_media_effect');
        if (!input.allowPartial) throw error;
        failures.push({ target: `media-${index + 1}`, code: apiError(error).code });
      }
    }
    if (typeof proposed.imageUrl === 'string' && proposed.imageUrl.trim()) {
      throw new UnprocessableEntityException({ code: 'IMPORT_MEDIA_REQUIRES_APPROVED_ASSET', message: 'An image URL must pass the approved media intake and rights checks before import confirmation.' });
    }
    return { effectCount, failures, productId, variantId: variantIds[0] ?? row.targetVersion?.variantId ?? null };
  }

  private async insertEffect(client: PoolClient, input: ConfirmInput, sourceRowNumber: number, rowId: string, effectKind: ImportEffectKind,
    logicalTargetKey: string, payload: unknown, productId: string, variantId: string | null, mediaAssetId: string | null, outcome: string): Promise<void> {
    const { effectKey, payloadHash } = deriveImportEffectKey({ brandId: input.brandId, batchId: input.batchId, sourceRowNumber,
      effectKind, logicalTargetKey, payload });
    await client.query(`INSERT INTO imports.import_effect_receipts(brand_id,batch_id,row_id,effect_kind,effect_key,logical_target_key,payload_hash,
      target_media_asset_id,target_product_id,target_variant_id,outcome)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [input.brandId, input.batchId, rowId, effectKind, effectKey, logicalTargetKey,
      payloadHash, mediaAssetId, productId, variantId, outcome]);
  }
}

