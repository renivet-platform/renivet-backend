import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';
import { canonicalizeSnapshot, snapshotSha256 } from './catalog-submission';
import { CatalogPublicationRepository, PublicationCommandContext, PublishRevisionInput, ReasonedPublicationInput } from './catalog-publication';

type Operation = 'PUBLISH' | 'RESTRICT' | 'UNPUBLISH';
type PublicationTarget = {
  id: string; brand_id: string; publication_state: string; qc_state: string; row_version: string | number;
  publication_version: string | number; content_version: number; category_id: string; category_schema_version: number;
  published_revision_id: string | null; published_approval_id: string | null; published_approval_decision: string | null;
  revision_id: string | null; review_id: string | null; revision_hash: string | null; review_decision: string | null;
};
function fail(code: string): Error { return Object.assign(new Error(code), { code }); }
function idOf(value: unknown): string | null { return value && typeof value === 'object' && 'id' in value ? String((value as { id: unknown }).id) : null; }

@Injectable()
export class CatalogPublicationPostgresRepository implements CatalogPublicationRepository {
  constructor(private readonly infrastructure: IdentityInfrastructure) {}
  publish(productId: string, input: PublishRevisionInput, context: PublicationCommandContext): Promise<Record<string, unknown>> {
    return this.execute('PUBLISH', productId, input, context);
  }
  restrict(productId: string, input: ReasonedPublicationInput, context: PublicationCommandContext): Promise<Record<string, unknown>> {
    return this.execute('RESTRICT', productId, input, context);
  }
  unpublish(productId: string, input: ReasonedPublicationInput, context: PublicationCommandContext): Promise<Record<string, unknown>> {
    return this.execute('UNPUBLISH', productId, input, context);
  }

