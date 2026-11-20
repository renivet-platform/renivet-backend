import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { Pool } from 'pg';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';

export type AdminReviewQueue = 'taxonomy' | 'quality' | 'pricing' | 'claims' | 'publishing';
const PERMISSIONS: Record<AdminReviewQueue, string> = {
  taxonomy: 'taxonomy.approve', quality: 'catalog.review', pricing: 'pricing.approve', claims: 'catalog.review', publishing: 'catalog.publish',
};

@Injectable()
export class AdminReviewReadRepository {
  constructor(private readonly infrastructure: IdentityInfrastructure) {}

  async list(queue: AdminReviewQueue, userId: string, limit: number): Promise<{ items: Record<string, unknown>[] }> {
    const permission = PERMISSIONS[queue];
    const statements: Record<AdminReviewQueue, string> = {
      taxonomy: `SELECT c.id AS "categoryId", c.code AS "categoryCode", c.name AS "categoryLabel", v.id AS "revisionId", v.version, v.ruleset_sha256 AS "rulesetSha256", v.validator_version AS "validatorVersion", v.created_at AS "submittedAt", submitter.actor_user_id AS "submittedBy", count(r.id)::int AS "ruleCount"
        FROM catalogue.category_schema_versions v JOIN catalogue.categories c ON c.id=v.category_id
        LEFT JOIN catalogue.category_schema_attribute_rules r ON r.schema_version_id=v.id
        LEFT JOIN LATERAL (SELECT actor_user_id FROM catalogue.taxonomy_admin_events e WHERE e.category_id=c.id AND e.schema_version=v.version AND e.action='propose' ORDER BY occurred_at DESC LIMIT 1) submitter ON true
        WHERE v.state='DRAFT' AND EXISTS(SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$1 AND ep.permission_code=$2 AND ep.role_code='renivet_admin' AND ep.scope_type='global' AND ep.brand_id IS NULL)
        GROUP BY c.id,v.id,submitter.actor_user_id ORDER BY v.created_at,v.id LIMIT $3`,
      quality: `SELECT p.id AS "productId", p.brand_id AS "brandId", b.display_name AS "brandName", p.style_code AS "styleCode", p.title, r.id AS "revisionId", r.content_version AS "contentVersion", r.content_sha256 AS "contentSha256", r.category_id AS "categoryId", r.category_schema_version AS "categorySchemaVersion", r.submitted_by AS "submittedBy", r.created_at AS "submittedAt", p.row_version AS "rowVersion", r.content_snapshot AS snapshot
        FROM catalogue.product_revisions r JOIN catalogue.products p ON p.id=r.product_id AND p.brand_id=r.brand_id JOIN brands.brands b ON b.id=p.brand_id AND b.onboarding_state='approved'
        WHERE r.review_state='SUBMITTED' AND p.publication_state='PENDING_REVIEW' AND EXISTS(SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$1 AND ep.permission_code=$2 AND ep.role_code='renivet_admin' AND ep.scope_type='global' AND ep.brand_id IS NULL)
        ORDER BY r.created_at,r.id LIMIT $3`,
      pricing: `SELECT vp.id AS "priceId", vp.brand_id AS "brandId", b.display_name AS "brandName", v.id AS "variantId", v.sku, p.id AS "productId", p.title, vp.amount_minor AS "amountMinor", vp.mrp_minor AS "mrpMinor", vp.currency, vp.valid_from AS "validFrom", vp.valid_to AS "validTo", vp.reason_code AS "reasonCode", vp.created_by AS "submittedBy", vp.row_version AS "rowVersion", vp.created_at AS "submittedAt"
        FROM catalogue.variant_prices vp JOIN catalogue.product_variants v ON v.id=vp.variant_id AND v.brand_id=vp.brand_id JOIN catalogue.products p ON p.id=v.product_id AND p.brand_id=v.brand_id JOIN brands.brands b ON b.id=vp.brand_id AND b.onboarding_state='approved'
        WHERE vp.price_state='PENDING' AND EXISTS(SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$1 AND ep.permission_code=$2 AND ep.role_code='renivet_admin' AND ep.scope_type='global' AND ep.brand_id IS NULL)
        ORDER BY vp.created_at,vp.id LIMIT $3`,
      claims: `SELECT c.id AS "claimId", c.brand_id AS "brandId", b.display_name AS "brandName", c.product_id AS "productId", p.title, c.revision_id AS "revisionId", c.claim_code AS "claimCode", c.claim_text AS "claimText", c.claim_state AS status, c.submitted_by AS "submittedBy", c.expires_at AS "expiresAt", c.row_version AS "rowVersion", c.created_at AS "submittedAt", count(e.id)::int AS "evidenceCount"
        FROM catalogue.sustainability_claims c JOIN catalogue.products p ON p.id=c.product_id AND p.brand_id=c.brand_id JOIN brands.brands b ON b.id=c.brand_id AND b.onboarding_state='approved' LEFT JOIN catalogue.claim_evidence e ON e.claim_id=c.id AND e.brand_id=c.brand_id AND e.product_id=c.product_id
        WHERE c.claim_state='PENDING' AND EXISTS(SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$1 AND ep.permission_code=$2 AND ep.role_code='renivet_admin' AND ep.scope_type='global' AND ep.brand_id IS NULL)
        GROUP BY c.id,b.display_name,p.title ORDER BY c.created_at,c.id LIMIT $3`,
      publishing: `SELECT p.id AS "productId", p.brand_id AS "brandId", b.display_name AS "brandName", p.title, p.style_code AS "styleCode", r.id AS "revisionId", q.id AS "approvalId", p.publication_state AS "publicationState", p.publication_version AS "publicationVersion", p.row_version AS "rowVersion", r.content_version AS "contentVersion", r.content_sha256 AS "contentSha256", r.submitted_by AS "submittedBy"
        FROM catalogue.products p JOIN brands.brands b ON b.id=p.brand_id AND b.onboarding_state='approved'
        JOIN LATERAL (SELECT candidate.* FROM catalogue.product_revisions candidate WHERE candidate.product_id=p.id AND candidate.brand_id=p.brand_id AND candidate.content_version=p.content_version AND candidate.review_state='APPROVED' AND (p.published_revision_id IS NULL OR p.published_revision_id=candidate.id) ORDER BY candidate.created_at DESC LIMIT 1) r ON true
        JOIN catalogue.product_qc_reviews q ON q.revision_id=r.id AND q.product_id=p.id AND q.brand_id=p.brand_id AND q.decision='APPROVED'
        WHERE p.publication_state IN('APPROVED','PUBLISHED','RESTRICTED') AND EXISTS(SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$1 AND ep.permission_code=$2 AND ep.role_code='renivet_admin' AND ep.scope_type='global' AND ep.brand_id IS NULL)
        ORDER BY p.updated_at,p.id LIMIT $3`,
    };
    return { items: await this.query(statements[queue], [userId, permission, limit]) };
  }

