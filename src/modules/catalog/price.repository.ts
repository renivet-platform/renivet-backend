import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PoolClient } from 'pg';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';
import { NormalizedPriceProposal, PriceDecisionContext, PriceDecisionInput, PriceError, PriceMutationContext, PriceReadContext, PriceRepository } from './price.service';

interface PriceRow {
  id: string;
  variant_id: string;
  currency: string;
  amount_minor: string;
  mrp_minor: string;
  price_state: string;
  valid_from: Date;
  valid_to: Date | null;
  row_version: string | number;
}

interface DecisionRow extends PriceRow {
  brand_id: string;
  rule_version: number;
  created_by: string | null;
  reason_code: string | null;
  decided_by: string | null;
  decision_reason_code: string | null;
  decided_at: Date | null;
}

function decisionSnapshot(row: DecisionRow): Record<string, unknown> {
  return {
    ...priceVersion(row), ruleVersion: row.rule_version, createdBy: row.created_by,
    reasonCode: row.reason_code, decidedBy: row.decided_by,
    decisionReasonCode: row.decision_reason_code, decidedAt: row.decided_at?.toISOString() ?? null,
  };
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function priceVersion(row: PriceRow): Record<string, unknown> {
  const amount = Number(row.amount_minor);
  const mrp = Number(row.mrp_minor);
  const rowVersion = Number(row.row_version);
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(mrp) || !Number.isSafeInteger(rowVersion)) {
    throw new PriceError('PRICE_DATA_INVALID');
  }
  return {
    id: row.id, variantId: row.variant_id, currency: 'INR', amountMinor: amount, mrpMinor: mrp,
    priceState: row.price_state, validFrom: row.valid_from.toISOString(),
    validTo: row.valid_to?.toISOString() ?? null, rowVersion,
  };
}

@Injectable()
export class PricePostgresRepository implements PriceRepository {
  constructor(private readonly infrastructure: IdentityInfrastructure) {}

  async propose(variantId: string, input: NormalizedPriceProposal, expectedVariantVersion: number, context: PriceMutationContext): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const requestHash = hash({ variantId, input, expectedVariantVersion });
      const replay = await this.replay(client, context, variantId, requestHash);
      if (replay) return replay;

      const updated = await client.query<{ row_version: number }>(
        `UPDATE catalogue.product_variants AS v
            SET row_version = v.row_version + 1, updated_at = now()
          WHERE v.id = $1 AND v.brand_id = $2 AND v.row_version = $3 AND v.row_version < 9007199254740991
            AND v.variant_state IN ('DRAFT', 'ACTIVE')
            AND EXISTS (
              SELECT 1 FROM brands.brands AS b
              JOIN access.effective_permissions AS ep ON ep.user_id = $4
               AND ep.permission_code = $5
               AND ((ep.scope_type = 'global' AND ep.brand_id IS NULL) OR (ep.scope_type = 'brand' AND ep.brand_id = b.id))
              WHERE b.id = v.brand_id AND b.onboarding_state = 'approved'
            )
          RETURNING v.row_version`,
        [variantId, context.brandId, expectedVariantVersion, context.userId, context.permission]);
      if (!updated.rows[0]) {
        const exists = await client.query(
          `SELECT 1 FROM catalogue.product_variants AS v
            JOIN brands.brands AS b ON b.id = v.brand_id AND b.onboarding_state = 'approved'
           WHERE v.id = $1 AND v.brand_id = $2
             AND EXISTS (SELECT 1 FROM access.effective_permissions AS ep WHERE ep.user_id = $3
               AND ep.permission_code = $4
               AND ((ep.scope_type = 'global' AND ep.brand_id IS NULL) OR (ep.scope_type = 'brand' AND ep.brand_id = v.brand_id)))`,
          [variantId, context.brandId, context.userId, context.permission]);
        throw new PriceError(exists.rowCount ? 'PRICE_VERSION_CONFLICT' : 'PRICE_VARIANT_NOT_FOUND');
      }

