import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';
import { SaveImportMappingDto } from './import-mapping.dto';
import { buildImportPreview, ImportPreviewSourceRow, ImportPreviewTarget, ImportPreviewTaxonomyCategory } from './import-preview-engine';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

function validateMapping(input: SaveImportMappingDto): void {
  if (!input || !input.fieldMappings || Array.isArray(input.fieldMappings)
    || Object.keys(input.fieldMappings).length < 1 || Object.keys(input.fieldMappings).length > 80
    || !input.categoryMappings || Array.isArray(input.categoryMappings) || Object.keys(input.categoryMappings).length > 200) {
    throw new UnprocessableEntityException({ code: 'IMPORT_MAPPING_INVALID', message: 'The mapping profile is invalid.' });
  }
  const targets = Object.values(input.fieldMappings);
  const sourceNames = Object.keys(input.fieldMappings);
  const categoryNames = Object.keys(input.categoryMappings);
  if (sourceNames.some((name) => !name.trim() || name.length > 128)
    || targets.some((target) => typeof target !== 'string' || !/^(?:title|styleCode|sku|categoryCode|sourceProductKey|sourceVariantKey|sourceMrp|imageUrl|(?:attributes|options)\.[A-Za-z][A-Za-z0-9_.-]{0,63})$/.test(target))) {
    throw new UnprocessableEntityException({ code: 'IMPORT_MAPPING_INVALID', message: 'The mapping profile is invalid.' });
  }
  if (sourceNames.some((name, index) => sourceNames.findIndex((candidate) => candidate.trim().toLocaleLowerCase('en-US') === name.trim().toLocaleLowerCase('en-US')) !== index)
    || targets.some((target, index) => targets.indexOf(target) !== index)) {
    throw new UnprocessableEntityException({ code: 'IMPORT_MAPPING_INVALID', message: 'Source names and destination fields must be unique.' });
  }
  if (Object.entries(input.categoryMappings).some(([source, target]) => !source.trim() || source.length > 128
    || typeof target !== 'string' || !/^[A-Za-z0-9_.-]{1,96}$/.test(target))) {
    throw new UnprocessableEntityException({ code: 'IMPORT_MAPPING_INVALID', message: 'The category mapping is invalid.' });
  }
  if (categoryNames.some((name, index) => categoryNames.findIndex((candidate) => candidate.trim().toLocaleLowerCase('en-US') === name.trim().toLocaleLowerCase('en-US')) !== index)) {
    throw new UnprocessableEntityException({ code: 'IMPORT_MAPPING_INVALID', message: 'Source categories must be unique without regard to case.' });
  }
  if (input.fieldMask && input.fieldMask.some((field) => typeof field !== 'string' || !targets.includes(field)
    && !targets.some((target) => target.startsWith(`${field}.`)))) {
    throw new UnprocessableEntityException({ code: 'IMPORT_FIELD_MASK_INVALID', message: 'The selected field mask is invalid.' });
  }
}

@Injectable()
export class ImportPreviewService {
  constructor(private readonly infrastructure: IdentityInfrastructure) {}

