import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';
import { canonicalizeSnapshot, ProductSubmissionContext, ProductSubmissionRepository, snapshotSha256, validateSubmissionReadiness } from './catalog-submission';
import { CategoryAttributeRule, compileCategorySchema } from './category-attribute-validator';

function fail(code: string, details?: Record<string, unknown>): Error {
  return Object.assign(new Error(code), { code, ...(details ? { details } : {}) });
}

function typedValue(row: Record<string, unknown>): unknown {
  switch (row.value_type) {
    case 'text': return row.val_text;
    case 'integer': return Number(row.val_integer);
    case 'decimal': return String(row.val_decimal);
    case 'boolean': return row.val_bool;
    case 'enum': return row.val_enum;
    case 'date': return row.val_date instanceof Date ? row.val_date.toISOString().slice(0, 10) : row.val_date;
    case 'multi_enum': return row.val_json;
    case 'measurement': return { ...(row.val_json as Record<string, unknown>), unitCode: row.unit_code };
    default: throw fail('SUBMISSION_ATTRIBUTE_TYPE_INVALID');
  }
}
function isoTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw fail('SUBMISSION_SNAPSHOT_INVALID');
  return date.toISOString();
}

@Injectable()
export class CatalogSubmissionPostgresRepository implements ProductSubmissionRepository {
  constructor(private readonly infrastructure: IdentityInfrastructure) {}

