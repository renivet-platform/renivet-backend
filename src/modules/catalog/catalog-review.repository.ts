import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';
import { canonicalizeSnapshot, snapshotSha256 } from './catalog-submission';
import { CatalogReviewContext, CatalogReviewDecision, CatalogReviewInput, CatalogReviewRepository } from './catalog-review';

function fail(code: string): Error { return Object.assign(new Error(code), { code }); }
function idOf(value: unknown): string | null { return value && typeof value === 'object' && 'id' in value ? String((value as { id: unknown }).id) : null; }

@Injectable()
export class CatalogReviewPostgresRepository implements CatalogReviewRepository {
  constructor(private readonly infrastructure: IdentityInfrastructure) {}

  async decide(productId: string, input: CatalogReviewInput, context: CatalogReviewContext): Promise<Record<string, unknown>> {
    try {
      return await this.transaction(async (client) => {
        const requestHash = createHash('sha256').update(canonicalizeSnapshot({ productId, brandId: context.brandId, input })).digest('hex');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [`${context.brandId}:${productId}:${context.userId}:decideCatalogReview:${context.idempotencyKey}`]);
        const permission = `EXISTS(SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$2
          AND ep.permission_code='catalog.review' AND ep.scope_type='global' AND ep.brand_id IS NULL)`;
        const replay = await client.query<{ request_sha256: string; response_payload: Record<string, unknown> }>(
          `SELECT r.request_sha256,r.response_payload FROM catalogue.product_review_decision_receipts r
            JOIN catalogue.products p ON p.id=r.product_id AND p.brand_id=r.brand_id
            JOIN brands.brands b ON b.id=r.brand_id AND b.onboarding_state='approved'
           WHERE r.brand_id=$1 AND r.product_id=$3 AND r.actor_user_id=$2 AND r.idempotency_key=$4 AND ${permission}`,
          [context.brandId, context.userId, productId, context.idempotencyKey]);
        if (replay.rows[0]) {
          if (replay.rows[0].request_sha256.trim() !== requestHash) throw fail('CATALOG_REVIEW_IDEMPOTENCY_CONFLICT');
          return replay.rows[0].response_payload;
        }

        const selected = await client.query<{ brand_id: string; row_version: string | number; content_version: number;
          publication_state: string; qc_state: string; submitted_by: string; review_state: string; content_snapshot: Record<string, unknown>;
          content_sha256: string; category_id: string; category_schema_version: number }>(
          `SELECT p.brand_id,p.row_version,p.content_version,p.publication_state,p.qc_state,
                  r.submitted_by,r.review_state,r.content_snapshot,r.content_sha256,r.category_id,r.category_schema_version
             FROM catalogue.products p
             JOIN brands.brands b ON b.id=p.brand_id AND b.onboarding_state='approved'
             JOIN catalogue.product_revisions r ON r.id=$4 AND r.product_id=p.id AND r.brand_id=p.brand_id
            WHERE p.id=$3 AND p.brand_id=$1 AND ${permission}
            FOR UPDATE OF p,r,b`, [context.brandId, context.userId, productId, input.expectedRevisionId]);
        const target = selected.rows[0];
        if (!target) throw fail('CATALOG_REVIEW_NOT_FOUND');
        if (target.submitted_by === context.userId) throw fail('CATALOG_REVIEW_MAKER_CHECKER_CONFLICT');
        if (Number(target.row_version) !== input.expectedRowVersion) throw fail('CATALOG_REVIEW_VERSION_CONFLICT');
        if (target.review_state !== 'SUBMITTED' || target.publication_state !== 'PENDING_REVIEW'
          || Number((target.content_snapshot.product as Record<string, unknown> | undefined)?.contentVersion) !== target.content_version) {
          throw fail('CATALOG_REVIEW_STATE_CONFLICT');
        }
        if (snapshotSha256(target.content_snapshot) !== target.content_sha256.trim()) throw fail('CATALOG_REVIEW_STATE_CONFLICT');
        await this.validateSnapshot(client, target.brand_id, productId, target.content_snapshot);

        const nextState = input.decision as CatalogReviewDecision;
        const revision = await client.query(
          `UPDATE catalogue.product_revisions r SET review_state=$5
            WHERE r.id=$1 AND r.product_id=$2 AND r.brand_id=$3 AND r.review_state='SUBMITTED'
              AND EXISTS(SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$4
                AND ep.permission_code='catalog.review' AND ep.scope_type='global' AND ep.brand_id IS NULL)
            RETURNING r.id`, [input.expectedRevisionId, productId, context.brandId, context.userId, nextState]);
        if (revision.rowCount !== 1) throw fail('CATALOG_REVIEW_ACCESS_DENIED');
        const review = await client.query<{ id: string }>(
          `INSERT INTO catalogue.product_qc_reviews
            (brand_id,product_id,revision_id,reviewer_user_id,decision,reason_code,comment)
           VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [context.brandId, productId, input.expectedRevisionId, context.userId, nextState, input.reasonCode, input.comment ?? null]);
        const publicationState = nextState === 'APPROVED' ? 'APPROVED'
          : nextState === 'REJECTED' ? 'REJECTED'
            : nextState === 'CORRECTION_REQUIRED' || nextState === 'RESTRICTED' ? 'RE_REVIEW' : target.publication_state;
        const updated = await client.query<{ row_version: string | number }>(
          `UPDATE catalogue.products p SET qc_state=$5,publication_state=$6,row_version=p.row_version+1,updated_at=now()
            WHERE p.id=$1 AND p.brand_id=$2 AND p.row_version=$3 AND p.publication_state='PENDING_REVIEW'
              AND EXISTS(SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$4
                AND ep.permission_code='catalog.review' AND ep.scope_type='global' AND ep.brand_id IS NULL)
            RETURNING p.row_version`, [productId, context.brandId, input.expectedRowVersion, context.userId, nextState, publicationState]);
        if (!updated.rows[0]) throw fail('CATALOG_REVIEW_ACCESS_DENIED');
        const afterVersion = Number(updated.rows[0].row_version);
        await client.query(
          `INSERT INTO catalogue.product_qc_review_events
            (brand_id,product_id,revision_id,decision_id,reviewer_user_id,decision,reason_code,previous_review_state,next_review_state,product_row_version,reviewer_comment)
           VALUES($1,$2,$3,$4,$5,$6,$7,'SUBMITTED',$6,$8,$9)`,
          [context.brandId, productId, input.expectedRevisionId, review.rows[0].id, context.userId, nextState, input.reasonCode, afterVersion, input.comment ?? null]);
        const response = { decisionId: review.rows[0].id, productId, brandId: context.brandId, revisionId: input.expectedRevisionId,
          decision: nextState, reasonCode: input.reasonCode, reviewState: nextState, publicationState,
          rowVersion: afterVersion };
        const receipt = await client.query(
          `INSERT INTO catalogue.product_review_decision_receipts
            (brand_id,product_id,revision_id,actor_user_id,idempotency_key,request_sha256,decision,decision_id,response_payload)
           SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb
            WHERE EXISTS(SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$4
              AND ep.permission_code='catalog.review' AND ep.scope_type='global' AND ep.brand_id IS NULL)`,
          [context.brandId, productId, input.expectedRevisionId, context.userId, context.idempotencyKey, requestHash,
            nextState, review.rows[0].id, JSON.stringify(response)]);
        if (receipt.rowCount !== 1) throw fail('CATALOG_REVIEW_ACCESS_DENIED');
        return response;
      });
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === '23505') throw fail('CATALOG_REVIEW_ALREADY_DECIDED');
      if (code === '23503' || code === '23514' || code?.startsWith('22')) throw fail('CATALOG_REVIEW_STATE_CONFLICT');
      if (code === '40001' || code === '40P01') throw fail('CATALOG_REVIEW_VERSION_CONFLICT');
      if (code?.startsWith('08') || ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','57P01'].includes(code ?? '')) throw fail('CATALOG_REVIEW_DATABASE_UNAVAILABLE');
      throw error;
    }
  }

  private async validateSnapshot(client: PoolClient, brandId: string, productId: string, snapshot: Record<string, unknown>): Promise<void> {
    const product = snapshot.product as Record<string, unknown> | undefined;
    if (product?.id !== productId || product?.brandId !== brandId || !Array.isArray(snapshot.variants)
      || !Array.isArray(snapshot.media) || !Array.isArray(snapshot.claims)) throw fail('CATALOG_REVIEW_STATE_CONFLICT');
    if ((snapshot.variants as unknown[]).length === 0) throw fail('CATALOG_REVIEW_PRICE_INVALID');

    for (const item of snapshot.variants as Array<Record<string, unknown>>) {
      const variantId = item.id;
      const pinnedPriceId = idOf(item.approvedPrice);
      if (typeof variantId !== 'string' || !pinnedPriceId) throw fail('CATALOG_REVIEW_PRICE_INVALID');
      const price = await client.query(
        `SELECT 1 FROM catalogue.product_variants v JOIN catalogue.variant_prices vp
           ON vp.variant_id=v.id AND vp.brand_id=v.brand_id
          WHERE v.id=$1 AND v.product_id=$2 AND v.brand_id=$3 AND v.variant_state<>'INACTIVE'
            AND vp.id=$4 AND vp.price_state='APPROVED' AND vp.valid_from<=now() AND (vp.valid_to IS NULL OR vp.valid_to>now())
          FOR SHARE OF v,vp`,
        [variantId, productId, brandId, pinnedPriceId]);
      if (price.rowCount !== 1) throw fail('CATALOG_REVIEW_PRICE_INVALID');
    }

    for (const item of snapshot.media as Array<Record<string, unknown>>) {
      if (typeof item.id !== 'string' || typeof item.assetId !== 'string') throw fail('CATALOG_REVIEW_MEDIA_INVALID');
      const media = await client.query(
        `SELECT 1 FROM media.product_media pm JOIN media.media_assets a ON a.id=pm.media_asset_id AND a.brand_id=pm.brand_id
          WHERE pm.id=$1 AND pm.brand_id=$2 AND pm.product_id=$3 AND pm.media_asset_id=$4 AND pm.detached_at IS NULL
            AND a.scan_state='CLEAN' AND a.derivative_state='READY' AND a.rights_state IN('ATTESTED','REVIEWED')
            AND EXISTS(SELECT 1 FROM media.media_derivatives d WHERE d.brand_id=a.brand_id AND d.media_asset_id=a.id AND d.derivative_kind='PREVIEW')
            AND EXISTS(SELECT 1 FROM media.media_derivatives d WHERE d.brand_id=a.brand_id AND d.media_asset_id=a.id AND d.derivative_kind='THUMBNAIL')
          FOR SHARE OF pm,a`,
        [item.id, brandId, productId, item.assetId]);
      if (media.rowCount !== 1) throw fail('CATALOG_REVIEW_MEDIA_INVALID');
    }
    if ((snapshot.media as unknown[]).length === 0) throw fail('CATALOG_REVIEW_MEDIA_INVALID');

    for (const item of snapshot.claims as Array<Record<string, unknown>>) {
      if (item.state === 'REJECTED') continue;
      if (item.state !== 'VERIFIED' || (item.expiresAt && new Date(String(item.expiresAt)).getTime() <= Date.now())) {
        throw fail('CATALOG_REVIEW_EVIDENCE_INVALID');
      }
      const claim = await client.query(
        `SELECT c.id FROM catalogue.sustainability_claims c
          WHERE c.id=$1 AND c.brand_id=$2 AND c.product_id=$3 AND c.claim_state='VERIFIED'
            AND (c.expires_at IS NULL OR c.expires_at>now())
          FOR SHARE OF c`,
        [item.id, brandId, productId]);
      if (claim.rowCount !== 1) throw fail('CATALOG_REVIEW_EVIDENCE_INVALID');
      const evidence = await client.query(
        `SELECT e.id FROM catalogue.claim_evidence e JOIN media.media_assets a ON a.id=e.media_asset_id AND a.brand_id=e.brand_id
          WHERE e.claim_id=$1 AND e.brand_id=$2 AND e.product_id=$3 AND e.evidence_state='ACCEPTED'
            AND (e.document_expires_at IS NULL OR e.document_expires_at>now())
            AND a.scan_state='CLEAN' AND a.derivative_state='READY' AND a.rights_state IN('ATTESTED','REVIEWED')
          FOR SHARE OF e,a`, [item.id, brandId, productId]);
      if (evidence.rowCount === 0) throw fail('CATALOG_REVIEW_EVIDENCE_INVALID');
    }
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const pool = this.infrastructure.pool;
    if (!pool) throw fail('CATALOG_REVIEW_DATABASE_UNAVAILABLE');
    let client: PoolClient;
    try { client = await pool.connect(); } catch { throw fail('CATALOG_REVIEW_DATABASE_UNAVAILABLE'); }
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { try { await client.query('ROLLBACK'); } catch { throw fail('CATALOG_REVIEW_DATABASE_UNAVAILABLE'); } throw error; }
    finally { client.release(); }
  }
}