      const inserted = await client.query<PriceRow>(
        `INSERT INTO catalogue.variant_prices
           (brand_id, variant_id, currency, amount_minor, mrp_minor, valid_from, valid_to, price_state,
            rule_version, created_by, reason_code, row_version)
         SELECT v.brand_id, v.id, $3, $4, $5, $6::timestamptz, $7::timestamptz, 'PENDING', $8, $9, $10, 1
           FROM catalogue.product_variants AS v
           JOIN catalogue.products AS p ON p.id = v.product_id AND p.brand_id = v.brand_id
           JOIN brands.brands AS b ON b.id = v.brand_id AND b.onboarding_state = 'approved'
          WHERE v.id = $1 AND v.brand_id = $2 AND v.variant_state IN ('DRAFT', 'ACTIVE')
            AND EXISTS (SELECT 1 FROM access.effective_permissions AS ep WHERE ep.user_id = $9
              AND ep.permission_code = $11
              AND ((ep.scope_type = 'global' AND ep.brand_id IS NULL) OR (ep.scope_type = 'brand' AND ep.brand_id = v.brand_id)))
         RETURNING id, variant_id, currency, amount_minor, mrp_minor, price_state, valid_from, valid_to, row_version`,
        [variantId, context.brandId, input.currency, input.sellingPriceMinor, input.mrpMinor, input.validFrom,
          input.validTo, input.ruleVersion, context.userId, input.reasonCode ?? null, context.permission]);
      const row = inserted.rows[0];
      if (!row) throw new PriceError('PRICE_VARIANT_NOT_FOUND');
      const response = { id: row.id, status: 'PENDING', requestId: context.requestId, rowVersion: Number(updated.rows[0].row_version) };
      const snapshot = { ...priceVersion(row), ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}) };
      const audit = await client.query(
        `INSERT INTO catalogue.price_audit_events
           (brand_id, variant_id, price_id, action, prior_snapshot, next_snapshot, actor_user_id, business_effect_key)
         SELECT $1, $2, $3, 'PROPOSED', NULL, $4::jsonb, $5, $6
          WHERE EXISTS (SELECT 1 FROM access.effective_permissions AS ep WHERE ep.user_id = $5
            AND ep.permission_code = $7
            AND ((ep.scope_type = 'global' AND ep.brand_id IS NULL) OR (ep.scope_type = 'brand' AND ep.brand_id = $1)))`,
        [context.brandId, variantId, row.id, JSON.stringify(snapshot), context.userId, context.idempotencyKey, context.permission]);
      if (audit.rowCount !== 1) throw new PriceError('PRICE_PERMISSION_REVOKED');
      const receiptRecord = await client.query(
        `INSERT INTO catalogue.price_mutation_receipts
           (brand_id, variant_id, actor_user_id, operation, idempotency_key, request_sha256, price_id, response_payload)
         SELECT $1, $2, $3, 'proposeVariantPrice', $4, $5, $6, $7::jsonb
          WHERE EXISTS (SELECT 1 FROM access.effective_permissions AS ep WHERE ep.user_id = $3
            AND ep.permission_code = $8
            AND ((ep.scope_type = 'global' AND ep.brand_id IS NULL) OR (ep.scope_type = 'brand' AND ep.brand_id = $1)))`,
        [context.brandId, variantId, context.userId, context.idempotencyKey, requestHash, row.id, JSON.stringify(response), context.permission]);
      if (receiptRecord.rowCount !== 1) throw new PriceError('PRICE_PERMISSION_REVOKED');
      return response;
    });
  }

  async list(variantId: string, context: PriceReadContext): Promise<Record<string, unknown>> {
    const pool = this.infrastructure.pool;
    if (!pool) throw new PriceError('PRICE_DATABASE_UNAVAILABLE');
    try {
      const result = await pool.query<PriceRow>(
        `SELECT vp.id, vp.variant_id, vp.currency, vp.amount_minor, vp.mrp_minor, vp.price_state,
                vp.valid_from, vp.valid_to, vp.row_version
           FROM catalogue.variant_prices AS vp
           JOIN catalogue.product_variants AS v ON v.id = vp.variant_id AND v.brand_id = vp.brand_id
           JOIN catalogue.products AS p ON p.id = v.product_id AND p.brand_id = v.brand_id
           JOIN brands.brands AS b ON b.id = vp.brand_id AND b.onboarding_state = 'approved'
          WHERE vp.variant_id = $1 AND vp.brand_id = $2
            AND EXISTS (SELECT 1 FROM access.effective_permissions AS ep WHERE ep.user_id = $3
              AND ep.permission_code = $4
              AND ((ep.scope_type = 'global' AND ep.brand_id IS NULL) OR (ep.scope_type = 'brand' AND ep.brand_id = vp.brand_id)))
          ORDER BY vp.valid_from DESC, vp.created_at DESC, vp.id DESC`,
        [variantId, context.brandId, context.userId, context.permission]);
      if (!result.rowCount) {
        const visibleVariant = await pool.query(
          `SELECT 1 FROM catalogue.product_variants AS v
            JOIN brands.brands AS b ON b.id = v.brand_id AND b.onboarding_state = 'approved'
           WHERE v.id = $1 AND v.brand_id = $2
             AND EXISTS (SELECT 1 FROM access.effective_permissions AS ep WHERE ep.user_id = $3
               AND ep.permission_code = $4
               AND ((ep.scope_type = 'global' AND ep.brand_id IS NULL) OR (ep.scope_type = 'brand' AND ep.brand_id = v.brand_id)))`,
          [variantId, context.brandId, context.userId, context.permission]);
        if (!visibleVariant.rowCount) throw new PriceError('PRICE_VARIANT_NOT_FOUND');
      }
      return { items: result.rows.map(priceVersion), nextCursor: null };
    } catch (error) { throw this.normalizeError(error); }
  }

  async decide(priceId: string, input: PriceDecisionInput, context: PriceDecisionContext): Promise<Record<string, unknown>> {
    return this.transaction(async (client) => {
      const requestHash = hash({ priceId, input });
      const lockKey = `${context.brandId}:${context.userId}:decideVariantPrice:${context.idempotencyKey}`;
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lockKey]);
      const replay = await client.query<{ request_sha256: string; response_payload: Record<string, unknown> }>(
        `SELECT r.request_sha256, r.response_payload FROM catalogue.price_mutation_receipts AS r
          JOIN brands.brands AS b ON b.id = r.brand_id AND b.onboarding_state = 'approved'
         WHERE r.brand_id = $1 AND r.actor_user_id = $2 AND r.price_id = $3
           AND r.operation = 'decideVariantPrice' AND r.idempotency_key = $4
           AND EXISTS (SELECT 1 FROM access.effective_permissions AS ep WHERE ep.user_id = $2
             AND ep.permission_code = $5
             AND ((ep.scope_type = 'global' AND ep.brand_id IS NULL) OR (ep.scope_type = 'brand' AND ep.brand_id = $1)))`,
        [context.brandId, context.userId, priceId, context.idempotencyKey, context.permission]);
      if (replay.rows[0]) {
        if (replay.rows[0].request_sha256.trim() !== requestHash) throw new PriceError('PRICE_IDEMPOTENCY_CONFLICT');
        return replay.rows[0].response_payload;
      }

      const authorized = await client.query(
        `SELECT 1 FROM brands.brands AS b
          WHERE b.id = $1 AND b.onboarding_state = 'approved'
            AND EXISTS (SELECT 1 FROM access.effective_permissions AS ep WHERE ep.user_id = $2
              AND ep.permission_code = $3
              AND ((ep.scope_type = 'global' AND ep.brand_id IS NULL) OR (ep.scope_type = 'brand' AND ep.brand_id = $1)))`,
        [context.brandId, context.userId, context.permission]);
      if (!authorized.rowCount) throw new PriceError('PRICE_PERMISSION_REVOKED');

      const current = await client.query<DecisionRow>(
        `SELECT vp.id, vp.brand_id, vp.variant_id, vp.currency, vp.amount_minor, vp.mrp_minor, vp.price_state,
                vp.valid_from, vp.valid_to, vp.row_version, vp.rule_version, vp.created_by, vp.reason_code,
                vp.decided_by, vp.decision_reason_code, vp.decided_at
           FROM catalogue.variant_prices AS vp
          WHERE vp.id = $1 AND vp.brand_id = $2 FOR UPDATE`, [priceId, context.brandId]);
      const before = current.rows[0];
      if (!before) throw new PriceError('PRICE_PRICE_NOT_FOUND');
      if (before.created_by === context.userId) throw new PriceError('PRICE_MAKER_CHECKER_CONFLICT');
      if (before.price_state !== 'PENDING') throw new PriceError('PRICE_REVIEW_STATE_CONFLICT');

      // Serialize approvals in the same exclusion-constraint key space before changing
      // different pending rows, preventing a PostgreSQL exclusion-check deadlock.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`price-approval:${context.brandId}:${before.variant_id}:${before.currency}`]);

      const nextState = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      const updated = await client.query<DecisionRow>(
        `UPDATE catalogue.variant_prices AS vp
            SET price_state = $3, row_version = vp.row_version + 1,
                decided_by = $4, decision_reason_code = $5, decided_at = now(), updated_at = now()
          WHERE vp.id = $1 AND vp.brand_id = $2 AND vp.price_state = 'PENDING'
            AND vp.row_version < 9007199254740991
            AND EXISTS (SELECT 1 FROM brands.brands AS b WHERE b.id = vp.brand_id AND b.onboarding_state = 'approved')
            AND EXISTS (SELECT 1 FROM access.effective_permissions AS ep WHERE ep.user_id = $4
              AND ep.permission_code = $6
              AND ((ep.scope_type = 'global' AND ep.brand_id IS NULL) OR (ep.scope_type = 'brand' AND ep.brand_id = vp.brand_id)))
          RETURNING vp.id, vp.brand_id, vp.variant_id, vp.currency, vp.amount_minor, vp.mrp_minor, vp.price_state,
                    vp.valid_from, vp.valid_to, vp.row_version, vp.rule_version, vp.created_by, vp.reason_code,
                    vp.decided_by, vp.decision_reason_code, vp.decided_at`,
        [priceId, context.brandId, nextState, context.userId, input.reasonCode, context.permission]);
      const after = updated.rows[0];
      if (!after) throw new PriceError('PRICE_PERMISSION_REVOKED');
      const priorSnapshot = decisionSnapshot(before);
      const nextSnapshot = { ...decisionSnapshot(after), ...(input.comment ? { decisionComment: input.comment } : {}) };
      const action = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      const businessEffectKey = `decision:${context.userId}:${context.idempotencyKey}`;
      const audit = await client.query(
        `INSERT INTO catalogue.price_audit_events
           (brand_id, variant_id, price_id, action, prior_snapshot, next_snapshot, actor_user_id, business_effect_key)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8)`,
        [context.brandId, after.variant_id, priceId, action, JSON.stringify(priorSnapshot), JSON.stringify(nextSnapshot), context.userId, businessEffectKey]);
      if (audit.rowCount !== 1) throw new PriceError('PRICE_INTERNAL_ERROR');
      const response = { id: priceId, status: nextState, requestId: context.requestId, rowVersion: Number(after.row_version) };
      const receipt = await client.query(
        `INSERT INTO catalogue.price_mutation_receipts
           (brand_id, variant_id, actor_user_id, operation, idempotency_key, request_sha256, price_id, response_payload)
         VALUES ($1, $2, $3, 'decideVariantPrice', $4, $5, $6, $7::jsonb)`,
        [context.brandId, after.variant_id, context.userId, context.idempotencyKey, requestHash, priceId, JSON.stringify(response)]);
      if (receipt.rowCount !== 1) throw new PriceError('PRICE_INTERNAL_ERROR');
      return response;
    });
  }

  private async replay(client: PoolClient, context: PriceMutationContext, variantId: string, requestHash: string): Promise<Record<string, unknown> | null> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`${context.brandId}:${context.userId}:proposeVariantPrice:${context.idempotencyKey}`]);
    const result = await client.query<{ request_sha256: string; response_payload: Record<string, unknown> }>(
      `SELECT r.request_sha256, r.response_payload FROM catalogue.price_mutation_receipts AS r
        JOIN catalogue.product_variants AS v ON v.id = r.variant_id AND v.brand_id = r.brand_id
        JOIN brands.brands AS b ON b.id = r.brand_id AND b.onboarding_state = 'approved'
       WHERE r.brand_id = $1 AND r.actor_user_id = $2 AND r.variant_id = $3
         AND r.operation = 'proposeVariantPrice' AND r.idempotency_key = $4
         AND EXISTS (SELECT 1 FROM access.effective_permissions AS ep WHERE ep.user_id = $2
           AND ep.permission_code = $5
           AND ((ep.scope_type = 'global' AND ep.brand_id IS NULL) OR (ep.scope_type = 'brand' AND ep.brand_id = $1)))`,
      [context.brandId, context.userId, variantId, context.idempotencyKey, context.permission]);
    if (!result.rows[0]) return null;
    if (result.rows[0].request_sha256.trim() !== requestHash) throw new PriceError('PRICE_IDEMPOTENCY_CONFLICT');
    return result.rows[0].response_payload;
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const pool = this.infrastructure.pool;
    if (!pool) throw new PriceError('PRICE_DATABASE_UNAVAILABLE');
    let client: PoolClient;
    try { client = await pool.connect(); } catch { throw new PriceError('PRICE_DATABASE_UNAVAILABLE'); }
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) {
      try { await client.query('ROLLBACK'); } catch { throw new PriceError('PRICE_DATABASE_UNAVAILABLE'); }
      throw this.normalizeError(error);
    } finally { client.release(); }
  }

  private normalizeError(error: unknown): PriceError {
    if (error instanceof PriceError) return error;
    const candidate = error as { code?: string; message?: string } | null;
    const code = candidate?.code;
    if (candidate?.message?.includes('PRICE_MAKER_CHECKER_CONFLICT')) return new PriceError('PRICE_MAKER_CHECKER_CONFLICT');
    if (candidate?.message?.includes('PRICE_PENDING_DECISION_REQUIRED')) return new PriceError('PRICE_DECISION_INVALID');
    if (code === '23P01') return new PriceError('PRICE_WINDOW_CONFLICT');
    if (code === '23505') return new PriceError('PRICE_IDEMPOTENCY_CONFLICT');
    if (code === '23503') return new PriceError('PRICE_VARIANT_NOT_FOUND');
    if (code === '23514' || code?.startsWith('22')) return new PriceError('PRICE_PROPOSAL_INVALID');
    if (code?.startsWith('08') || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '57P01'].includes(code ?? '')) return new PriceError('PRICE_DATABASE_UNAVAILABLE');
    return error instanceof Error ? Object.assign(new PriceError('PRICE_INTERNAL_ERROR'), { cause: error }) : new PriceError('PRICE_INTERNAL_ERROR');
  }
}
