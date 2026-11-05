import type { PoolClient } from 'pg';
import { snapshotSha256 } from './catalog-submission';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_KEYS = ['brandId', 'expectedPriceId', 'expectedPriceRowVersion', 'expectedPublicationVersion', 'productId', 'sku', 'variantId'];

export type CatalogBuyabilityRequest = Readonly<{
  brandId: string;
  productId: string;
  variantId: string;
  sku: string;
  expectedPublicationVersion: number;
  expectedPriceId: string;
  expectedPriceRowVersion: number;
}>;

export type CatalogBuyabilityResult = Readonly<{
  contractVersion: 1;
  decision: 'BUYABLE' | 'DENIED';
  code: 'BUYABLE' | 'NOT_BUYABLE' | 'STALE_PUBLICATION' | 'PRICE_UNAVAILABLE' | 'PRICE_EXPIRED' | 'STALE_PRICE';
  catalogEligible: boolean;
  stockAllocation: 'NOT_CHECKED';
  productId?: string;
  variantId?: string;
  publicationVersion?: number;
  revisionId?: string;
  price?: Readonly<{ id: string; rowVersion: number; currency: 'INR'; amountMinor: number; mrpMinor: number; validFrom: string; validTo: string | null }>;
}>;

function invalidRequest(): Error { return Object.assign(new Error('The buyability request is invalid.'), { code: 'CATALOG_BUYABILITY_REQUEST_INVALID' }); }

export function validateBuyabilityRequest(value: unknown): CatalogBuyabilityRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidRequest();
  const request = value as Record<string, unknown>;
  const keys = Object.keys(request).sort();
  if (keys.length !== REQUEST_KEYS.length || keys.some((key, index) => key !== [...REQUEST_KEYS].sort()[index])
    || !UUID.test(String(request.brandId)) || !UUID.test(String(request.productId)) || !UUID.test(String(request.variantId))
    || !UUID.test(String(request.expectedPriceId)) || typeof request.sku !== 'string' || request.sku.trim().length < 1
    || request.sku.length > 128 || request.sku !== request.sku.trim()
    || !Number.isSafeInteger(request.expectedPublicationVersion) || Number(request.expectedPublicationVersion) < 1
    || !Number.isSafeInteger(request.expectedPriceRowVersion) || Number(request.expectedPriceRowVersion) < 1) throw invalidRequest();
  return Object.freeze({ ...request }) as CatalogBuyabilityRequest;
}

type BuyabilityRow = {
  product_id: string; brand_id: string; publication_state: string; qc_state: string; publication_version: string | number;
  published_revision_id: string | null; published_approval_id: string | null; published_approval_decision: string | null;
  brand_state: string; category_eligible: boolean; variant_id: string; sku: string; variant_state: string;
  revision_state: string | null; revision_hash: string | null; content_snapshot: Record<string, unknown> | null;
  review_decision: string | null; reviewer_user_id: string | null; submitted_by: string | null;
  current_price_id: string | null; current_price_row_version: string | number | null; current_currency: string | null;
  current_amount_minor: string | number | null; current_mrp_minor: string | number | null; current_valid_from: Date | null; current_valid_to: Date | null;
  requested_price_id: string | null; requested_price_valid_to: Date | null;
  requested_price_expired: boolean | null;
};

const deny = (code: CatalogBuyabilityResult['code']): CatalogBuyabilityResult => Object.freeze({
  contractVersion: 1, decision: 'DENIED', code, catalogEligible: false, stockAllocation: 'NOT_CHECKED',
});

/**
 * Internal W3-facing source port. Call inside the checkout transaction, before
 * any stock reservation; this class never allocates inventory or creates orders.
 */
export class CatalogBuyabilityPostgresPort {
  private readonly allowedConsumers: readonly string[];

  constructor(allowedConsumers: readonly string[]) {
    if (!Array.isArray(allowedConsumers) || allowedConsumers.length === 0
      || allowedConsumers.some((consumer) => !/^[a-z][a-z0-9._-]{2,55}\.synthetic$/.test(consumer))) {
      throw new TypeError('At least one valid synthetic buyability consumer must be configured');
    }
    this.allowedConsumers = Object.freeze([...allowedConsumers]);
  }

