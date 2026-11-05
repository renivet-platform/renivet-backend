import { Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { BrandAccessContext, buildBrandScopePredicate } from '../access/brand-access.guard';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';
import { ProductListPage } from './product-read.service';

interface ProductRow { authorized: boolean; id: string | null; brand_id: string | null; category_id: string | null; style_code: string | null; title: string | null; publication_state: string | null; content_version: number | null; row_version: string | null; qc_state: string | null; category_schema_version: number | null; published_revision_id: string | null; published_approval_id: string | null; draft_revision_id: string | null; cursor_updated_at: string | null; }
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ProductReadRepository {
  list(context: BrandAccessContext, page: ProductListPage): Promise<{ items: Record<string, unknown>[]; totalCount: number; nextCursor: string | null }>;
  get(context: BrandAccessContext, productId: string): Promise<Record<string, unknown>>;
}

@Injectable()
export class ProductReadPostgresRepository implements ProductReadRepository {
  constructor(private readonly infrastructure: IdentityInfrastructure) {}

  async list(context: BrandAccessContext, page: ProductListPage) {
    const scope = buildBrandScopePredicate('p', context, 1);
    const filterHash = createHash('sha256').update(JSON.stringify([context.brandId, page.categoryId, page.reviewState, page.visibility])).digest('hex');
    const cursor = page.cursor === null ? null : decodeCursor(page.cursor, filterHash);
    const pool = this.getPool();
    try {
      const result = await pool.query<ProductRow & { total_count: string }>(
        `WITH auth AS (SELECT EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$2 AND ep.permission_code=$3 AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$1))) authorized),
         filtered AS (SELECT p.id,p.brand_id,p.category_id,p.style_code,p.title,p.publication_state,p.content_version,p.row_version,p.qc_state,p.category_schema_version,p.published_revision_id,p.published_approval_id,p.updated_at
           FROM catalogue.products p CROSS JOIN auth WHERE auth.authorized AND ${scope.sql}
            AND ($4::uuid IS NULL OR p.category_id=$4)
            AND ($5::text IS NULL OR COALESCE(
              (SELECT rr.review_state FROM catalogue.product_revisions rr WHERE rr.brand_id=$1 AND rr.product_id=p.id AND rr.content_version=p.content_version ORDER BY rr.id DESC LIMIT 1),
              CASE WHEN p.published_revision_id IS NOT NULL AND EXISTS(SELECT 1 FROM catalogue.product_revisions pr WHERE pr.id=p.published_revision_id AND pr.brand_id=$1 AND pr.product_id=p.id AND pr.content_version=p.content_version) THEN 'APPROVED'
                   ELSE p.qc_state END
            )=$5)
            AND ($6::text IS NULL OR ($6='PUBLIC' AND p.publication_state='PUBLISHED') OR ($6='PRIVATE' AND p.publication_state NOT IN ('PUBLISHED','RESTRICTED','ARCHIVED')) OR ($6='RESTRICTED' AND p.publication_state='RESTRICTED'))),
         page AS (SELECT f.*, (SELECT r.id FROM catalogue.product_revisions r WHERE r.brand_id=$1 AND r.product_id=f.id AND r.content_version=f.content_version AND r.review_state IN ('DRAFT','SUBMITTED') ORDER BY r.content_version DESC LIMIT 1) draft_revision_id,
            to_char(f.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') cursor_updated_at
            FROM filtered f WHERE ($7::timestamptz IS NULL OR (f.updated_at,f.id)<($7::timestamptz,$8::uuid))
            ORDER BY f.updated_at DESC,f.id DESC LIMIT $9)
         SELECT auth.authorized,page.*, (SELECT count(*) FROM filtered)::text total_count FROM auth LEFT JOIN page ON true ORDER BY page.cursor_updated_at DESC NULLS LAST,page.id DESC NULLS LAST`,
        [context.brandId, context.userId, context.permission, page.categoryId, page.reviewState, page.visibility, cursor?.updatedAt ?? null, cursor?.id ?? null, page.limit + 1]);
      assertAuthorized(result.rows[0]?.authorized);
      const rows = result.rows.filter((row) => row.id !== null);
      const more = rows.length > page.limit;
      const selected = more ? rows.slice(0, page.limit) : rows;
      return {
        items: selected.map(summary), totalCount: Number(result.rows[0]?.total_count ?? 0),
        nextCursor: more ? encodeCursor(selected[selected.length - 1].cursor_updated_at!, selected[selected.length - 1].id!, filterHash) : null,
      };
    } catch (error) { throw normalizeDbError(error); }
  }

  async get(context: BrandAccessContext, productId: string): Promise<Record<string, unknown>> {
    const scope = buildBrandScopePredicate('p', context, 1);
    const pool = this.getPool();
    try {
      const result = await pool.query<ProductRow & { detail: Record<string, unknown> }>(
        `WITH auth AS (SELECT EXISTS(SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$2 AND ep.permission_code=$3 AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$1))) authorized),
         base AS (SELECT p.*, (SELECT r.id FROM catalogue.product_revisions r WHERE r.brand_id=$1 AND r.product_id=p.id AND r.content_version=p.content_version AND r.review_state IN('DRAFT','SUBMITTED') ORDER BY r.content_version DESC LIMIT 1) draft_revision_id FROM catalogue.products p CROSS JOIN auth WHERE auth.authorized AND ${scope.sql} AND p.id=$4),
         attrs AS (SELECT v.product_id,jsonb_object_agg(rule.attribute_code, CASE WHEN v.val_text IS NOT NULL THEN to_jsonb(v.val_text) WHEN v.val_integer IS NOT NULL THEN to_jsonb(v.val_integer) WHEN v.val_decimal IS NOT NULL THEN to_jsonb(v.val_decimal) WHEN v.val_bool IS NOT NULL THEN to_jsonb(v.val_bool) WHEN v.val_date IS NOT NULL THEN to_jsonb(v.val_date::text) WHEN v.val_enum IS NOT NULL THEN to_jsonb(v.val_enum) ELSE v.val_json END) value FROM catalogue.product_attribute_values v JOIN catalogue.category_schema_attribute_rules rule ON rule.id=v.frozen_rule_id AND rule.schema_version_id=v.schema_version_id AND rule.scope_type='product' WHERE v.brand_id=$1 AND v.product_id=$4 AND EXISTS(SELECT 1 FROM base) GROUP BY v.product_id),
         variants AS (SELECT v.product_id,jsonb_agg(jsonb_build_object('id',v.id,'productId',v.product_id,'brandId',v.brand_id,'sku',v.sku,'options',v.options,'variantState',v.variant_state,'priceVersions',COALESCE(prices.items,'[]'::jsonb),'mediaLinks',COALESCE(vm.items,'[]'::jsonb)) ORDER BY v.id) items FROM catalogue.product_variants v LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('id',vp.id,'variantId',vp.variant_id,'amountMinor',vp.amount_minor,'mrpMinor',vp.mrp_minor,'currency',vp.currency,'validFrom',vp.valid_from,'validTo',vp.valid_to,'priceState',vp.price_state,'rowVersion',vp.row_version) ORDER BY vp.valid_from DESC,vp.id DESC) items FROM catalogue.variant_prices vp WHERE vp.brand_id=$1 AND vp.variant_id=v.id) prices ON true LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('id',m.id,'mediaAssetId',m.media_asset_id,'productId',m.product_id,'variantId',m.variant_id,'displayRole',m.display_role,'displayOrder',m.display_order,'scanState',a.scan_state,'rightsState',a.rights_state) ORDER BY m.display_order,m.id) items FROM media.product_media m JOIN media.media_assets a ON a.id=m.media_asset_id AND a.brand_id=$1 WHERE m.brand_id=$1 AND m.product_id=v.product_id AND m.variant_id=v.id AND m.detached_at IS NULL) vm ON true WHERE v.brand_id=$1 AND v.product_id=$4 AND EXISTS(SELECT 1 FROM base) GROUP BY v.product_id),
         media AS (SELECT m.product_id,jsonb_agg(jsonb_build_object('id',m.id,'mediaAssetId',m.media_asset_id,'productId',m.product_id,'variantId',m.variant_id,'displayRole',m.display_role,'displayOrder',m.display_order,'scanState',a.scan_state,'rightsState',a.rights_state) ORDER BY m.display_order,m.id) items FROM media.product_media m JOIN media.media_assets a ON a.id=m.media_asset_id AND a.brand_id=$1 WHERE m.brand_id=$1 AND m.product_id=$4 AND m.variant_id IS NULL AND m.detached_at IS NULL AND EXISTS(SELECT 1 FROM base) GROUP BY m.product_id)
         SELECT auth.authorized, base.id, jsonb_build_object('id',base.id,'brandId',base.brand_id,'styleCode',base.style_code,'title',base.title,'publicationState',base.publication_state,'contentVersion',base.content_version,'categoryId',base.category_id,'categorySchemaVersion',base.category_schema_version,'rowVersion',base.row_version,'variants',COALESCE(variants.items,'[]'::jsonb),'mediaLinks',COALESCE(media.items,'[]'::jsonb),'attributes',COALESCE(attrs.value,'{}'::jsonb),'qcState',base.qc_state,'draftRevisionId',base.draft_revision_id,'publishedRevisionId',base.published_revision_id,'approvedReviewId',base.published_approval_id) detail FROM auth LEFT JOIN base ON true LEFT JOIN attrs ON attrs.product_id=base.id LEFT JOIN variants ON variants.product_id=base.id LEFT JOIN media ON media.product_id=base.id`,
        [context.brandId, context.userId, context.permission, productId]);
      assertAuthorized(result.rows[0]?.authorized);
      if (!result.rows[0]?.id) throw repoError('PRODUCT_NOT_FOUND');
      return result.rows[0].detail;
    } catch (error) { throw normalizeDbError(error); }
  }
  private getPool(): Pool { const pool = this.infrastructure.pool; if (!pool) throw repoError('PRODUCT_READ_UNAVAILABLE'); return pool; }
}

function summary(row: ProductRow): Record<string, unknown> { return { id: row.id, brandId: row.brand_id, styleCode: row.style_code, title: row.title, publicationState: row.publication_state, contentVersion: row.content_version }; }
function encodeCursor(updatedAt: string, id: string, filterHash: string): string { return Buffer.from(JSON.stringify({ updatedAt, id, filterHash }), 'utf8').toString('base64url'); }
function decodeCursor(cursor: string, filterHash: string): { updatedAt: string; id: string } {
  let value: unknown; try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { throw repoError('PRODUCT_CURSOR_INVALID'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw repoError('PRODUCT_CURSOR_INVALID');
  const candidate = value as Record<string, unknown>;
  if (Buffer.from(JSON.stringify(value), 'utf8').toString('base64url') !== cursor || Object.keys(candidate).sort().join(',') !== 'filterHash,id,updatedAt'
    || candidate.filterHash !== filterHash || typeof candidate.id !== 'string' || !uuidPattern.test(candidate.id)
    || typeof candidate.updatedAt !== 'string' || !isValidCursorTimestamp(candidate.updatedAt)) throw repoError('PRODUCT_CURSOR_INVALID');
  return { id: candidate.id, updatedAt: candidate.updatedAt };
}
function isValidCursorTimestamp(value: string): boolean {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value) || Number(value.slice(0, 4)) < 1) return false;
  const secondPrecision = value.slice(0, 19);
  const milliseconds = Date.parse(`${secondPrecision}.000Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 19) === secondPrecision;
}
function assertAuthorized(authorized: boolean | undefined): void { if (!authorized) throw repoError('PRODUCT_READ_FORBIDDEN'); }
function repoError(code: string): Error { return Object.assign(new Error(code), { code }); }
function normalizeDbError(error: unknown): unknown {
  const code = (error as { code?: string } | null)?.code;
  if (code === 'PRODUCT_READ_FORBIDDEN' || code === 'PRODUCT_NOT_FOUND' || code === 'PRODUCT_CURSOR_INVALID') return error;
  if (code?.startsWith('08') || ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','57P01'].includes(code ?? '')) return repoError('PRODUCT_READ_UNAVAILABLE');
  return error;
}
