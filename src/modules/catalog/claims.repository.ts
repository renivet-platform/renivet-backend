import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PoolClient } from 'pg';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';
import { ClaimMutationContext, ClaimProposal, ClaimReadContext, ClaimsError, ClaimsRepository } from './claims.service';

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
           (brand_id,product_id,revision_id,claim_code,claim_text,claim_state,expires_at)
         SELECT $1,$2,$3,$4,$5,'PENDING',$6::timestamptz
          WHERE EXISTS (SELECT 1 FROM access.effective_permissions ep WHERE ep.user_id=$7 AND ep.permission_code=$8
            AND ((ep.scope_type='global' AND ep.brand_id IS NULL) OR (ep.scope_type='brand' AND ep.brand_id=$1)))
         RETURNING id,row_version`,
        [context.brandId, productId, target.revision_id, proposal.claimCode, proposal.claimText, proposal.expiresAt, context.userId, context.permission]);
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
      if (db.message?.includes('CLAIM_EVIDENCE_ASSET_NOT_READY') || db.code === '23514') throw new ClaimsError('CLAIM_EVIDENCE_NOT_ACCESSIBLE');
      if (db.code === '23503') throw new ClaimsError('CLAIM_REVISION_REQUIRED');
      if (db.code === '23505') throw new ClaimsError('CLAIM_CONFLICT');
      if (db.code?.startsWith('08') || ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','57P01'].includes(db.code ?? '')) throw new ClaimsError('CLAIM_DATABASE_UNAVAILABLE');
      throw new ClaimsError('CLAIM_INTERNAL_ERROR');
    } finally { client.release(); }
  }
}