  async validate(transaction: PoolClient, value: unknown, consumerId: string): Promise<CatalogBuyabilityResult> {
    if (!this.allowedConsumers.includes(consumerId)) throw Object.assign(new Error('The buyability caller is not allowed.'), { code: 'CATALOG_BUYABILITY_CALLER_DENIED' });
    const request = validateBuyabilityRequest(value);
    const result = await transaction.query<BuyabilityRow>(
      `SELECT p.id AS product_id,p.brand_id,p.publication_state,p.qc_state,p.publication_version,
              p.published_revision_id,p.published_approval_id,p.published_approval_decision,
              b.onboarding_state AS brand_state,
              (c.active AND sv.state='PUBLISHED' AND NOT EXISTS(SELECT 1 FROM catalogue.categories child WHERE child.parent_id=c.id)) AS category_eligible,
              v.id AS variant_id,v.sku,v.variant_state,
              r.review_state AS revision_state,r.content_sha256 AS revision_hash,r.content_snapshot,
              q.decision AS review_decision,q.reviewer_user_id,r.submitted_by,
              current_price.id AS current_price_id,current_price.row_version AS current_price_row_version,
              current_price.currency AS current_currency,current_price.amount_minor AS current_amount_minor,
              current_price.mrp_minor AS current_mrp_minor,current_price.valid_from AS current_valid_from,current_price.valid_to AS current_valid_to,
              requested_price.id AS requested_price_id,
              requested_price.valid_to AS requested_price_valid_to,
              (requested_price.valid_to IS NOT NULL AND requested_price.valid_to<=statement_timestamp()) AS requested_price_expired
         FROM catalogue.products p
         JOIN brands.brands b ON b.id=p.brand_id
         JOIN catalogue.categories c ON c.id=p.category_id
         JOIN catalogue.category_schema_versions sv ON sv.category_id=c.id AND sv.version=p.category_schema_version
         JOIN catalogue.product_variants v ON v.product_id=p.id AND v.brand_id=p.brand_id AND v.id=$3 AND v.sku=$4
         LEFT JOIN catalogue.product_revisions r ON r.id=p.published_revision_id AND r.product_id=p.id AND r.brand_id=p.brand_id
         LEFT JOIN catalogue.product_qc_reviews q ON q.id=p.published_approval_id AND q.product_id=p.id AND q.brand_id=p.brand_id
           AND q.revision_id=p.published_revision_id
         LEFT JOIN LATERAL (
           SELECT vp.id,vp.row_version,vp.currency,vp.amount_minor,vp.mrp_minor,vp.valid_from,vp.valid_to
             FROM catalogue.variant_prices vp WHERE vp.variant_id=v.id AND vp.brand_id=v.brand_id AND vp.price_state='APPROVED'
               AND vp.valid_from<=statement_timestamp() AND (vp.valid_to IS NULL OR vp.valid_to>statement_timestamp())
             ORDER BY vp.valid_from DESC,vp.created_at DESC,vp.id DESC LIMIT 1 FOR SHARE OF vp
         ) current_price ON true
         LEFT JOIN LATERAL (
           SELECT vp.id,vp.row_version,vp.valid_to FROM catalogue.variant_prices vp
            WHERE vp.id=$5 AND vp.variant_id=v.id AND vp.brand_id=v.brand_id AND vp.price_state='APPROVED'
              AND vp.valid_from<=statement_timestamp() LIMIT 1 FOR SHARE OF vp
         ) requested_price ON true
        WHERE p.id=$1 AND p.brand_id=$2
        FOR SHARE OF p,b,v,c,sv`,
      [request.productId, request.brandId, request.variantId, request.sku, request.expectedPriceId],
    );
    const row = result.rows[0];
    // A missing row intentionally covers unknown, cross-brand, and wrong-SKU requests alike.
    if (!row) return deny('NOT_BUYABLE');
    if (row.brand_state !== 'approved' || !row.category_eligible || row.variant_state !== 'ACTIVE'
      || row.publication_state !== 'PUBLISHED' || row.qc_state !== 'APPROVED'
      || !row.published_revision_id || !row.published_approval_id || row.published_approval_decision !== 'APPROVED'
      || row.revision_state !== 'APPROVED' || row.review_decision !== 'APPROVED'
      || !row.reviewer_user_id || row.reviewer_user_id === row.submitted_by || !row.content_snapshot || !row.revision_hash
      || snapshotSha256(row.content_snapshot) !== row.revision_hash.trim()) return deny('NOT_BUYABLE');

    const frozenVariants = Array.isArray(row.content_snapshot.variants) ? row.content_snapshot.variants : [];
    if (!frozenVariants.some((value) => value && typeof value === 'object'
      && (value as Record<string, unknown>).id === row.variant_id && (value as Record<string, unknown>).sku === row.sku)) return deny('NOT_BUYABLE');

    const publicationVersion = Number(row.publication_version);
    if (publicationVersion !== request.expectedPublicationVersion) return deny('STALE_PUBLICATION');
    if (row.requested_price_id && row.requested_price_expired) return deny('PRICE_EXPIRED');
    if (!row.current_price_id) {
      return deny('PRICE_UNAVAILABLE');
    }
    if (row.current_price_id !== request.expectedPriceId || Number(row.current_price_row_version) !== request.expectedPriceRowVersion) return deny('STALE_PRICE');
    const amountMinor = Number(row.current_amount_minor); const mrpMinor = Number(row.current_mrp_minor);
    const priceRowVersion = Number(row.current_price_row_version);
    if (row.current_currency !== 'INR' || ![amountMinor, mrpMinor, priceRowVersion].every(Number.isSafeInteger)
      || amountMinor < 0 || mrpMinor < 1 || amountMinor > mrpMinor) {
      return deny('PRICE_UNAVAILABLE');
    }
    const price = Object.freeze({ id: row.current_price_id, rowVersion: priceRowVersion, currency: 'INR' as const,
      amountMinor, mrpMinor, validFrom: row.current_valid_from!.toISOString(), validTo: row.current_valid_to?.toISOString() ?? null });
    return Object.freeze({ contractVersion: 1, decision: 'BUYABLE', code: 'BUYABLE', catalogEligible: true,
      stockAllocation: 'NOT_CHECKED', productId: row.product_id, variantId: row.variant_id, publicationVersion,
      revisionId: row.published_revision_id, price });
  }

}