  async detail(queue: AdminReviewQueue, id: string, userId: string): Promise<Record<string, unknown> | null> {
    const permission = PERMISSIONS[queue];
    const statements: Record<AdminReviewQueue, string> = {
      taxonomy: `SELECT c.id AS "categoryId", c.code AS "categoryCode", c.name AS "categoryLabel", c.active, NOT EXISTS(SELECT 1 FROM catalogue.categories child WHERE child.parent_id=c.id) AS "isLeaf", (NOT c.active AND EXISTS(SELECT 1 FROM catalogue.category_availability_events e WHERE e.category_id=c.id AND e.active_after=false)) AS retired, v.id AS "revisionId", v.version, v.state, v.ruleset, v.ruleset_sha256 AS "rulesetSha256", v.validator_version AS "validatorVersion", v.created_at AS "submittedAt", submitter.actor_user_id AS "submittedBy", COALESCE(jsonb_agg(jsonb_build_object('code',r.attribute_code,'label',r.display_label,'scope',r.scope_type,'valueType',r.value_type,'allowedValues',r.allowed_values,'unitCode',r.unit_code,'requiredByDefault',r.required_by_default,'conditionalAst',r.conditional_ast,'minValues',r.min_values,'maxValues',r.max_values) ORDER BY r.attribute_code) FILTER (WHERE r.id IS NOT NULL),'[]'::jsonb) AS rules
        FROM catalogue.category_schema_versions v JOIN catalogue.categories c ON c.id=v.category_id LEFT JOIN catalogue.category_schema_attribute_rules r ON r.schema_version_id=v.id LEFT JOIN LATERAL (SELECT actor_user_id FROM catalogue.taxonomy_admin_events e WHERE e.category_id=c.id AND e.schema_version=v.version AND e.action='propose' ORDER BY occurred_at DESC LIMIT 1) submitter ON true
        WHERE v.id=$1 AND v.state='DRAFT' AND EXISTS(SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$2 AND ep.permission_code=$3 AND ep.role_code='renivet_admin' AND ep.scope_type='global' AND ep.brand_id IS NULL) GROUP BY c.id,v.id,submitter.actor_user_id`,
      quality: `SELECT p.id AS "productId",p.brand_id AS "brandId",b.display_name AS "brandName",p.title,p.style_code AS "styleCode",p.publication_state AS "publicationState",p.row_version AS "rowVersion",r.id AS "revisionId",r.content_version AS "contentVersion",r.content_sha256 AS "contentSha256",r.category_id AS "categoryId",r.category_schema_version AS "categorySchemaVersion",r.content_snapshot AS snapshot,r.submitted_by AS "submittedBy",r.created_at AS "submittedAt",COALESCE(jsonb_agg(jsonb_build_object('id',pm.id,'assetId',a.id,'displayRole',pm.display_role,'displayOrder',pm.display_order,'scanState',a.scan_state,'rightsState',a.rights_state) ORDER BY pm.display_order,pm.id) FILTER (WHERE pm.id IS NOT NULL),'[]'::jsonb) AS media
        FROM catalogue.product_revisions r JOIN catalogue.products p ON p.id=r.product_id AND p.brand_id=r.brand_id JOIN brands.brands b ON b.id=p.brand_id AND b.onboarding_state='approved' LEFT JOIN media.product_media pm ON pm.product_id=p.id AND pm.brand_id=p.brand_id AND pm.detached_at IS NULL LEFT JOIN media.media_assets a ON a.id=pm.media_asset_id AND a.brand_id=pm.brand_id
        WHERE r.id=$1 AND r.review_state='SUBMITTED' AND p.publication_state='PENDING_REVIEW' AND EXISTS(SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$2 AND ep.permission_code=$3 AND ep.role_code='renivet_admin' AND ep.scope_type='global' AND ep.brand_id IS NULL) GROUP BY p.id,b.display_name,r.id`,
      pricing: `SELECT vp.id AS "priceId",vp.brand_id AS "brandId",b.display_name AS "brandName",v.id AS "variantId",v.sku,p.id AS "productId",p.title,v.options,vp.amount_minor AS "amountMinor",vp.mrp_minor AS "mrpMinor",vp.currency,vp.valid_from AS "validFrom",vp.valid_to AS "validTo",vp.reason_code AS "reasonCode",vp.created_by AS "submittedBy",vp.row_version AS "rowVersion",vp.price_state AS status,vp.created_at AS "submittedAt",COALESCE((SELECT jsonb_agg(jsonb_build_object('id',h.id,'priceState',h.price_state,'amountMinor',h.amount_minor,'validFrom',h.valid_from,'validTo',h.valid_to,'decidedBy',h.decided_by,'decidedAt',h.decided_at,'decisionReasonCode',h.decision_reason_code) ORDER BY h.created_at DESC) FROM catalogue.variant_prices h WHERE h.variant_id=v.id AND h.brand_id=v.brand_id),'[]'::jsonb) AS history
        FROM catalogue.variant_prices vp JOIN catalogue.product_variants v ON v.id=vp.variant_id AND v.brand_id=vp.brand_id JOIN catalogue.products p ON p.id=v.product_id AND p.brand_id=v.brand_id JOIN brands.brands b ON b.id=vp.brand_id AND b.onboarding_state='approved'
        WHERE vp.id=$1 AND vp.price_state='PENDING' AND EXISTS(SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$2 AND ep.permission_code=$3 AND ep.role_code='renivet_admin' AND ep.scope_type='global' AND ep.brand_id IS NULL) GROUP BY vp.id,b.display_name,v.id,p.id`,
      claims: `SELECT c.id AS "claimId",c.brand_id AS "brandId",b.display_name AS "brandName",c.product_id AS "productId",p.title,c.revision_id AS "revisionId",c.claim_code AS "claimCode",c.claim_text AS "claimText",c.claim_state AS status,c.submitted_by AS "submittedBy",c.expires_at AS "expiresAt",c.row_version AS "rowVersion",c.created_at AS "submittedAt",COALESCE(jsonb_agg(jsonb_build_object('id',e.id,'issuer',e.issuer,'documentReference',e.document_reference,'evidenceState',e.evidence_state,'documentExpiresAt',e.document_expires_at,'recalledAt',e.recalled_at,'scanState',a.scan_state,'rightsState',a.rights_state,'derivativeState',a.derivative_state) ORDER BY e.created_at) FILTER (WHERE e.id IS NOT NULL),'[]'::jsonb) AS evidence
        FROM catalogue.sustainability_claims c JOIN catalogue.products p ON p.id=c.product_id AND p.brand_id=c.brand_id JOIN brands.brands b ON b.id=c.brand_id AND b.onboarding_state='approved' LEFT JOIN catalogue.claim_evidence e ON e.claim_id=c.id AND e.brand_id=c.brand_id AND e.product_id=c.product_id LEFT JOIN media.media_assets a ON a.id=e.media_asset_id AND a.brand_id=e.brand_id
        WHERE c.id=$1 AND c.claim_state='PENDING' AND EXISTS(SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$2 AND ep.permission_code=$3 AND ep.role_code='renivet_admin' AND ep.scope_type='global' AND ep.brand_id IS NULL) GROUP BY c.id,b.display_name,p.title`,
      publishing: `SELECT p.id AS "productId",p.brand_id AS "brandId",b.display_name AS "brandName",p.title,p.style_code AS "styleCode",p.publication_state AS "publicationState",p.publication_version AS "publicationVersion",p.row_version AS "rowVersion",r.id AS "revisionId",q.id AS "approvalId",r.content_version AS "contentVersion",r.content_sha256 AS "contentSha256",r.content_snapshot AS snapshot,r.submitted_by AS "submittedBy",q.reviewer_user_id AS "approvedBy",q.recorded_at AS "approvedAt",q.reason_code AS "approvalReasonCode"
        FROM catalogue.products p JOIN brands.brands b ON b.id=p.brand_id AND b.onboarding_state='approved'
        JOIN LATERAL (SELECT candidate.* FROM catalogue.product_revisions candidate WHERE candidate.product_id=p.id AND candidate.brand_id=p.brand_id AND candidate.content_version=p.content_version AND candidate.review_state='APPROVED' AND (p.published_revision_id IS NULL OR p.published_revision_id=candidate.id) ORDER BY candidate.created_at DESC LIMIT 1) r ON true
        JOIN catalogue.product_qc_reviews q ON q.revision_id=r.id AND q.product_id=p.id AND q.brand_id=p.brand_id AND q.decision='APPROVED'
        WHERE p.id=$1 AND p.publication_state IN('APPROVED','PUBLISHED','RESTRICTED') AND EXISTS(SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$2 AND ep.permission_code=$3 AND ep.role_code='renivet_admin' AND ep.scope_type='global' AND ep.brand_id IS NULL)`,
    };
    return (await this.query(statements[queue], [id, userId, permission]))[0] ?? null;
  }

  private async query(sql: string, values: unknown[]): Promise<Record<string, unknown>[]> {
    const pool: Pool | null = this.infrastructure.pool;
    if (!pool) throw new ServiceUnavailableException({ code: 'ADMIN_REVIEW_STORAGE_UNAVAILABLE', message: 'Review data is temporarily unavailable.' });
    try { const result = await pool.query(sql, values); return result.rows; }
    catch { throw new ServiceUnavailableException({ code: 'ADMIN_REVIEW_STORAGE_UNAVAILABLE', message: 'Review data is temporarily unavailable.' }); }
  }
}