  async saveMapping(input: {
    brandId: string; batchId: string; actorUserId: string; idempotencyKey: string; expectedVersion: number;
    mapping: SaveImportMappingDto; requestId: string;
  }): Promise<{ mappingVersion: number; previewRevision: number; previewHash: string }> {
    validateMapping(input.mapping);
    const pool = this.infrastructure.pool;
    if (!pool) throw new ServiceUnavailableException({ code: 'IMPORT_DATABASE_UNAVAILABLE', message: 'Import storage is unavailable.' });
    const requestHash = digest({ brandId: input.brandId, batchId: input.batchId, mapping: input.mapping });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const batchResult = await client.query(`SELECT b.id,b.brand_id,b.source_kind,b.source_sha256,b.source_as_of,b.job_state,b.requested_policy,b.preview_revision
        FROM imports.import_batches b
        WHERE b.id=$1 AND b.brand_id=$2
          AND EXISTS (SELECT 1 FROM access.effective_permissions p WHERE p.user_id=$3 AND p.permission_code='imports.write'
            AND ((p.scope_type='global' AND p.brand_id IS NULL) OR (p.scope_type='brand' AND p.brand_id=$2)))
        FOR UPDATE OF b`, [input.batchId, input.brandId, input.actorUserId]);
      const batch = batchResult.rows[0];
      if (!batch) throw new NotFoundException({ code: 'IMPORT_BATCH_NOT_FOUND', message: 'The import batch is not available.' });
      const prior = await client.query(`SELECT version,request_hash,preview_revision,preview_hash
        FROM imports.import_mapping_profiles WHERE brand_id=$1 AND idempotency_key=$2`,
        [input.brandId, input.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash) throw new ConflictException({ code: 'IMPORT_IDEMPOTENCY_CONFLICT', message: 'The idempotency key was used with different mapping data.' });
        await client.query('COMMIT');
        return { mappingVersion: Number(prior.rows[0].version), previewRevision: Number(prior.rows[0].preview_revision), previewHash: String(prior.rows[0].preview_hash).trim() };
      }
      if (!['RECEIVED', 'PREVIEWED', 'MAPPING_REQUIRED'].includes(batch.job_state)) throw new ConflictException({ code: 'IMPORT_BATCH_STATE_CONFLICT', message: 'The import batch cannot be remapped in its current state.' });
      const latest = await client.query('SELECT COALESCE(max(version),0)::integer AS version FROM imports.import_mapping_profiles WHERE batch_id=$1 AND brand_id=$2', [input.batchId, input.brandId]);
      const currentVersion = Number(latest.rows[0].version);
      if (currentVersion !== input.expectedVersion) throw new ConflictException({ code: 'IMPORT_MAPPING_VERSION_STALE', message: 'The mapping profile changed. Reload the batch and try again.' });

      const profile = { fields: input.mapping.fieldMappings, categories: input.mapping.categoryMappings, fieldMask: input.mapping.fieldMask ?? null };
      const mappingVersion = currentVersion + 1;
      const profileHash = digest(profile);
      const mappingId = randomUUID();
      const rowsResult = await client.query(`SELECT source_row_number,raw_record,canonical_record,validation_errors
        FROM imports.import_rows WHERE batch_id=$1 AND brand_id=$2 ORDER BY source_row_number`, [input.batchId, input.brandId]);
      const sourceRows: ImportPreviewSourceRow[] = rowsResult.rows.map((row) => ({ rowNumber: Number(row.source_row_number),
        rawRecord: row.raw_record ?? {}, canonicalRecord: row.canonical_record ?? null,
        validationErrors: Array.isArray(row.validation_errors) ? row.validation_errors : [] }));
      const categoryResult = await client.query(`SELECT c.id AS category_id,c.code,c.active,c.schema_version,v.id AS schema_version_id,v.validator_version,
          COALESCE(v.ruleset_sha256,repeat('0',64)) AS ruleset_sha256,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'attributeId',r.attribute_id,'code',r.attribute_code,'scope',r.scope_type,
            'valueType',r.value_type,'allowedValues',r.allowed_values,'unitCode',r.unit_code,'requiredByDefault',r.required_by_default,
            'conditionalAst',r.conditional_ast,'minValues',r.min_values,'maxValues',r.max_values) ORDER BY r.attribute_code,r.scope_type)
            FROM catalogue.category_schema_attribute_rules r WHERE r.schema_version_id=v.id), '[]'::jsonb) AS attribute_rules
        FROM catalogue.categories c LEFT JOIN catalogue.category_schema_versions v ON v.category_id=c.id AND v.version=c.schema_version
        WHERE NOT EXISTS (SELECT 1 FROM catalogue.categories child WHERE child.parent_id=c.id)
        ORDER BY c.code`);
      const taxonomySnapshot = categoryResult.rows.map((row) => ({ categoryId: String(row.category_id), code: String(row.code), active: Boolean(row.active),
        version: Number(row.schema_version ?? 0), schemaVersionId: row.schema_version_id ? String(row.schema_version_id) : null,
        validatorVersion: row.validator_version ? String(row.validator_version) : null, schemaSha256: String(row.ruleset_sha256).trim(),
        attributes: Array.isArray(row.attribute_rules) ? row.attribute_rules : [] }));
      const taxonomy = { version: Math.max(1, ...taxonomySnapshot.map((category) => category.version)),
        snapshotSha256: digest(taxonomySnapshot), categories: taxonomySnapshot.map((category): ImportPreviewTaxonomyCategory => ({
          code: category.code, active: category.active, categoryId: category.categoryId, schemaVersionId: category.schemaVersionId ?? undefined,
          schemaVersion: category.version, validatorVersion: category.validatorVersion ?? undefined, attributes: category.attributes,
        })) };
      const skuField = Object.entries(input.mapping.fieldMappings).find(([, target]) => target === 'sku')?.[0]?.trim().toLocaleLowerCase('en-US');
      const skus = [...new Set(sourceRows.map((row) => {
        const key = Object.keys(row.rawRecord).find((name) => name.trim().toLocaleLowerCase('en-US') === skuField);
        return key ? String(row.rawRecord[key] ?? '').normalize('NFC').trim().toLocaleUpperCase('en-US') : '';
      }).filter(Boolean))];
      let targets: ImportPreviewTarget[] = [];
      if (skus.length) {
        const targetResult = await client.query(`SELECT p.id AS product_id,p.row_version AS product_row_version,p.content_version,p.style_code,p.title,p.updated_at AS product_updated_at,
            COALESCE((SELECT jsonb_object_agg(r.attribute_code,COALESCE(v.val_json,to_jsonb(COALESCE(v.val_text,v.val_integer::text,v.val_decimal::text,v.val_bool::text,v.val_date::text,v.val_enum))))
              FROM catalogue.product_attribute_values v JOIN catalogue.category_schema_attribute_rules r ON r.id=v.frozen_rule_id
              WHERE v.product_id=p.id AND v.brand_id=p.brand_id), '{}'::jsonb) AS product_attributes,
            c.code AS category_code,p.publication_state AS product_state,v.id AS variant_id,v.row_version AS variant_row_version,v.variant_state,v.sku,v.options,v.updated_at AS variant_updated_at
          FROM catalogue.product_variants v JOIN catalogue.products p ON p.id=v.product_id AND p.brand_id=v.brand_id
          JOIN catalogue.categories c ON c.id=p.category_id
          WHERE p.brand_id=$1 AND upper(btrim(v.sku)) = ANY($2::text[])`, [input.brandId, skus]);
        targets = targetResult.rows.map((row) => ({ productId: String(row.product_id), productRowVersion: Number(row.product_row_version),
          variantId: String(row.variant_id), variantRowVersion: Number(row.variant_row_version), rowVersion: Number(row.variant_row_version),
          contentVersion: Number(row.content_version), sku: String(row.sku), styleCode: String(row.style_code), title: String(row.title),
          categoryCode: String(row.category_code), attributes: row.product_attributes ?? {}, options: row.options ?? {}, updatedAt: [row.product_updated_at, row.variant_updated_at]
            .filter(Boolean).map((date) => new Date(date as string).toISOString()).sort().at(-1) ?? null,
          productState: String(row.product_state), variantState: String(row.variant_state) }));
      }
      const previewRevision = Number(batch.preview_revision) + 1;
      const snapshot = buildImportPreview({ previewRevision, batch: { id: String(batch.id), brandId: input.brandId, sourceSha256: String(batch.source_sha256).trim(),
        sourceAsOf: new Date(batch.source_as_of).toISOString(), mode: (batch.requested_policy as Record<string, unknown>)?.mode as string | undefined },
        mapping: { version: mappingVersion, fields: input.mapping.fieldMappings, categories: input.mapping.categoryMappings },
        taxonomy, sourceRows, targets, fieldMasks: input.mapping.fieldMask });
      await client.query(`INSERT INTO imports.import_mapping_profiles
        (id,brand_id,batch_id,version,profile,profile_sha256,idempotency_key,request_hash,created_by,preview_revision,preview_hash)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11)`, [mappingId, input.brandId, input.batchId, mappingVersion,
        JSON.stringify(profile), profileHash, input.idempotencyKey, requestHash, input.actorUserId, previewRevision, snapshot.previewHash]);
      await client.query(`INSERT INTO imports.import_previews
        (brand_id,batch_id,preview_revision,preview_hash,source_sha256,mapping_version,taxonomy_snapshot_sha256,target_versions,conflict_report,preview_snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb)`, [input.brandId, input.batchId, previewRevision,
        snapshot.previewHash, snapshot.sourceSha256, snapshot.mappingVersion, snapshot.taxonomySnapshotSha256,
        JSON.stringify(snapshot.targetVersions), JSON.stringify(snapshot.rows.flatMap((row) => row.conflicts.map((conflict) => ({ row: row.sourceRowNumber, ...conflict })))),
        JSON.stringify({ ...snapshot, mappingId, mappingHash: profileHash })]);
      await client.query(`UPDATE imports.import_batches SET preview_revision=$3,preview_hash=$4,job_state='PREVIEWED',updated_at=now()
        WHERE id=$1 AND brand_id=$2`, [input.batchId, input.brandId, previewRevision, snapshot.previewHash]);
      await client.query(`INSERT INTO access.security_audit_events(actor_user_id,action,subject_type,subject_id,request_id,payload_hash)
        VALUES($1,'imports.mapping.saved','imports.batch',$2,$3,$4)`, [input.actorUserId, input.batchId, input.requestId, digest({ profileHash, previewHash: snapshot.previewHash })]);
      await client.query('COMMIT');
      return { mappingVersion, previewRevision, previewHash: snapshot.previewHash };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof ConflictException || error instanceof NotFoundException || error instanceof UnprocessableEntityException) throw error;
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        throw new ConflictException({ code: 'IMPORT_IDEMPOTENCY_CONFLICT', message: 'The mapping idempotency key was already used.' });
      }
      throw new ServiceUnavailableException({ code: 'IMPORT_DATABASE_UNAVAILABLE', message: 'The import preview could not be saved.' });
    } finally { client.release(); }
  }

  async getPreview(input: { brandId: string; batchId: string; userId: string; requestId: string }): Promise<Record<string, unknown>> {
    const pool = this.infrastructure.pool;
    if (!pool) throw new ServiceUnavailableException({ code: 'IMPORT_DATABASE_UNAVAILABLE', message: 'Import storage is unavailable.' });
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`SELECT p.preview_snapshot FROM imports.import_previews p
        JOIN imports.import_batches b ON b.id=p.batch_id AND b.brand_id=p.brand_id
        WHERE p.batch_id=$1 AND p.brand_id=$2
          AND EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$3 AND ep.permission_code='imports.read'
            AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$2)))
        ORDER BY p.preview_revision DESC LIMIT 1`, [input.batchId, input.brandId, input.userId]);
      if (!result.rows[0]) throw new NotFoundException({ code: 'IMPORT_PREVIEW_NOT_FOUND', message: 'The preview is not available.' });
      const snapshot = result.rows[0].preview_snapshot as Record<string, unknown>;
      const targetVersions = Array.isArray(snapshot.targetVersions) ? snapshot.targetVersions : [];
      if (targetVersions.length) {
        const expectedTargets = new Map(targetVersions.map((item) => {
          const target = item as Record<string, unknown>;
          return [`${target.productId}:${target.variantId ?? ''}`, target] as const;
        }));
        const currentTargets = await client.query(`SELECT target."productId" AS product_id,target."variantId" AS variant_id,
            (p.id IS NOT NULL) AS product_exists,(v.id IS NOT NULL) AS variant_exists,
            p.row_version AS product_row_version,p.content_version,v.row_version AS variant_row_version
          FROM jsonb_to_recordset($1::jsonb) AS target("productId" uuid,"variantId" uuid,"productRowVersion" bigint,
            "variantRowVersion" bigint,"contentVersion" integer)
          LEFT JOIN catalogue.products p ON p.id=target."productId" AND p.brand_id=$2
          LEFT JOIN catalogue.product_variants v ON v.id=target."variantId" AND v.product_id=p.id AND v.brand_id=$2`,
        [JSON.stringify(targetVersions), input.brandId]);
        const isStale = currentTargets.rows.some((target) => {
          const expected = expectedTargets.get(`${target.product_id}:${target.variant_id ?? ''}`);
          return !expected || !target.product_exists || (expected.variantId !== null && expected.variantId !== undefined && !target.variant_exists)
            || Number(target.product_row_version) !== Number(expected.productRowVersion)
            || Number(target.content_version) !== Number(expected.contentVersion)
            || (expected.variantId !== null && expected.variantId !== undefined
              && Number(target.variant_row_version) !== Number(expected.variantRowVersion));
        });
        if (isStale || currentTargets.rows.length !== targetVersions.length) {
          throw new ConflictException({ code: 'PREVIEW_STALE', message: 'A product changed after this preview was created. Save a new mapping to refresh the preview.' });
        }
      }
      await client.query(`INSERT INTO access.security_audit_events(actor_user_id,action,subject_type,subject_id,request_id,payload_hash)
        VALUES($1,'imports.preview.read','imports.batch',$2,$3,$4)`, [input.userId, input.batchId, input.requestId, digest(snapshot)]);
      await client.query('COMMIT');
      const publicSnapshot = { ...snapshot };
      delete publicSnapshot.mappingId;
      delete publicSnapshot.mappingHash;
      return publicSnapshot;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof NotFoundException || error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException({ code: 'IMPORT_DATABASE_UNAVAILABLE', message: 'The import preview could not be read.' });
    } finally { client.release(); }
  }
}