  async submit(productId: string, context: ProductSubmissionContext): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const requestHash = snapshotSha256({ productId, expectedRowVersion: context.expectedRowVersion,
        sourceKind: context.sourceKind, sourceReference: context.sourceReference });
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`${context.brandId}:${context.userId}:submitProductForReview:${context.idempotencyKey}`]);
      const replay = await client.query<{ request_sha256: string; response_payload: Record<string, unknown> }>(
        `SELECT r.request_sha256,r.response_payload FROM catalogue.product_submission_receipts r
          JOIN catalogue.products p ON p.id=r.product_id AND p.brand_id=r.brand_id
          JOIN brands.brands b ON b.id=r.brand_id AND b.onboarding_state='approved'
         WHERE r.brand_id=$1 AND r.actor_user_id=$2 AND r.idempotency_key=$3
           AND EXISTS(SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$2 AND ep.permission_code='catalog.submit'
             AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$1)))`,
        [context.brandId, context.userId, context.idempotencyKey]);
      if (replay.rows[0]) {
        if (replay.rows[0].request_sha256.trim() !== requestHash) throw fail('SUBMISSION_IDEMPOTENCY_CONFLICT');
        return replay.rows[0].response_payload;
      }

      const selected = await client.query<Record<string, unknown>>(
        `SELECT p.id,p.brand_id,p.category_id,p.style_code,p.title,p.description,p.content_version,p.row_version,
                p.category_schema_version,p.publication_state,p.qc_state,p.published_revision_id,
                c.code AS category_code,c.active AS category_active,c.schema_version AS current_schema_version,
                NOT EXISTS (SELECT 1 FROM catalogue.categories child WHERE child.parent_id=c.id) AS category_is_leaf,
                sv.id AS schema_version_id,sv.state AS schema_state,sv.validator_version,sv.ruleset_sha256
           FROM catalogue.products p
           JOIN catalogue.categories c ON c.id=p.category_id
           JOIN catalogue.category_schema_versions sv ON sv.category_id=c.id AND sv.version=p.category_schema_version
           JOIN brands.brands b ON b.id=p.brand_id AND b.onboarding_state='approved'
          WHERE p.id=$1 AND p.brand_id=$2
            AND EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$3 AND ep.permission_code='catalog.submit'
              AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$2)))
          FOR UPDATE OF p`, [productId, context.brandId, context.userId]);
      const product = selected.rows[0];
      if (!product) throw fail('SUBMISSION_NOT_FOUND');
      if (Number(product.row_version) !== context.expectedRowVersion) throw fail('SUBMISSION_VERSION_CONFLICT');
      if (!['DRAFT', 'INCOMPLETE', 'RE_REVIEW'].includes(String(product.publication_state))) throw fail('SUBMISSION_STATE_INVALID');

      const rules = await client.query<Record<string, unknown>>(
        `SELECT id,attribute_id,attribute_code AS code,display_label AS label,scope_type AS scope,value_type,allowed_values,unit_code,
                required_by_default,conditional_ast,min_values,max_values
           FROM catalogue.category_schema_attribute_rules WHERE schema_version_id=$1 ORDER BY scope_type,attribute_code`,
        [product.schema_version_id]);
      const productAttributes = await client.query<Record<string, unknown>>(
        `SELECT r.attribute_code AS code,r.value_type,v.val_text,v.val_integer,v.val_decimal,v.val_bool,v.val_date,v.val_enum,v.val_json,v.unit_code
           FROM catalogue.product_attribute_values v JOIN catalogue.category_schema_attribute_rules r ON r.id=v.frozen_rule_id
          WHERE v.brand_id=$1 AND v.product_id=$2 ORDER BY r.attribute_code`, [context.brandId, productId]);
      const variants = await client.query<Record<string, unknown>>(
          `SELECT v.id,v.sku,v.options,v.gtin,v.weight_g,v.variant_state,v.row_version,
                  COALESCE((SELECT jsonb_agg(jsonb_build_object('code',r.attribute_code,'type',r.value_type,'text',av.val_text,
                    'integer',av.val_integer,'decimal',av.val_decimal::text,'bool',av.val_bool,'date',av.val_date,'enum',av.val_enum,
                    'json',av.val_json,'unitCode',av.unit_code) ORDER BY r.attribute_code)
                    FROM catalogue.variant_attribute_values av JOIN catalogue.category_schema_attribute_rules r ON r.id=av.frozen_rule_id
                   WHERE av.brand_id=v.brand_id AND av.variant_id=v.id),'[]'::jsonb) AS attributes,
                  (SELECT jsonb_build_object('id',vp.id,'amountMinor',vp.amount_minor,'mrpMinor',vp.mrp_minor,'currency',vp.currency,
                    'validFrom',vp.valid_from,'validTo',vp.valid_to,'ruleVersion',vp.rule_version)
                     FROM catalogue.variant_prices vp WHERE vp.brand_id=v.brand_id AND vp.variant_id=v.id
                       AND vp.price_state='APPROVED' AND vp.valid_from<=now() AND (vp.valid_to IS NULL OR vp.valid_to>now())
                     ORDER BY vp.valid_from DESC,vp.id DESC LIMIT 1) AS approved_price
             FROM catalogue.product_variants v WHERE v.brand_id=$1 AND v.product_id=$2 AND v.variant_state<>'INACTIVE' ORDER BY v.id`,
        [context.brandId, productId]);
      const media = await client.query<Record<string, unknown>>(
          `SELECT m.id,m.media_asset_id,m.variant_id,m.display_role,m.display_order,a.scan_state,a.derivative_state,a.rights_state,a.sha256,a.mime_type,a.width,a.height
             FROM media.product_media m JOIN media.media_assets a ON a.id=m.media_asset_id AND a.brand_id=m.brand_id
            WHERE m.brand_id=$1 AND m.product_id=$2 AND m.detached_at IS NULL
            ORDER BY m.variant_id NULLS FIRST,m.display_order,m.id`, [context.brandId, productId]);
      const claims = await client.query<Record<string, unknown>>(
          `SELECT c.id,c.revision_id,c.claim_code,c.claim_text,c.claim_state,c.approved_at,c.expires_at,
                  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'mediaAssetId',e.media_asset_id,'state',e.evidence_state,
                    'issuer',e.issuer,'documentReference',e.document_reference,'documentExpiresAt',e.document_expires_at) ORDER BY e.id)
                    FROM catalogue.claim_evidence e WHERE e.claim_id=c.id AND e.brand_id=c.brand_id AND e.product_id=c.product_id),'[]'::jsonb) AS evidence,
                  EXISTS(SELECT 1 FROM catalogue.claim_evidence e JOIN media.media_assets a ON a.id=e.media_asset_id AND a.brand_id=e.brand_id
                    WHERE e.claim_id=c.id AND e.brand_id=c.brand_id AND e.product_id=c.product_id AND e.evidence_state='ACCEPTED'
                      AND a.scan_state='CLEAN' AND a.derivative_state='READY' AND a.rights_state IN('ATTESTED','REVIEWED')
                      AND (e.document_expires_at IS NULL OR e.document_expires_at>now())) AS evidence_eligible
             FROM catalogue.sustainability_claims c WHERE c.brand_id=$1 AND c.product_id=$2
             ORDER BY c.claim_code,c.id`, [context.brandId, productId]);
      const lineage = await client.query<Record<string, unknown>>(
          `SELECT field_path,source_kind,source_reference,actor_user_id,recorded_at FROM catalogue.product_field_lineage
            WHERE brand_id=$1 AND product_id=$2 ORDER BY recorded_at,id`, [context.brandId, productId]);

      const rulesValue = rules.rows.map((row) => ({ id: row.id, attributeId: row.attribute_id, code: row.code, label: row.label,
        scope: row.scope, valueType: row.value_type, allowedValues: row.allowed_values, unitCode: row.unit_code,
        required: row.required_by_default, conditional: row.conditional_ast, minValues: row.min_values, maxValues: row.max_values }));
      const attributes = Object.fromEntries(productAttributes.rows.map((row) => [String(row.code), typedValue(row)]));
      const mappedVariants = variants.rows.map((variant) => ({
        id: variant.id, sku: variant.sku, options: variant.options, gtin: variant.gtin, weightG: variant.weight_g,
        state: variant.variant_state, rowVersion: Number(variant.row_version),
        attributes: Object.fromEntries((variant.attributes as Array<Record<string, unknown>>).map((row) => [String(row.code),
          typedValue({ ...row, value_type: row.type, val_integer: row.integer, val_decimal: row.decimal,
            val_text: row.text, val_bool: row.bool, val_date: row.date, val_enum: row.enum, val_json: row.json, unit_code: row.unitCode })])),
        approvedPrice: variant.approved_price,
        hasApprovedPrice: variant.approved_price !== null,
      }));
      const mappedMedia = media.rows.map((row) => ({ id: row.id, assetId: row.media_asset_id, variantId: row.variant_id, role: row.display_role,
        order: row.display_order, scanState: row.scan_state, derivativeState: row.derivative_state,
        rightsState: row.rights_state, sha256: row.sha256, mimeType: row.mime_type, width: row.width, height: row.height }));
      const mappedClaims = claims.rows.map((row) => ({ id: row.id, revisionId: row.revision_id, code: row.claim_code,
        text: row.claim_text, state: row.claim_state, approvedAt: isoTimestamp(row.approved_at), expiresAt: isoTimestamp(row.expires_at),
        evidence: (row.evidence as Array<Record<string, unknown>>).map((item) => ({ ...item, documentExpiresAt: isoTimestamp(item.documentExpiresAt) })),
        evidenceEligible: row.evidence_eligible }));
      const readiness = validateSubmissionReadiness({
        category: { active: Boolean(product.category_active), isLeaf: Boolean(product.category_is_leaf),
          published: product.schema_state === 'PUBLISHED', schemaVersion: Number(product.category_schema_version),
          currentSchemaVersion: Number(product.current_schema_version) },
        attributesValid: true,
        variants: mappedVariants.map((variant) => ({ id: String(variant.id), active: true, currentApprovedPrice: Boolean(variant.hasApprovedPrice) })),
        media: mappedMedia.map((asset) => ({ id: String(asset.id), clean: asset.scanState === 'CLEAN',
          rightsApproved: asset.rightsState === 'ATTESTED' || asset.rightsState === 'REVIEWED', derivativeReady: asset.derivativeState === 'READY' })),
        claims: mappedClaims.filter((claim) => claim.state !== 'REJECTED').map((claim) => ({ id: String(claim.id),
          verified: claim.state === 'VERIFIED' && (!claim.expiresAt || new Date(String(claim.expiresAt)).getTime() > Date.now()),
          evidenceEligible: Boolean(claim.evidenceEligible) })),
      });
      // Re-run the pinned schema validator over persisted typed values. Draft writes may be incomplete.
      const validatorRules: CategoryAttributeRule[] = rules.rows.map((row) => ({
        id: String(row.id), attributeId: String(row.attribute_id), code: String(row.code), scope: row.scope as 'product'|'variant',
        valueType: row.value_type as never, displayLabel: String(row.label), allowedValues: row.allowed_values as unknown[]|null,
        unitCode: row.unit_code as string|null, requiredByDefault: Boolean(row.required_by_default), conditionalAst: row.conditional_ast,
        minValues: row.min_values as number|null, maxValues: row.max_values as number|null,
      }));
      const schema = compileCategorySchema({ categoryId: String(product.category_id), categorySchemaVersionId: String(product.schema_version_id),
        categorySchemaVersion: Number(product.category_schema_version), validatorVersion: String(product.validator_version), rules: validatorRules });
      let normalizedAttributes: Record<string, unknown> = attributes;
      const variantsToValidate = mappedVariants.length ? mappedVariants : [{ id: 'none', attributes: {} }];
      for (const variant of variantsToValidate) {
        const result = schema.validate({ product: attributes, variant: variant.attributes as Record<string, unknown> }, { mode: 'submission' });
        if (result.valid && normalizedAttributes === attributes) normalizedAttributes = { ...result.normalizedValues.product };
        if (!result.valid) readiness.push(...result.issues.map((issue) => ({ code: issue.code,
          path: issue.path.startsWith('attributes.product.') || issue.path.startsWith('attributes.variant.')
            ? issue.path.replace('attributes.variant.', `variants.${variant.id}.attributes.`)
            : issue.path,
          message: issue.message })));
      }
      if (readiness.length) throw fail('SUBMISSION_INCOMPLETE', { issues: readiness });

      const snapshot = {
        schema: 'renivet.product-revision.v1', product: { id: product.id, brandId: product.brand_id,
          categoryId: product.category_id, categoryCode: product.category_code, categorySchemaVersion: product.category_schema_version,
          validatorVersion: product.validator_version, rulesetSha256: product.ruleset_sha256, styleCode: product.style_code,
          title: product.title, description: product.description, contentVersion: product.content_version },
        attributes: normalizedAttributes, attributeRules: rulesValue, variants: mappedVariants,
        media: mappedMedia, claims: mappedClaims,
        sourceLineage: lineage.rows.map((entry) => ({ ...entry, recorded_at: isoTimestamp(entry.recorded_at) })),
      };
      const canonicalSnapshot = canonicalizeSnapshot(snapshot);
      const contentHash = snapshotSha256(snapshot);
      const revision = await client.query<{ id: string }>(
        `INSERT INTO catalogue.product_revisions
           (brand_id,product_id,content_version,content_snapshot,content_sha256,submitted_by,review_state,category_id,category_schema_version)
         VALUES($1,$2,$3,$4::jsonb,$5,$6,'SUBMITTED',$7,$8) RETURNING id`,
        [context.brandId, productId, Number(product.content_version), canonicalSnapshot, contentHash, context.userId,
          product.category_id, Number(product.category_schema_version)]);
      const updated = await client.query<{ row_version: string | number }>(
        `UPDATE catalogue.products p SET publication_state='PENDING_REVIEW',qc_state='PENDING',row_version=p.row_version+1,updated_at=now()
          WHERE p.id=$1 AND p.brand_id=$2 AND p.row_version=$3
            AND EXISTS(SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$4 AND ep.permission_code='catalog.submit'
              AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$2)))
          RETURNING p.row_version`, [productId, context.brandId, context.expectedRowVersion, context.userId]);
      if (!updated.rows[0]) throw fail('SUBMISSION_VERSION_CONFLICT');
      const response = { productId, revisionId: revision.rows[0].id, contentVersion: Number(product.content_version),
        contentSha256: contentHash, publicationState: 'PENDING_REVIEW', rowVersion: Number(updated.rows[0].row_version) };
      await client.query(
        `INSERT INTO catalogue.product_submission_receipts(brand_id,product_id,actor_user_id,idempotency_key,request_sha256,revision_id,response_payload)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [context.brandId, productId, context.userId, context.idempotencyKey, requestHash, revision.rows[0].id, JSON.stringify(response)]);
      await client.query(
        `INSERT INTO catalogue.product_field_lineage(brand_id,product_id,field_path,source_kind,source_reference,actor_user_id)
         VALUES($1,$2,'submittedRevision',$3,$4,$5)`, [context.brandId, productId, context.sourceKind, context.sourceReference, context.userId]);
      return response;
    });
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const pool = this.infrastructure.pool;
    if (!pool) throw fail('SUBMISSION_DATABASE_UNAVAILABLE');
    let client: PoolClient;
    try { client = await pool.connect(); } catch { throw fail('SUBMISSION_DATABASE_UNAVAILABLE'); }
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) {
      try { await client.query('ROLLBACK'); } catch { throw fail('SUBMISSION_DATABASE_UNAVAILABLE'); }
      const code = (error as { code?: string } | null)?.code;
      if (code === '23505') throw fail('SUBMISSION_IDEMPOTENCY_CONFLICT');
      if (code === '23503' || code === '23514' || code?.startsWith('22')) throw fail('SUBMISSION_SNAPSHOT_INVALID');
      if (code === '40001' || code === '40P01') throw fail('SUBMISSION_VERSION_CONFLICT');
      if (code?.startsWith('08') || ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','57P01'].includes(code ?? '')) {
        throw fail('SUBMISSION_DATABASE_UNAVAILABLE');
      }
      throw error;
    } finally { client.release(); }
  }
}