  private async execute(operation: Operation, productId: string, input: PublishRevisionInput | ReasonedPublicationInput,
    context: PublicationCommandContext): Promise<Record<string, unknown>> {
    try {
      return await this.transaction(async (client) => {
        const permissionCode = operation === 'PUBLISH' ? 'catalog.publish' : 'catalog.restrict';
        const permission = `EXISTS(SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$2 AND ep.permission_code=$4
          AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$1)))`;
        const requestHash = createHash('sha256').update(canonicalizeSnapshot({ operation, productId, brandId: context.brandId,
          expectedProductVersion: context.expectedProductVersion, input })).digest('hex');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [`${context.brandId}:${productId}:${context.userId}:${operation}:${context.idempotencyKey}`]);
        const replay = await client.query<{ request_sha256: string; response_payload: Record<string, unknown> }>(
          `SELECT r.request_sha256,r.response_payload FROM catalogue.publication_command_receipts r
            JOIN catalogue.products p ON p.id=r.product_id AND p.brand_id=r.brand_id
            JOIN brands.brands b ON b.id=r.brand_id AND b.onboarding_state='approved'
           WHERE r.brand_id=$1 AND r.product_id=$3 AND r.actor_user_id=$2 AND r.operation=$5 AND r.idempotency_key=$6
             AND ${permission}`,
          [context.brandId, context.userId, productId, permissionCode, operation, context.idempotencyKey]);
        if (replay.rows[0]) {
          if (replay.rows[0].request_sha256.trim() !== requestHash) throw fail('CATALOG_PUBLICATION_IDEMPOTENCY_CONFLICT');
          return replay.rows[0].response_payload;
        }

        const selected = await client.query<PublicationTarget>(
          `SELECT p.id,p.brand_id,p.publication_state,p.qc_state,p.row_version,p.publication_version,p.content_version,
                  p.category_id,p.category_schema_version,p.published_revision_id,p.published_approval_id,p.published_approval_decision,
                  p.published_revision_id AS revision_id,p.published_approval_id AS review_id,
                  r.content_sha256 AS revision_hash,q.decision AS review_decision
             FROM catalogue.products p JOIN brands.brands b ON b.id=p.brand_id AND b.onboarding_state='approved'
             LEFT JOIN catalogue.product_revisions r ON r.id=p.published_revision_id AND r.product_id=p.id AND r.brand_id=p.brand_id
             LEFT JOIN catalogue.product_qc_reviews q ON q.id=p.published_approval_id AND q.revision_id=p.published_revision_id
               AND q.product_id=p.id AND q.brand_id=p.brand_id
            WHERE p.id=$3 AND p.brand_id=$1 AND ${permission}
            FOR UPDATE OF p,b`, [context.brandId, context.userId, productId, permissionCode]);
        const product = selected.rows[0];
        if (!product) throw fail('CATALOG_PUBLICATION_NOT_FOUND');
        if (Number(product.row_version) !== context.expectedProductVersion) throw fail('CATALOG_PUBLICATION_VERSION_CONFLICT');

        let revisionId: string; let reviewId: string; let contentVersion: number; let revisionHash: string;
        if (operation === 'PUBLISH') {
          if (product.publication_state !== 'APPROVED' || product.qc_state !== 'APPROVED') throw fail('CATALOG_PUBLICATION_STATE_CONFLICT');
          const requested = input as PublishRevisionInput;
          const approval = await client.query<{ id: string; product_id: string; brand_id: string; review_state: string;
            content_version: number; content_snapshot: Record<string, unknown>; content_sha256: string; submitted_by: string;
            reviewer_user_id: string; category_id: string; category_schema_version: number }>(
            `SELECT r.id,r.product_id,r.brand_id,r.review_state,r.content_version,r.content_snapshot,r.content_sha256,r.submitted_by,
                    r.category_id,r.category_schema_version,q.reviewer_user_id
               FROM catalogue.product_revisions r JOIN catalogue.product_qc_reviews q
                 ON q.revision_id=r.id AND q.product_id=r.product_id AND q.brand_id=r.brand_id
              WHERE r.id=$1 AND r.product_id=$2 AND r.brand_id=$3 AND q.id=$4 AND q.decision='APPROVED'
                AND r.review_state='APPROVED' AND q.reviewer_user_id<>r.submitted_by
              FOR SHARE OF r,q`, [requested.approvedRevisionId, productId, context.brandId, requested.approvedReviewId]);
          const approved = approval.rows[0];
          if (!approved) throw fail('CATALOG_PUBLICATION_APPROVAL_INVALID');
          if (Number(approved.content_version) !== Number(product.content_version)
            || approved.category_id !== product.category_id || Number(approved.category_schema_version) !== Number(product.category_schema_version)) {
            throw fail('CATALOG_PUBLICATION_STATE_CONFLICT');
          }
          if (snapshotSha256(approved.content_snapshot) !== approved.content_sha256.trim()) throw fail('CATALOG_PUBLICATION_APPROVAL_INVALID');
          await this.validateSnapshot(client, context.brandId, productId, approved.id, approved.content_snapshot, approved.category_id, approved.category_schema_version);
          revisionId = approved.id; reviewId = requested.approvedReviewId; contentVersion = Number(approved.content_version);
          revisionHash = approved.content_sha256.trim();
        } else {
          if ((product.publication_state !== 'PUBLISHED' && !(operation === 'UNPUBLISH' && product.publication_state === 'RESTRICTED'))
            || !product.published_revision_id || !product.published_approval_id
            || product.published_approval_decision !== 'APPROVED' || product.review_decision !== 'APPROVED' || !product.revision_hash) {
            throw fail('CATALOG_PUBLICATION_STATE_CONFLICT');
          }
          revisionId = product.published_revision_id; reviewId = product.published_approval_id;
          contentVersion = Number(product.content_version); revisionHash = product.revision_hash;
        }

        const nextState = operation === 'PUBLISH' ? 'PUBLISHED' : operation === 'RESTRICT' ? 'RESTRICTED' : 'APPROVED';
        const lifecycle = operation;
        const updated = await client.query<{ row_version: string | number; publication_version: string | number }>(
          `UPDATE catalogue.products p SET publication_state=$5,
              published_revision_id=CASE WHEN $5='PUBLISHED' THEN $6::uuid ELSE p.published_revision_id END,
              published_approval_id=CASE WHEN $5='PUBLISHED' THEN $7::uuid ELSE p.published_approval_id END,
              published_approval_decision=CASE WHEN $5='PUBLISHED' THEN 'APPROVED' ELSE p.published_approval_decision END,
              publication_version=p.publication_version+1,row_version=p.row_version+1,updated_at=now()
            WHERE p.id=$1 AND p.brand_id=$2 AND p.row_version=$3 AND p.publication_state=$8
              AND EXISTS(SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$4 AND ep.permission_code=$9
                AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$2)))
            RETURNING p.row_version,p.publication_version`,
          [productId, context.brandId, context.expectedProductVersion, context.userId, nextState,
            operation === 'PUBLISH' ? revisionId : null, operation === 'PUBLISH' ? reviewId : null,
            product.publication_state, permissionCode]);
        if (!updated.rows[0]) throw fail('CATALOG_PUBLICATION_ACCESS_DENIED');
        const rowVersion = Number(updated.rows[0].row_version); const publicationVersion = Number(updated.rows[0].publication_version);
        const eventId = randomUUID();
        const reasonCode = operation === 'PUBLISH' ? 'QC_APPROVED' : (input as ReasonedPublicationInput).reasonCode;
        const appealReference = operation === 'PUBLISH' ? null : ((input as ReasonedPublicationInput).appealReference ?? null);
        const comment = operation === 'PUBLISH' ? null : ((input as ReasonedPublicationInput).comment ?? null);
        const eventType = operation === 'PUBLISH' ? 'catalogue.product.published'
          : operation === 'RESTRICT' ? 'catalogue.product.restricted' : 'catalogue.product.unpublished';
        const payload = { eventId, lifecycleEvent: lifecycle, brandId: context.brandId, productId, revisionId, reviewId,
          contentVersion, publicationVersion, publicationState: nextState, contentSha256: revisionHash, reasonCode, appealReference };
        const payloadSha256 = createHash('sha256').update(canonicalizeSnapshot(payload)).digest('hex');
        await client.query(`INSERT INTO platform.outbox_events(id,aggregate_type,aggregate_id,event_type,event_version,event_payload,event_key)
          VALUES($1,'catalogue.product',$2,$3,1,$4::jsonb,$5)`,
        [eventId, productId, eventType, JSON.stringify({ ...payload, payloadSha256 }), `catalogue-publication:${productId}:${publicationVersion}`]);
        await client.query(`INSERT INTO catalogue.publication_events
          (brand_id,product_id,content_version,revision_id,approved_review_id,approved_decision,payload_sha256,
           publication_version,lifecycle_event,event_id,actor_user_id,reason_code,appeal_reference,comment)
          VALUES($1,$2,$3,$4,$5,'APPROVED',$6,$7,$8,$9,$10,$11,$12,$13)`,
        [context.brandId, productId, contentVersion, revisionId, reviewId, payloadSha256, publicationVersion, lifecycle,
          eventId, context.userId, reasonCode, appealReference, comment]);
        const response = { productId, revisionId, reviewId, publicationVersion, status: nextState, outboxEventId: eventId, rowVersion };
        await client.query(`INSERT INTO catalogue.publication_command_receipts
          (brand_id,product_id,actor_user_id,operation,idempotency_key,request_sha256,publication_event_id,response_payload)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
        [context.brandId, productId, context.userId, lifecycle, context.idempotencyKey, requestHash, eventId, JSON.stringify(response)]);
        return response;
      });
    } catch (error) {
      const code = (error as { code?: string; message?: string } | null)?.code;
      const message = (error as { message?: string } | null)?.message ?? '';
      if (code === '23505') throw fail('CATALOG_PUBLICATION_ALREADY_APPLIED');
      if (code === '23503') throw fail('CATALOG_PUBLICATION_APPROVAL_INVALID');
      if (code === '23514') {
        if (message.includes('CATALOG_PUBLICATION_APPROVAL_REQUIRED')) throw fail('CATALOG_PUBLICATION_APPROVAL_INVALID');
        if (message.includes('MEDIA') || message.includes('PRODUCT_MEDIA')) throw fail('CATALOG_PUBLICATION_MEDIA_INVALID');
        throw fail('CATALOG_PUBLICATION_STATE_CONFLICT');
      }
      if (code === '42501') throw fail('CATALOG_PUBLICATION_ACCESS_DENIED');
      if (['08000','08003','08006','08001','08004','08007','ECONNREFUSED','ECONNRESET','ETIMEDOUT','57P01'].includes(code ?? '')) {
        throw fail('CATALOG_PUBLICATION_DATABASE_UNAVAILABLE');
      }
      throw error;
    }
  }

  private async validateSnapshot(client: PoolClient, brandId: string, productId: string, revisionId: string, snapshot: Record<string, unknown>, categoryId: string,
    schemaVersion: number): Promise<void> {
    const product = snapshot.product as Record<string, unknown> | undefined;
    if (product?.id !== productId || product?.brandId !== brandId || !Array.isArray(snapshot.variants)
      || (snapshot.variants as unknown[]).length === 0 || !Array.isArray(snapshot.media) || (snapshot.media as unknown[]).length === 0
      || !Array.isArray(snapshot.claims) || Number(product.categorySchemaVersion) !== Number(schemaVersion)) {
      throw fail('CATALOG_PUBLICATION_APPROVAL_INVALID');
    }
    const category = await client.query(`SELECT 1 FROM catalogue.categories c
      JOIN catalogue.category_schema_versions sv ON sv.category_id=c.id AND sv.version=$2 AND sv.state='PUBLISHED'
      WHERE c.id=$1 AND c.active AND NOT EXISTS(SELECT 1 FROM catalogue.categories child WHERE child.parent_id=c.id)`, [categoryId, schemaVersion]);
    if (category.rowCount !== 1) throw fail('CATALOG_PUBLICATION_CATEGORY_INVALID');
    for (const item of snapshot.variants as Array<Record<string, unknown>>) {
      const pinnedPriceId = idOf(item.approvedPrice);
      if (typeof item.id !== 'string' || !pinnedPriceId) throw fail('CATALOG_PUBLICATION_PRICE_INVALID');
      const price = await client.query(`SELECT 1 FROM catalogue.product_variants v JOIN catalogue.variant_prices vp
        ON vp.variant_id=v.id AND vp.brand_id=v.brand_id WHERE v.id=$1 AND v.product_id=$2 AND v.brand_id=$3
          AND v.variant_state<>'INACTIVE' AND vp.id=$4 AND vp.price_state='APPROVED'
          AND vp.valid_from<=now() AND (vp.valid_to IS NULL OR vp.valid_to>now()) FOR SHARE OF v,vp`,
      [item.id, productId, brandId, pinnedPriceId]);
      if (price.rowCount !== 1) throw fail('CATALOG_PUBLICATION_PRICE_INVALID');
    }
    for (const item of snapshot.media as Array<Record<string, unknown>>) {
      const media = await client.query(`SELECT 1 FROM media.product_media pm JOIN media.media_assets a ON a.id=pm.media_asset_id AND a.brand_id=pm.brand_id
        WHERE pm.id=$1 AND pm.brand_id=$2 AND pm.product_id=$3 AND pm.media_asset_id=$4 AND pm.detached_at IS NULL
          AND a.scan_state='CLEAN' AND a.derivative_state='READY' AND a.rights_state IN('ATTESTED','REVIEWED')
          AND EXISTS(SELECT 1 FROM media.media_derivatives d WHERE d.brand_id=a.brand_id AND d.media_asset_id=a.id AND d.derivative_kind='PREVIEW')
          AND EXISTS(SELECT 1 FROM media.media_derivatives d WHERE d.brand_id=a.brand_id AND d.media_asset_id=a.id AND d.derivative_kind='THUMBNAIL')
        FOR SHARE OF pm,a`, [item.id, brandId, productId, item.assetId]);
      if (typeof item.id !== 'string' || typeof item.assetId !== 'string' || media.rowCount !== 1) throw fail('CATALOG_PUBLICATION_MEDIA_INVALID');
    }
    for (const claim of snapshot.claims as Array<Record<string, unknown>>) {
      if (claim.state === 'REJECTED') continue;
      if (claim.revisionId !== revisionId) throw fail('CATALOG_PUBLICATION_EVIDENCE_INVALID');
      const verified = await client.query(`SELECT c.id FROM catalogue.sustainability_claims c
        WHERE c.id=$1 AND c.brand_id=$2 AND c.product_id=$3 AND c.revision_id=$4 AND c.claim_state='VERIFIED'
          AND (c.expires_at IS NULL OR c.expires_at>now()) FOR SHARE OF c`, [claim.id, brandId, productId, revisionId]);
      if (claim.state !== 'VERIFIED' || verified.rowCount !== 1) throw fail('CATALOG_PUBLICATION_EVIDENCE_INVALID');
      const evidence = await client.query(`SELECT e.id FROM catalogue.claim_evidence e JOIN media.media_assets a
        ON a.id=e.media_asset_id AND a.brand_id=e.brand_id WHERE e.claim_id=$1 AND e.brand_id=$2 AND e.product_id=$3
          AND e.evidence_state='ACCEPTED' AND (e.document_expires_at IS NULL OR e.document_expires_at>now())
          AND a.scan_state='CLEAN' AND a.derivative_state='READY' AND a.rights_state IN('ATTESTED','REVIEWED')
        FOR SHARE OF e,a`, [claim.id, brandId, productId]);
      if (evidence.rowCount === 0) throw fail('CATALOG_PUBLICATION_EVIDENCE_INVALID');
    }
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const pool = this.infrastructure.pool;
    if (!pool) throw fail('CATALOG_PUBLICATION_DATABASE_UNAVAILABLE');
    let client: PoolClient;
    try { client = await pool.connect(); } catch { throw fail('CATALOG_PUBLICATION_DATABASE_UNAVAILABLE'); }
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { try { await client.query('ROLLBACK'); } catch { throw fail('CATALOG_PUBLICATION_DATABASE_UNAVAILABLE'); } throw error; }
    finally { client.release(); }
  }
}
