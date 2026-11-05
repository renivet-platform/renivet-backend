import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PoolClient } from 'pg';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';
import { ClaimDecisionContext, ClaimDecisionInput, ClaimMutationContext, ClaimProposal, ClaimReadContext, ClaimsError, ClaimsRepository } from './claims.service';

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

@Injectable()
export class ClaimsPostgresRepository implements ClaimsRepository {
  constructor(private readonly infrastructure: IdentityInfrastructure) {}

  async propose(productId: string, proposal: ClaimProposal, expectedVersion: number, context: ClaimMutationContext): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const requestHash = hash({ productId, proposal, expectedVersion });
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`${context.brandId}:${context.userId}:proposeProductClaim:${context.idempotencyKey}`]);
      const replay = await client.query<{ request_sha256: string; response_payload: Record<string, unknown> }>(
        `SELECT r.request_sha256,r.response_payload FROM catalogue.claim_mutation_receipts r
          JOIN catalogue.products p ON p.id=r.product_id AND p.brand_id=r.brand_id
          JOIN brands.brands b ON b.id=r.brand_id AND b.onboarding_state='approved'
         WHERE r.brand_id=$1 AND r.product_id=$2 AND r.actor_user_id=$3 AND r.operation='proposeProductClaim'
           AND r.idempotency_key=$4 AND EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$3
             AND ep.permission_code=$5 AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$1)))`,
        [context.brandId, productId, context.userId, context.idempotencyKey, context.permission]);
      if (replay.rows[0]) {
        if (replay.rows[0].request_sha256.trim() !== requestHash) throw new ClaimsError('CLAIM_IDEMPOTENCY_CONFLICT');
        return replay.rows[0].response_payload;
      }

      const product = await client.query<{ row_version: string | number; revision_id: string | null }>(
        `SELECT p.row_version,p.published_revision_id AS revision_id FROM catalogue.products p
          JOIN brands.brands b ON b.id=p.brand_id AND b.onboarding_state='approved'
         WHERE p.id=$1 AND p.brand_id=$2
           AND EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$3 AND ep.permission_code=$4
             AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$2)))
         FOR UPDATE OF p`, [productId, context.brandId, context.userId, context.permission]);
      const target = product.rows[0];
      if (!target) throw new ClaimsError('CLAIM_PRODUCT_NOT_FOUND');
      if (Number(target.row_version) !== expectedVersion) throw new ClaimsError('CLAIM_VERSION_CONFLICT');
      if (!target.revision_id) throw new ClaimsError('CLAIM_REVISION_REQUIRED');

      const assets = await client.query<{ id: string }>(
        `SELECT a.id FROM media.media_assets a
          JOIN brands.brands b ON b.id=a.brand_id AND b.onboarding_state='approved'
         WHERE a.brand_id=$1 AND a.id=ANY($2::uuid[]) AND a.scan_state='CLEAN'
           AND a.derivative_state='READY' AND a.rights_state IN ('ATTESTED','REVIEWED')`,
        [context.brandId, proposal.evidenceAssetIds]);
      if (assets.rowCount !== proposal.evidenceAssetIds.length) throw new ClaimsError('CLAIM_EVIDENCE_NOT_ACCESSIBLE');

      const inserted = await client.query<{ id: string; row_version: number }>(
        `INSERT INTO catalogue.sustainability_claims
           (brand_id,product_id,revision_id,claim_code,claim_text,claim_state,expires_at,submitted_by)
         SELECT $1,$2,$3,$4,$5,'PENDING',$6::timestamptz,$7
          WHERE EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$8 AND ep.permission_code=$9
            AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$1)))
         RETURNING id,row_version`,
        [context.brandId, productId, target.revision_id, proposal.claimCode, proposal.claimText, proposal.expiresAt, context.userId, context.userId, context.permission]);
      const claim = inserted.rows[0];
      if (!claim) throw new ClaimsError('CLAIM_PERMISSION_REVOKED');
      for (const assetId of proposal.evidenceAssetIds) {
        const evidence = await client.query(
          `INSERT INTO catalogue.claim_evidence (brand_id,product_id,claim_id,media_asset_id,evidence_state)
           SELECT $1,$2,$3,a.id,'PENDING' FROM media.media_assets a
            WHERE a.id=$4 AND a.brand_id=$1 AND a.scan_state='CLEAN' AND a.derivative_state='READY'
              AND a.rights_state IN ('ATTESTED','REVIEWED')`,
          [context.brandId, productId, claim.id, assetId]);
        if (evidence.rowCount !== 1) throw new ClaimsError('CLAIM_EVIDENCE_NOT_ACCESSIBLE');
      }
      const response = { id: claim.id, productId, brandId: context.brandId, claimCode: proposal.claimCode,
        claimText: proposal.claimText, claimState: 'PENDING', expiresAt: proposal.expiresAt,
        rowVersion: Number(claim.row_version), evidenceAssetIds: proposal.evidenceAssetIds };
      const receipt = await client.query(
        `INSERT INTO catalogue.claim_mutation_receipts
           (brand_id,product_id,actor_user_id,operation,idempotency_key,request_sha256,claim_id,response_payload)
         SELECT $1,$2,$3,'proposeProductClaim',$4,$5,$6,$7::jsonb
          WHERE EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$3 AND ep.permission_code=$8
            AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$1)))`,
        [context.brandId, productId, context.userId, context.idempotencyKey, requestHash, claim.id, JSON.stringify(response), context.permission]);
      if (receipt.rowCount !== 1) throw new ClaimsError('CLAIM_PERMISSION_REVOKED');
      return response;
    });
  }

  async decide(claimId: string, input: ClaimDecisionInput, expectedVersion: number, context: ClaimDecisionContext): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const requestHash = hash({ claimId, brandId: context.brandId, input, expectedVersion });
      let boundedExpiry: string | null | undefined;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`${context.brandId}:${context.userId}:decideProductClaim:${context.idempotencyKey}`]);
      const replay = await client.query<{ request_sha256: string; response_payload: Record<string, unknown> }>(
        `SELECT r.request_sha256,r.response_payload FROM catalogue.claim_mutation_receipts r
          JOIN catalogue.sustainability_claims c ON c.id=r.claim_id AND c.brand_id=r.brand_id
          JOIN brands.brands b ON b.id=r.brand_id AND b.onboarding_state='approved'
         WHERE r.brand_id=$1 AND r.actor_user_id=$2 AND r.operation='decideProductClaim'
           AND r.idempotency_key=$3 AND EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$2
             AND ep.permission_code=$4 AND ep.scope_type='global' AND ep.brand_id IS NULL)`,
        [context.brandId, context.userId, context.idempotencyKey, context.permission]);
      if (replay.rows[0]) {
        if (replay.rows[0].request_sha256.trim() !== requestHash) throw new ClaimsError('CLAIM_IDEMPOTENCY_CONFLICT');
        return replay.rows[0].response_payload;
      }

      const current = await client.query<{ product_id: string; claim_state: string; row_version: string | number; submitted_by: string; expires_at: Date | string | null }>(
        `SELECT c.product_id,c.claim_state,c.row_version,c.submitted_by,c.expires_at
           FROM catalogue.sustainability_claims c
           JOIN brands.brands b ON b.id=c.brand_id AND b.onboarding_state='approved'
          WHERE c.id=$1 AND c.brand_id=$2
            AND EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$3
              AND ep.permission_code=$4 AND ep.scope_type='global' AND ep.brand_id IS NULL)
          FOR UPDATE OF c`, [claimId, context.brandId, context.userId, context.permission]);
      const before = current.rows[0];
      if (!before) throw new ClaimsError('CLAIM_NOT_FOUND');
      if (Number(before.row_version) !== expectedVersion) throw new ClaimsError('CLAIM_VERSION_CONFLICT');
      if (before.submitted_by === context.userId) throw new ClaimsError('CLAIM_MAKER_CHECKER_CONFLICT');
      if ((input.decision === 'VERIFY' || input.decision === 'REJECT') && before.claim_state !== 'PENDING') throw new ClaimsError('CLAIM_REVIEW_STATE_CONFLICT');
      if (input.decision === 'REVOKE' && before.claim_state !== 'VERIFIED') throw new ClaimsError('CLAIM_REVIEW_STATE_CONFLICT');

      if (input.decision === 'VERIFY') {
        const evidence = await client.query<{ id: string; evidence_state: string; recalled_at: Date | null; document_expires_at: Date | null; scan_state: string; derivative_state: string; rights_state: string }>(
          `SELECT e.id,e.evidence_state,e.recalled_at,e.document_expires_at,a.scan_state,a.derivative_state,a.rights_state
             FROM catalogue.claim_evidence e
             JOIN media.media_assets a ON a.id=e.media_asset_id AND a.brand_id=e.brand_id
            WHERE e.claim_id=$1 AND e.brand_id=$2 AND e.product_id=$3
            ORDER BY e.id FOR UPDATE OF e,a`, [claimId, context.brandId, before.product_id]);
        if (evidence.rows.some((row) => !['PENDING', 'ACCEPTED'].includes(row.evidence_state) || row.recalled_at
          || row.scan_state !== 'CLEAN' || row.derivative_state !== 'READY' || !['ATTESTED', 'REVIEWED'].includes(row.rights_state)
          || (row.document_expires_at && row.document_expires_at.getTime() <= Date.now()))) {
          throw new ClaimsError('CLAIM_EVIDENCE_NOT_ELIGIBLE');
        }
        if (evidence.rowCount === 0) throw new ClaimsError('CLAIM_EVIDENCE_NOT_ACCESSIBLE');
        const expiries = evidence.rows.map((row) => row.document_expires_at?.getTime()).filter((date): date is number => date !== undefined && date !== null);
        const earliestEvidenceExpiry = expiries.sort((a, b) => a - b)[0];
        const claimExpiry = before.expires_at === null ? null : new Date(before.expires_at).getTime();
        if (claimExpiry !== null && claimExpiry <= Date.now()) throw new ClaimsError('CLAIM_EVIDENCE_NOT_ELIGIBLE');
        if (earliestEvidenceExpiry !== undefined && claimExpiry !== null && claimExpiry > earliestEvidenceExpiry) {
          throw new ClaimsError('CLAIM_EVIDENCE_EXPIRY_CONFLICT');
        }
        const boundedClaimExpiry = claimExpiry === null && earliestEvidenceExpiry !== undefined
          ? new Date(earliestEvidenceExpiry).toISOString() : before.expires_at;
        if (boundedClaimExpiry !== before.expires_at) boundedExpiry = boundedClaimExpiry === null ? null : new Date(boundedClaimExpiry).toISOString();
        await client.query(`UPDATE catalogue.claim_evidence SET evidence_state='ACCEPTED',row_version=row_version+1
          WHERE claim_id=$1 AND brand_id=$2 AND product_id=$3 AND evidence_state IN ('PENDING','ACCEPTED') AND recalled_at IS NULL`,
        [claimId, context.brandId, before.product_id]);
      } else if (input.decision === 'REJECT') {
        await client.query(`UPDATE catalogue.claim_evidence SET evidence_state='REJECTED',row_version=row_version+1
          WHERE claim_id=$1 AND brand_id=$2 AND product_id=$3 AND evidence_state='PENDING'`, [claimId, context.brandId, before.product_id]);
      } else if (input.decision === 'REVOKE') {
        await client.query(`UPDATE catalogue.claim_evidence SET evidence_state='REVOKED',recalled_at=now(),
            recall_reason_code=$4,row_version=row_version+1
          WHERE claim_id=$1 AND brand_id=$2 AND product_id=$3 AND evidence_state='ACCEPTED' AND recalled_at IS NULL`,
        [claimId, context.brandId, before.product_id, input.reasonCode]);
      }

      const nextState = input.decision === 'VERIFY' ? 'VERIFIED' : input.decision === 'REJECT' ? 'REJECTED' : 'REVOKED';
      const updated = await client.query<{ claim_state: string; row_version: string | number }>(
        `UPDATE catalogue.sustainability_claims c
            SET claim_state=$5,reviewed_by=$3,reviewed_at=now(),decision_reason_code=$6,
                approved_at=CASE WHEN $5='VERIFIED' THEN now() ELSE c.approved_at END,
                expires_at=CASE WHEN $7::boolean THEN $8::timestamptz ELSE c.expires_at END,
                row_version=c.row_version+1
          WHERE c.id=$1 AND c.brand_id=$2 AND c.row_version=$4 AND c.claim_state=$9
            AND EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$3
              AND ep.permission_code=$10 AND ep.scope_type='global' AND ep.brand_id IS NULL)
          RETURNING c.claim_state,c.row_version`,
        [claimId, context.brandId, context.userId, expectedVersion, nextState, input.reasonCode,
          boundedExpiry !== undefined, boundedExpiry ?? null, before.claim_state, context.permission]);
      const after = updated.rows[0];
      if (!after) throw new ClaimsError('CLAIM_PERMISSION_REVOKED');
      const afterVersion = Number(after.row_version);
      await client.query(
        `INSERT INTO catalogue.claim_review_events
           (brand_id,product_id,claim_id,review_action,reviewer_user_id,reason_code,previous_state,next_state,claim_row_version,reviewer_comment)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [context.brandId, before.product_id, claimId, input.decision, context.userId, input.reasonCode,
          before.claim_state, after.claim_state, afterVersion, input.comment ?? null]);
      await client.query(
        `INSERT INTO platform.outbox_events
           (aggregate_type,aggregate_id,event_type,event_version,event_payload,event_key)
         VALUES ('catalogue.product',$1,'catalogue.product.listing_recheck_requested',1,$2::jsonb,$3)`,
        [before.product_id, JSON.stringify({ brandId: context.brandId, productId: before.product_id, claimId,
          claimState: after.claim_state, claimRowVersion: afterVersion }), `claim-review:${claimId}:${afterVersion}`]);
      const response = { id: claimId, brandId: context.brandId, productId: before.product_id,
        claimState: after.claim_state, rowVersion: afterVersion, requestId: context.requestId };
      await client.query(
        `INSERT INTO catalogue.claim_mutation_receipts
           (brand_id,product_id,actor_user_id,operation,idempotency_key,request_sha256,claim_id,response_payload)
         VALUES ($1,$2,$3,'decideProductClaim',$4,$5,$6,$7::jsonb)`,
        [context.brandId, before.product_id, context.userId, context.idempotencyKey, requestHash, claimId, JSON.stringify(response)]);
      return response;
    });
  }

  async list(productId: string, context: ClaimReadContext): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const result = await client.query<{ authorized: boolean; items: Array<Record<string, unknown>> | null }>(
        `SELECT count(DISTINCT p.id)>0 AS authorized,
           COALESCE(jsonb_agg(jsonb_build_object(
             'id',c.id,'brandId',c.brand_id,'productId',c.product_id,'claimCode',c.claim_code,'claimText',c.claim_text,
             'claimState',CASE WHEN c.claim_state<>'VERIFIED' THEN c.claim_state
               WHEN c.expires_at IS NOT NULL AND c.expires_at<=now() THEN 'EXPIRED'
               WHEN NOT EXISTS (SELECT 1 FROM catalogue.claim_evidence e WHERE e.claim_id=c.id) THEN 'REVOKED'
               WHEN EXISTS (SELECT 1 FROM catalogue.claim_evidence e WHERE e.claim_id=c.id
                 AND e.document_expires_at IS NOT NULL AND e.document_expires_at<=now()) THEN 'EXPIRED'
               WHEN EXISTS (SELECT 1 FROM catalogue.claim_evidence e LEFT JOIN media.media_assets a ON a.id=e.media_asset_id AND a.brand_id=e.brand_id
                 WHERE e.claim_id=c.id AND (e.recalled_at IS NOT NULL OR e.evidence_state='REVOKED'
                   OR a.id IS NULL OR a.scan_state<>'CLEAN' OR a.derivative_state<>'READY' OR a.rights_state NOT IN ('ATTESTED','REVIEWED'))) THEN 'REVOKED'
               WHEN EXISTS (SELECT 1 FROM catalogue.claim_evidence e WHERE e.claim_id=c.id AND e.evidence_state='REJECTED') THEN 'REJECTED'
               WHEN EXISTS (SELECT 1 FROM catalogue.claim_evidence e WHERE e.claim_id=c.id AND e.evidence_state<>'ACCEPTED') THEN 'PENDING'
               ELSE 'VERIFIED' END,
             'expiresAt',c.expires_at,
             'evidenceAssetIds',COALESCE((SELECT jsonb_agg(e.media_asset_id ORDER BY e.submitted_at,e.id)
               FROM catalogue.claim_evidence e WHERE e.claim_id=c.id AND e.brand_id=c.brand_id AND e.product_id=c.product_id),'[]'::jsonb)
           ) ORDER BY c.created_at DESC,c.id) FILTER (WHERE c.id IS NOT NULL),'[]'::jsonb) AS items
          FROM catalogue.products p
          JOIN brands.brands b ON b.id=p.brand_id AND b.onboarding_state='approved'
          LEFT JOIN catalogue.sustainability_claims c ON c.brand_id=p.brand_id AND c.product_id=p.id
         WHERE p.id=$1 AND p.brand_id=$2 AND EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$3
           AND ep.permission_code=$4 AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$2)))`,
        [productId, context.brandId, context.userId, context.permission]);
      if (!result.rows[0]?.authorized) throw new ClaimsError('CLAIM_PRODUCT_NOT_FOUND');
      const expired = await client.query<{ claim_id: string; row_version: string | number }>(
        `SELECT c.id AS claim_id,c.row_version FROM catalogue.sustainability_claims c
          WHERE c.brand_id=$2 AND c.product_id=$1 AND c.claim_state='VERIFIED'
            AND (c.expires_at<=now() OR EXISTS (SELECT 1 FROM catalogue.claim_evidence e
              WHERE e.claim_id=c.id AND e.brand_id=c.brand_id AND e.product_id=c.product_id
                AND e.document_expires_at IS NOT NULL AND e.document_expires_at<=now()))
            AND EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$3
              AND ep.permission_code=$4 AND ((ep.scope_type='global' AND ep.brand_id IS NULL)
                OR (ep.scope_type='brand' AND ep.brand_id=$2)))`, [productId, context.brandId, context.userId, context.permission]);
      for (const claim of expired.rows) {
        const rowVersion = Number(claim.row_version);
        await client.query(
          `INSERT INTO platform.outbox_events
             (aggregate_type,aggregate_id,event_type,event_version,event_payload,event_key)
           VALUES ('catalogue.product',$1,'catalogue.product.listing_recheck_requested',1,$2::jsonb,$3)
           ON CONFLICT (aggregate_type,aggregate_id,event_key) DO NOTHING`,
          [productId, JSON.stringify({ brandId: context.brandId, productId, claimId: claim.claim_id,
            claimState: 'EXPIRED', claimRowVersion: rowVersion }), `claim-expiry:${claim.claim_id}:${rowVersion}`]);
      }
      return { items: result.rows[0].items ?? [] };
    });
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!this.infrastructure.pool) throw new ClaimsError('CLAIM_DATABASE_UNAVAILABLE');
    let client: PoolClient;
    try { client = await this.infrastructure.pool.connect(); } catch { throw new ClaimsError('CLAIM_DATABASE_UNAVAILABLE'); }
    try { await client.query('BEGIN'); const value = await work(client); await client.query('COMMIT'); return value; }
    catch (error) {
      try { await client.query('ROLLBACK'); } catch { throw new ClaimsError('CLAIM_DATABASE_UNAVAILABLE'); }
      if (error instanceof ClaimsError) throw error;
      const db = error as { code?: string; message?: string };
      if (db.message?.includes('CLAIM_MAKER_CHECKER_CONFLICT')) throw new ClaimsError('CLAIM_MAKER_CHECKER_CONFLICT');
      if (db.message?.includes('CLAIM_REVIEW_TRANSITION_INVALID') || db.message?.includes('CLAIM_APPROVAL_TIMESTAMP_REQUIRED')) throw new ClaimsError('CLAIM_DECISION_INVALID');
      if (db.message?.includes('CLAIM_EVIDENCE_ASSET_NOT_READY')) throw new ClaimsError('CLAIM_EVIDENCE_NOT_ACCESSIBLE');
      if (db.code === '23514') throw new ClaimsError('CLAIM_DECISION_INVALID');
      if (db.code === '23503') throw new ClaimsError('CLAIM_REVISION_REQUIRED');
      if (db.code === '23505') throw new ClaimsError('CLAIM_CONFLICT');
      if (db.code?.startsWith('08') || ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','57P01'].includes(db.code ?? '')) throw new ClaimsError('CLAIM_DATABASE_UNAVAILABLE');
      throw new ClaimsError('CLAIM_INTERNAL_ERROR');
    } finally { client.release(); }
  }
}
