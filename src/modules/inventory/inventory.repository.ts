import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';
import { BrandAccessContext } from '../access/brand-access.guard';
import { AdjustmentPolicy, needsIndependentApproval, validateBalance } from './inventory-domain';

export interface StockBalance {
  brand_id: string; variant_id: string; location_id: string; physical_on_hand: string;
  quarantined: string; other_non_sellable: string; allocated_not_dispatched: string;
  pre_commit_allocations: string; safety_buffer: string; row_version: string; suspended: boolean;
}

const failure = (code: string, status = 422) => {
  const payload = { code, message: 'The inventory request could not be completed.' };
  if (status === 404) return new NotFoundException(payload);
  if (status === 403) return new ForbiddenException(payload);
  if (status === 409) return new ConflictException(payload);
  return new UnprocessableEntityException(payload);
};
const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
    : JSON.stringify(value);
const digest = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex');
const buckets = (row: StockBalance) => ({
  physical: Number(row.physical_on_hand), quarantine: Number(row.quarantined) + Number(row.other_non_sellable),
  committed: Number(row.allocated_not_dispatched), allocated: Number(row.pre_commit_allocations), buffer: Number(row.safety_buffer),
});
const balanceView = (row: StockBalance) => {
  const value = buckets(row); validateBalance(value);
  return { brandId: row.brand_id, variantId: row.variant_id, locationId: row.location_id,
    physical: value.physical, quarantine: value.quarantine, committedUnshipped: value.committed,
    preCommitAllocations: value.allocated, buffer: value.buffer,
    availableToSell: Math.max(0, value.physical - value.quarantine - value.committed - value.allocated - value.buffer),
    version: Number(row.row_version), suspended: row.suspended };
};

@Injectable()
export class InventoryPostgresRepository {
  constructor(private readonly infrastructure: IdentityInfrastructure) {}

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const pool = this.infrastructure.pool;
    if (!pool) throw new Error('Inventory database is unavailable');
    const client = await pool.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  private async authorize(client: PoolClient, context: BrandAccessContext): Promise<void> {
    const result = await client.query(`SELECT 1 FROM access.effective_permissions p
      JOIN brands.brands b ON b.id=$1 AND b.onboarding_state='approved'
      WHERE p.user_id=$2 AND p.permission_code=$3 AND
        ((p.scope_type='global' AND p.brand_id IS NULL) OR (p.scope_type='brand' AND p.brand_id=$1)) LIMIT 1`,
    [context.brandId, context.userId, context.permission]);
    if (!result.rowCount) throw failure('BRAND_ACCESS_DENIED', 403);
  }

  private async idempotent<T>(client: PoolClient, context: BrandAccessContext, operation: string, key: string, request: unknown, work: () => Promise<T>): Promise<T> {
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(key)) throw failure('IDEMPOTENCY_KEY_INVALID');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`inventory.receipt:${context.brandId}:${operation}:${key}`]);
    const hash = digest(request);
    const prior = await client.query<{ request_sha256: string; response: T }>(
      'SELECT request_sha256,response FROM inventory.stock_command_receipts WHERE brand_id=$1 AND operation=$2 AND idempotency_key=$3 FOR UPDATE',
      [context.brandId, operation, key]);
    if (prior.rows[0]) {
      if (prior.rows[0].request_sha256 !== hash) throw failure('IDEMPOTENCY_KEY_REUSED', 409);
      return prior.rows[0].response;
    }
    const response = await work();
    await client.query(`INSERT INTO inventory.stock_command_receipts(brand_id,operation,idempotency_key,request_sha256,response,actor_user_id)
      VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [context.brandId, operation, key, hash, JSON.stringify(response), context.userId]);
    return response;
  }

  async listBalances(context: BrandAccessContext, filters: { variantId?: string; locationId?: string }) {
    const pool = this.infrastructure.pool; if (!pool) throw new Error('Inventory database is unavailable');
    const result = await pool.query<StockBalance>(`SELECT s.* FROM inventory.stock_balances s
      WHERE s.brand_id=$1 AND ($2::uuid IS NULL OR s.variant_id=$2) AND ($3::uuid IS NULL OR s.location_id=$3)
      AND EXISTS (SELECT 1 FROM access.effective_permissions p WHERE p.user_id=$4 AND p.permission_code=$5
        AND ((p.scope_type='global' AND p.brand_id IS NULL) OR (p.scope_type='brand' AND p.brand_id=s.brand_id)))
      ORDER BY s.location_id,s.variant_id`, [context.brandId, filters.variantId ?? null, filters.locationId ?? null, context.userId, context.permission]);
    return result.rows.map(balanceView);
  }

  async createLocation(context: BrandAccessContext, input: { code: string; name: string }, key: string) {
    return this.transaction(async (client) => {
      await this.authorize(client, context);
      return this.idempotent(client, context, 'location.create', key, input, async () => {
        if (!/^[A-Za-z0-9._:-]{1,64}$/.test(input.code) || input.name.trim().length < 1 || input.name.length > 160) throw failure('LOCATION_REQUEST_INVALID');
        const result = await client.query(`INSERT INTO inventory.stock_locations(brand_id,location_code,name)
          VALUES($1,$2,$3) ON CONFLICT(brand_id,location_code) DO NOTHING RETURNING id,location_code,name,active`,
        [context.brandId, input.code.trim(), input.name.trim()]);
        if (!result.rows[0]) throw failure('LOCATION_ALREADY_EXISTS', 409);
        return result.rows[0];
      });
    });
  }

  async ensurePool(context: BrandAccessContext, variantId: string, locationId: string) {
    return this.transaction(async (client) => {
      await this.authorize(client, context);
      const variant = await client.query('SELECT 1 FROM catalogue.product_variants WHERE id=$1 AND brand_id=$2', [variantId, context.brandId]);
      const location = await client.query('SELECT 1 FROM inventory.stock_locations WHERE id=$1 AND brand_id=$2 AND active', [locationId, context.brandId]);
      if (!variant.rowCount || !location.rowCount) throw failure('STOCK_TARGET_NOT_FOUND', 404);
      await client.query(`INSERT INTO inventory.stock_balances(brand_id,variant_id,location_id) VALUES($1,$2,$3)
        ON CONFLICT(brand_id,variant_id,location_id) DO NOTHING`, [context.brandId, variantId, locationId]);
      const result = await client.query<StockBalance>(`SELECT * FROM inventory.stock_balances WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3`,
        [context.brandId, variantId, locationId]);
      return balanceView(result.rows[0]);
    });
  }

  async movement(context: BrandAccessContext, input: {
    variantId: string; locationId: string; expectedVersion?: number; effectKey: string; reason: string;
    sourceType: string; sourceReference: string; deltaPhysical?: number; deltaQuarantined?: number;
    deltaOtherNonSellable?: number; deltaCommitted?: number; deltaAllocated?: number; deltaBuffer?: number;
  }) {
    return this.transaction(async (client) => {
      await this.authorize(client, context);
      return this.applyMovement(client, context, input);
    });
  }

  private async applyMovement(client: PoolClient, context: BrandAccessContext, input: {
    variantId: string; locationId: string; expectedVersion?: number; effectKey: string; reason: string;
    sourceType: string; sourceReference: string; deltaPhysical?: number; deltaQuarantined?: number;
    deltaOtherNonSellable?: number; deltaCommitted?: number; deltaAllocated?: number; deltaBuffer?: number;
  }) {
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(input.effectKey) || !input.reason.trim() || !input.sourceReference.trim()) throw failure('STOCK_MOVEMENT_INVALID');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`inventory.effect:${context.brandId}:${input.effectKey}`]);
    const hash = digest(input);
    const prior = await client.query(`SELECT e.payload_sha256,e.pool_sequence FROM inventory.stock_events e
      WHERE e.brand_id=$1 AND e.business_effect_key=$2`, [context.brandId, input.effectKey]);
    if (prior.rows[0]) {
      if (prior.rows[0].payload_sha256 !== hash) throw failure('IDEMPOTENCY_KEY_REUSED', 409);
      const current = await client.query<StockBalance>('SELECT * FROM inventory.stock_balances WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3',
        [context.brandId, input.variantId, input.locationId]);
      if (!current.rows[0]) throw failure('STOCK_TARGET_NOT_FOUND', 404);
      return { ...balanceView(current.rows[0]), replayed: true, eventSequence: Number(prior.rows[0].pool_sequence) };
    }
    const targets = await client.query(`SELECT
      EXISTS(SELECT 1 FROM catalogue.product_variants WHERE id=$2 AND brand_id=$1) AS variant_ok,
      EXISTS(SELECT 1 FROM inventory.stock_locations WHERE id=$3 AND brand_id=$1 AND active) AS location_ok`,
    [context.brandId, input.variantId, input.locationId]);
    if (!targets.rows[0].variant_ok || !targets.rows[0].location_ok) throw failure('STOCK_TARGET_NOT_FOUND', 404);
    await client.query(`INSERT INTO inventory.stock_balances(brand_id,variant_id,location_id) VALUES($1,$2,$3)
      ON CONFLICT(brand_id,variant_id,location_id) DO NOTHING`, [context.brandId, input.variantId, input.locationId]);
    const locked = await client.query<StockBalance>(`SELECT * FROM inventory.stock_balances WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3 FOR UPDATE`,
      [context.brandId, input.variantId, input.locationId]);
    const before = locked.rows[0]; if (!before) throw failure('STOCK_TARGET_NOT_FOUND', 404);
    if (input.expectedVersion !== undefined && Number(before.row_version) !== input.expectedVersion) throw failure('STOCK_VERSION_CONFLICT', 409);
    const next = {
      physical: Number(before.physical_on_hand) + (input.deltaPhysical ?? 0),
      quarantine: Number(before.quarantined) + (input.deltaQuarantined ?? 0),
      other: Number(before.other_non_sellable) + (input.deltaOtherNonSellable ?? 0),
      committed: Number(before.allocated_not_dispatched) + (input.deltaCommitted ?? 0),
      allocated: Number(before.pre_commit_allocations) + (input.deltaAllocated ?? 0),
      buffer: Number(before.safety_buffer) + (input.deltaBuffer ?? 0),
    };
    const kind = (input.deltaPhysical || input.deltaQuarantined || input.deltaOtherNonSellable) ? 'PHYSICAL'
      : input.deltaBuffer ? 'BUFFER' : 'COMMITMENT';
    const availableToSell = next.physical - next.quarantine - next.other - next.committed - next.allocated - next.buffer;
    if (Object.values(next).some((n) => !Number.isSafeInteger(n) || n < 0)
      || next.physical < next.quarantine + next.other + next.committed
      || (kind === 'COMMITMENT' || (kind === 'BUFFER' && (input.deltaBuffer ?? 0) > 0)) && availableToSell < 0) {
      throw failure('STOCK_BALANCE_INVALID');
    }
    const sequence = Number(before.row_version) + 1;
    if (kind === 'PHYSICAL' && (input.deltaCommitted || input.deltaAllocated || input.deltaBuffer)
      || kind === 'BUFFER' && (input.deltaPhysical || input.deltaQuarantined || input.deltaOtherNonSellable || input.deltaCommitted || input.deltaAllocated)) {
      throw failure('STOCK_EVENT_KIND_INVALID');
    }
    const eventId = randomUUID();
    const beforeJson = balanceView(before);
    const afterJson = { ...beforeJson, physical: next.physical, quarantine: next.quarantine + next.other,
      committedUnshipped: next.committed, preCommitAllocations: next.allocated, buffer: next.buffer,
      availableToSell: Math.max(0, next.physical - next.quarantine - next.other - next.committed - next.allocated - next.buffer), version: sequence };
    await client.query(`INSERT INTO inventory.stock_events(id,brand_id,variant_id,location_id,pool_sequence,event_kind,business_effect_key,payload_sha256,
      delta_physical,delta_quarantined,delta_other_non_sellable,delta_allocated,delta_pre_commit_allocations,delta_buffer,actor_user_id,before_balance,after_balance,correlation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18)`,
    [eventId, context.brandId, input.variantId, input.locationId, sequence, kind, input.effectKey, hash,
      input.deltaPhysical ?? 0, input.deltaQuarantined ?? 0, input.deltaOtherNonSellable ?? 0,
      input.deltaCommitted ?? 0, input.deltaAllocated ?? 0, input.deltaBuffer ?? 0, context.userId,
      JSON.stringify(beforeJson), JSON.stringify(afterJson), randomUUID()]);
    if (kind === 'PHYSICAL') {
      await client.query(`INSERT INTO inventory.stock_movements(stock_event_id,brand_id,variant_id,location_id,delta_physical,delta_quarantined,
        delta_other_non_sellable,delta_pre_commit_allocations,movement_reason,business_effect_key,source_type,source_reference,actor_user_id,balance_version_after)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [eventId, context.brandId, input.variantId, input.locationId,
        input.deltaPhysical ?? 0, input.deltaQuarantined ?? 0, input.deltaOtherNonSellable ?? 0, input.deltaAllocated ?? 0,
        input.reason, input.effectKey, input.sourceType, input.sourceReference, context.userId, sequence]);
    } else if (kind === 'BUFFER') {
      await client.query(`INSERT INTO inventory.stock_buffer_events(stock_event_id,brand_id,variant_id,location_id,delta_buffer,business_effect_key,balance_version_after,approved_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [eventId, context.brandId, input.variantId, input.locationId, input.deltaBuffer, input.effectKey, sequence, context.userId]);
    } else {
      const allocation = await client.query(`SELECT id FROM inventory.stock_allocations WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3
        ORDER BY accepted_sequence DESC LIMIT 1`, [context.brandId, input.variantId, input.locationId]);
      if (!allocation.rows[0]) throw failure('STOCK_COMMITMENT_SOURCE_REQUIRED');
      await client.query(`INSERT INTO inventory.stock_commitment_events(stock_event_id,brand_id,variant_id,location_id,allocation_id,delta_allocated,business_effect_key,reason,balance_version_after,delta_pre_commit_allocations)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [eventId, context.brandId, input.variantId, input.locationId, allocation.rows[0].id,
        input.deltaCommitted ?? 0, input.effectKey, input.reason, sequence, input.deltaAllocated ?? 0]);
    }
    const updated = await client.query<StockBalance>(`UPDATE inventory.stock_balances SET physical_on_hand=$4,quarantined=$5,other_non_sellable=$6,
      allocated_not_dispatched=$7,pre_commit_allocations=$8,safety_buffer=$9,row_version=$10,updated_at=now()
      WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3 AND row_version=$11 RETURNING *`,
    [context.brandId, input.variantId, input.locationId, next.physical, next.quarantine, next.other, next.committed, next.allocated, next.buffer, sequence, before.row_version]);
    if (!updated.rowCount) throw failure('STOCK_VERSION_CONFLICT', 409);
    await client.query(`INSERT INTO platform.outbox_events(aggregate_type,aggregate_id,event_type,event_version,event_payload,event_key)
      VALUES('inventory.stock_pool',$1,'inventory.stock.changed',$2,$3::jsonb,$4)`,
    [input.variantId, sequence, JSON.stringify({ brandId: context.brandId, variantId: input.variantId, locationId: input.locationId,
      eventId, eventKind: kind, sequence, businessEffectKey: input.effectKey, sourceReference: input.sourceReference,
      before: beforeJson, after: afterJson }), `stock.${eventId}`]);
    return { ...balanceView(updated.rows[0]), replayed: false, eventSequence: sequence };
  }

  async proposeAdjustment(context: BrandAccessContext, input: { variantId: string; locationId: string; expectedVersion: number; delta: number; reason: string; evidenceRef: string | null; effectKey: string }) {
    return this.transaction(async (client) => {
      await this.authorize(client, context);
      return this.idempotent(client, context, 'adjustment.propose', input.effectKey, input, async () => {
      if (!input.reason.trim() || !Number.isSafeInteger(input.delta) || input.delta === 0 || input.effectKey.length > 114) throw failure('STOCK_ADJUSTMENT_INVALID');
      const result = await client.query<StockBalance>('SELECT * FROM inventory.stock_balances WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3 FOR UPDATE',
        [context.brandId, input.variantId, input.locationId]);
      const pool = result.rows[0]; if (!pool) throw failure('STOCK_TARGET_NOT_FOUND', 404);
      if (Number(pool.row_version) !== input.expectedVersion) throw failure('STOCK_VERSION_CONFLICT', 409);
      const configured = await client.query<{ absolute_units: string; percentage: string; version: string; source_status: string }>(
        `SELECT absolute_units,percentage,version,source_status FROM inventory.stock_adjustment_policy WHERE policy_key='D05' ORDER BY effective_at DESC LIMIT 1`);
      if (!configured.rows[0]) throw failure('STOCK_ADJUSTMENT_POLICY_NOT_CONFIGURED');
      const adjustmentPolicy: AdjustmentPolicy = { absoluteUnits: Number(configured.rows[0].absolute_units),
        percentage: Number(configured.rows[0].percentage), version: configured.rows[0].version };
      const approvalRequired = needsIndependentApproval(input.delta, Number(pool.physical_on_hand), adjustmentPolicy);
      const id = randomUUID();
      await client.query(`INSERT INTO inventory.stock_adjustments(id,brand_id,variant_id,location_id,expected_balance_version,requested_physical_delta,reason_code,evidence_ref,proposed_by,approval_state,business_effect_key,requires_independent_review,approval_policy_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PROPOSED',$10,$11,$12)`,
      [id, context.brandId, input.variantId, input.locationId, input.expectedVersion, input.delta, input.reason, input.evidenceRef, context.userId, input.effectKey, approvalRequired, adjustmentPolicy.version]);
      await client.query(`INSERT INTO inventory.stock_adjustment_events(adjustment_id,brand_id,action,actor_user_id,reason)
        VALUES($1,$2,'PROPOSED',$3,$4)`, [id, context.brandId, context.userId, input.reason]);
      return { id, approvalRequired, approvalPolicyVersion: adjustmentPolicy.version, sourceStatus: configured.rows[0].source_status, state: 'PROPOSED' };
      });
    });
  }

  async decideAdjustment(context: BrandAccessContext, input: { adjustmentId: string; expectedVersion: number; decision: 'APPROVE' | 'REJECT'; reason: string }, key: string) {
    return this.transaction(async (client) => {
      await this.authorize(client, context);
      return this.idempotent(client, context, 'adjustment.decide', key, input, async () => {
      const result = await client.query(`SELECT a.*,s.physical_on_hand,s.row_version FROM inventory.stock_adjustments a JOIN inventory.stock_balances s
        USING(brand_id,variant_id,location_id) WHERE a.id=$1 AND a.brand_id=$2 FOR UPDATE OF a,s`, [input.adjustmentId, context.brandId]);
      const a = result.rows[0]; if (!a) throw failure('STOCK_ADJUSTMENT_NOT_FOUND', 404);
      if (a.approval_state !== 'PROPOSED' || Number(a.expected_balance_version) !== input.expectedVersion || Number(a.row_version) !== input.expectedVersion) throw failure('STOCK_VERSION_CONFLICT', 409);
      if (a.proposed_by === context.userId) throw failure('STOCK_MAKER_CHECKER_REQUIRED', 403);
      if (input.decision === 'REJECT') {
        await client.query(`UPDATE inventory.stock_adjustments SET approval_state='REJECTED',reviewed_by=$2 WHERE id=$1`, [a.id, context.userId]);
        await client.query(`INSERT INTO inventory.stock_adjustment_events(adjustment_id,brand_id,action,actor_user_id,reason)
          VALUES($1,$2,'REJECTED',$3,$4)`, [a.id, context.brandId, context.userId, input.reason]);
        return { id: a.id, state: 'REJECTED' };
      }
      const movement = await this.applyMovement(client, context, { variantId: a.variant_id, locationId: a.location_id,
        expectedVersion: input.expectedVersion, effectKey: `${a.business_effect_key}.apply`, reason: input.reason,
        sourceType: 'ADJUSTMENT', sourceReference: a.id, deltaPhysical: Number(a.requested_physical_delta) });
      const linked = await client.query('SELECT id,stock_event_id FROM inventory.stock_movements WHERE brand_id=$1 AND business_effect_key=$2', [context.brandId, `${a.business_effect_key}.apply`]);
      await client.query(`UPDATE inventory.stock_adjustments SET approval_state='APPLIED',reviewed_by=$2,applied_movement_id=$3 WHERE id=$1`, [a.id, context.userId, linked.rows[0].id]);
      await client.query(`INSERT INTO inventory.stock_adjustment_events(adjustment_id,brand_id,action,actor_user_id,reason,stock_event_id)
        VALUES($1,$2,'APPROVED',$3,$4,$5),($1,$2,'APPLIED',$3,$4,$5)`, [a.id, context.brandId, context.userId, input.reason, linked.rows[0].stock_event_id]);
      return { id: a.id, state: 'APPLIED', movement };
      });
    });
  }

  async submitObservation(context: BrandAccessContext, input: { variantId: string; locationId: string; sourceNamespace: string; sourceReference: string; sourceVersion?: string; asOf: string; meaning: string; quantity: number; rawPayload?: unknown }, key: string) {
    return this.transaction(async (client) => {
      await this.authorize(client, context);
      return this.idempotent(client, context, 'observation.submit', key, input, async () => {
      if (!Number.isSafeInteger(input.quantity) || input.quantity < 0 || !Number.isFinite(Date.parse(input.asOf))) throw failure('STOCK_OBSERVATION_INVALID');
      const previous = await client.query(`SELECT source_as_of,reported_quantity,raw_payload FROM inventory.stock_observations
        WHERE brand_id=$1 AND source_namespace=$2 AND source_reference=$3`, [context.brandId, input.sourceNamespace, input.sourceReference]);
      let freshness: 'CURRENT' | 'STALE' | 'CONFLICT' = 'CURRENT';
      if (previous.rows[0]) {
        const oldAt = Date.parse(previous.rows[0].source_as_of);
        if (Date.parse(input.asOf) < oldAt) freshness = 'STALE';
        else if (Date.parse(input.asOf) === oldAt && Number(previous.rows[0].reported_quantity) !== input.quantity) freshness = 'CONFLICT';
        else throw failure('STOCK_OBSERVATION_ALREADY_RECORDED', 409);
      }
      const pool = await client.query('SELECT row_version FROM inventory.stock_balances WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3', [context.brandId, input.variantId, input.locationId]);
      if (!pool.rows[0]) throw failure('STOCK_TARGET_NOT_FOUND', 404);
      const id = randomUUID();
      await client.query(`INSERT INTO inventory.stock_observations(id,brand_id,variant_id,location_id,source_namespace,source_reference,source_version,source_as_of,reported_meaning,reported_quantity,review_state,raw_payload,freshness_state,expected_balance_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'STAGED',$11::jsonb,$12,$13)`, [id, context.brandId, input.variantId, input.locationId,
        input.sourceNamespace, input.sourceReference, input.sourceVersion ?? null, input.asOf, input.meaning, input.quantity,
        JSON.stringify(input.rawPayload ?? null), freshness, Number(pool.rows[0].row_version)]);
      return { id, state: 'STAGED', freshness, balanceVersion: Number(pool.rows[0].row_version) };
      });
    });
  }

  async transfer(context: BrandAccessContext, input: { variantId: string; fromLocationId: string; toLocationId: string; quantity: number; reason: string; expectedFromVersion: number }, key: string) {
    return this.transaction(async (client) => {
      await this.authorize(client, context);
      return this.idempotent(client, context, 'stock.transfer', key, input, async () => {
        if (input.fromLocationId === input.toLocationId || !Number.isSafeInteger(input.quantity) || input.quantity < 1 || !input.reason.trim()) throw failure('STOCK_TRANSFER_INVALID');
        const locations = [input.fromLocationId, input.toLocationId];
        const valid = await client.query(`SELECT count(*)::integer AS count FROM inventory.stock_locations
          WHERE brand_id=$1 AND id=ANY($2::uuid[]) AND active`, [context.brandId, locations]);
        const variant = await client.query('SELECT 1 FROM catalogue.product_variants WHERE id=$1 AND brand_id=$2', [input.variantId, context.brandId]);
        if (valid.rows[0].count !== 2 || !variant.rowCount) throw failure('STOCK_TARGET_NOT_FOUND', 404);
        for (const locationId of locations) await client.query(`INSERT INTO inventory.stock_balances(brand_id,variant_id,location_id)
          VALUES($1,$2,$3) ON CONFLICT(brand_id,variant_id,location_id) DO NOTHING`, [context.brandId, input.variantId, locationId]);
        const locked = await client.query<StockBalance>(`SELECT * FROM inventory.stock_balances
          WHERE brand_id=$1 AND variant_id=$2 AND location_id=ANY($3::uuid[]) ORDER BY location_id FOR UPDATE`,
        [context.brandId, input.variantId, locations]);
        const from = locked.rows.find((row) => row.location_id === input.fromLocationId);
        const to = locked.rows.find((row) => row.location_id === input.toLocationId);
        if (!from || !to) throw failure('STOCK_TARGET_NOT_FOUND', 404);
        if (Number(from.row_version) !== input.expectedFromVersion) throw failure('STOCK_VERSION_CONFLICT', 409);
        const source = buckets(from);
        const ats = Math.max(0, source.physical - source.quarantine - source.committed - source.allocated - source.buffer);
        if (ats < input.quantity) throw failure('STOCK_TRANSFER_QUANTITY_UNAVAILABLE');
        const transferId = randomUUID();
        const outKey = `transfer.${transferId}.out`;
        const inKey = `transfer.${transferId}.in`;
        await client.query(`INSERT INTO inventory.stock_transfers(id,brand_id,variant_id,from_location_id,to_location_id,quantity,state,dispatch_effect_key,receipt_effect_key)
          VALUES($1,$2,$3,$4,$5,$6,'CREATED',$7,$8)`, [transferId, context.brandId, input.variantId, input.fromLocationId, input.toLocationId, input.quantity, outKey, inKey]);
        const out = await this.applyMovement(client, context, { variantId: input.variantId, locationId: input.fromLocationId,
          expectedVersion: input.expectedFromVersion, effectKey: outKey, reason: 'TRANSFER_OUT', sourceType: 'TRANSFER', sourceReference: transferId, deltaPhysical: -input.quantity });
        const inside = await this.applyMovement(client, context, { variantId: input.variantId, locationId: input.toLocationId,
          expectedVersion: Number(to.row_version), effectKey: inKey, reason: 'TRANSFER_IN', sourceType: 'TRANSFER', sourceReference: transferId, deltaPhysical: input.quantity });
        const events = await client.query(`SELECT id,business_effect_key FROM inventory.stock_events WHERE brand_id=$1 AND business_effect_key=ANY($2::text[])`,
          [context.brandId, [outKey, inKey]]);
        const outEventId = events.rows.find((event) => event.business_effect_key === outKey)?.id;
        const inEventId = events.rows.find((event) => event.business_effect_key === inKey)?.id;
        await client.query(`UPDATE inventory.stock_transfers SET state='RECEIVED',out_event_id=$2,in_event_id=$3,accepted_by=$4,accepted_at=now()
          WHERE id=$1`, [transferId, outEventId, inEventId, context.userId]);
        return { id: transferId, state: 'RECEIVED', quantity: input.quantity, from: out, to: inside };
      });
    });
  }

  async createReturn(context: BrandAccessContext, input: { variantId: string; locationId: string; quantity: number; condition: 'DAMAGED' | 'INSPECT' | 'SELLABLE_CLAIMED'; reason: string; evidenceReference: string | null }, key: string) {
    return this.transaction(async (client) => {
      await this.authorize(client, context);
      return this.idempotent(client, context, 'stock.return.submit', key, input, async () => {
        if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || !input.reason.trim()) throw failure('STOCK_RETURN_INVALID');
        const id = randomUUID(); const eventKey = `return.${id}.quarantine`;
        await this.applyMovement(client, context, { variantId: input.variantId, locationId: input.locationId, effectKey: eventKey,
          reason: 'RETURN_QUARANTINE', sourceType: 'RETURN', sourceReference: id, deltaPhysical: input.quantity, deltaQuarantined: input.quantity });
        const event = await client.query('SELECT id FROM inventory.stock_events WHERE brand_id=$1 AND business_effect_key=$2', [context.brandId, eventKey]);
        await client.query(`INSERT INTO inventory.stock_returns(id,brand_id,variant_id,location_id,quantity,condition,reason,evidence_reference,submitted_by,quarantine_event_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, context.brandId, input.variantId, input.locationId, input.quantity, input.condition,
          input.reason, input.evidenceReference, context.userId, event.rows[0].id]);
        await client.query(`INSERT INTO inventory.stock_return_events(return_id,brand_id,action,actor_user_id,stock_event_id,reason)
          VALUES($1,$2,'QUARANTINED',$3,$4,$5)`, [id, context.brandId, context.userId, event.rows[0].id, input.reason]);
        return { id, state: 'PENDING_INSPECTION', quantity: input.quantity, locationId: input.locationId };
      });
    });
  }

  async decideReturn(context: BrandAccessContext, input: { returnId: string; expectedDecision: 'ACCEPT' | 'REJECT'; reason: string }, key: string) {
    return this.transaction(async (client) => {
      await this.authorize(client, context);
      return this.idempotent(client, context, 'stock.return.decide', key, input, async () => {
        const result = await client.query(`SELECT * FROM inventory.stock_returns WHERE id=$1 AND brand_id=$2 FOR UPDATE`, [input.returnId, context.brandId]);
        const item = result.rows[0]; if (!item) throw failure('STOCK_RETURN_NOT_FOUND', 404);
        if (item.state !== 'PENDING_INSPECTION') throw failure('STOCK_RETURN_ALREADY_DECIDED', 409);
        if (item.submitted_by === context.userId) throw failure('STOCK_MAKER_CHECKER_REQUIRED', 403);
        if (!input.reason.trim()) throw failure('STOCK_RETURN_DECISION_REASON_REQUIRED');
        let eventId: string | null = null;
        if (input.expectedDecision === 'ACCEPT') {
          if (item.condition === 'DAMAGED') throw failure('STOCK_DAMAGED_RETURN_NOT_SELLABLE');
          const movement = await this.applyMovement(client, context, { variantId: item.variant_id, locationId: item.location_id,
            effectKey: `return.${item.id}.release`, reason: 'RETURN_INSPECTED_SELLABLE', sourceType: 'RETURN', sourceReference: item.id,
            deltaQuarantined: -Number(item.quantity) });
          const event = await client.query('SELECT id FROM inventory.stock_events WHERE brand_id=$1 AND business_effect_key=$2', [context.brandId, `return.${item.id}.release`]);
          eventId = event.rows[0].id;
          await client.query(`UPDATE inventory.stock_returns SET state='ACCEPTED',reviewed_by=$2,reviewed_at=now(),release_event_id=$3 WHERE id=$1`,
            [item.id, context.userId, eventId]);
          await client.query(`INSERT INTO inventory.stock_return_events(return_id,brand_id,action,actor_user_id,stock_event_id,reason)
            VALUES($1,$2,'ACCEPTED',$3,$4,$5)`, [item.id, context.brandId, context.userId, eventId, input.reason]);
          return { id: item.id, state: 'ACCEPTED', movement };
        }
        await client.query(`UPDATE inventory.stock_returns SET state='REJECTED',reviewed_by=$2,reviewed_at=now() WHERE id=$1`, [item.id, context.userId]);
        await client.query(`INSERT INTO inventory.stock_return_events(return_id,brand_id,action,actor_user_id,stock_event_id,reason)
          VALUES($1,$2,'REJECTED',$3,$4,$5)`, [item.id, context.brandId, context.userId, item.quarantine_event_id, input.reason]);
        return { id: item.id, state: 'REJECTED', eventId };
      });
    });
  }

  async createCycleCount(context: BrandAccessContext, input: { variantId: string; locationId: string; physical: number; expectedVersion: number }, key: string) {
    return this.transaction(async (client) => {
      await this.authorize(client, context);
      return this.idempotent(client, context, 'cycle_count.create', key, input, async () => {
      if (!Number.isSafeInteger(input.physical) || input.physical < 0) throw failure('STOCK_COUNT_INVALID');
      const result = await client.query<StockBalance>('SELECT * FROM inventory.stock_balances WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3 FOR UPDATE', [context.brandId, input.variantId, input.locationId]);
      const current = result.rows[0]; if (!current) throw failure('STOCK_TARGET_NOT_FOUND', 404);
      if (Number(current.row_version) !== input.expectedVersion) throw failure('STOCK_VERSION_CONFLICT', 409);
      const ledger = await client.query(`SELECT e.pool_sequence,e.event_kind,e.delta_physical,e.delta_quarantined,e.delta_other_non_sellable,e.delta_allocated,e.delta_pre_commit_allocations,e.delta_buffer,e.business_effect_key
        FROM inventory.stock_events e WHERE e.brand_id=$1 AND e.variant_id=$2 AND e.location_id=$3 ORDER BY e.pool_sequence`, [context.brandId, input.variantId, input.locationId]);
      const replay = { physical: 0, quarantine: 0, committed: 0, allocated: 0, buffer: 0 };
      for (const e of ledger.rows) { replay.physical += Number(e.delta_physical); replay.quarantine += Number(e.delta_quarantined) + Number(e.delta_other_non_sellable);
        replay.committed += Number(e.delta_allocated); replay.allocated += Number(e.delta_pre_commit_allocations); replay.buffer += Number(e.delta_buffer); }
      if (!ledger.rowCount) replay.physical = 0;
      const currentBuckets = buckets(current);
      const observed = { physical: Number(current.physical_on_hand), quarantine: currentBuckets.quarantine, committed: currentBuckets.committed, allocated: currentBuckets.allocated, buffer: currentBuckets.buffer };
      const id = randomUUID(); const eventHash = digest(ledger.rows);
      await client.query(`INSERT INTO inventory.cycle_counts(id,brand_id,variant_id,location_id,reported_physical,observed_balance_version,count_state,requested_by,recorded_balance,journal_digest,completed_at)
        VALUES($1,$2,$3,$4,$5,$6,'REVIEWED',$7,$8::jsonb,$9,now())`, [id, context.brandId, input.variantId, input.locationId, input.physical, input.expectedVersion,
        context.userId, JSON.stringify(observed), eventHash]);
      let caseId: string | null = null;
      if (input.physical !== observed.physical || Object.keys(replay).some((key) => replay[key as keyof typeof replay] !== observed[key as keyof typeof observed])) {
        const c = await client.query(`INSERT INTO inventory.reconciliation_cases(brand_id,variant_id,location_id,variance_physical,case_state,reason_code,detection_source,expected_balance,observed_balance)
          VALUES($1,$2,$3,$4,'OPEN','CYCLE_COUNT_DRIFT','JOURNAL_REPLAY',$5::jsonb,$6::jsonb) RETURNING id`,
        [context.brandId, input.variantId, input.locationId, input.physical - replay.physical, JSON.stringify(replay), JSON.stringify(observed)]);
        caseId = c.rows[0].id;
      }
      return { id, caseId, state: caseId ? 'REVIEW_REQUIRED' : 'RECONCILED', journalDigest: eventHash, balanceVersion: input.expectedVersion };
      });
    });
  }

  async listReconciliationCases(context: BrandAccessContext) {
    const pool = this.infrastructure.pool; if (!pool) throw new Error('Inventory database is unavailable');
    const result = await pool.query(`SELECT c.* FROM inventory.reconciliation_cases c WHERE c.brand_id=$1
      AND EXISTS (SELECT 1 FROM access.effective_permissions p WHERE p.user_id=$2 AND p.permission_code=$3
       AND ((p.scope_type='global' AND p.brand_id IS NULL) OR (p.scope_type='brand' AND p.brand_id=c.brand_id))) ORDER BY c.created_at DESC`,
    [context.brandId, context.userId, context.permission]);
    return result.rows;
  }

  async listMovements(context: BrandAccessContext, query: { variantId?: string; locationId?: string; limit: number }) {
    const pool = this.infrastructure.pool; if (!pool) throw new Error('Inventory database is unavailable');
    const result = await pool.query(`SELECT m.id,m.variant_id AS "variantId",m.location_id AS "locationId",m.stock_event_id AS "eventId",
      m.delta_physical AS "deltaPhysical",m.delta_quarantined AS "deltaQuarantined",m.delta_other_non_sellable AS "deltaOtherNonSellable",
      m.movement_reason AS reason,m.source_type AS "sourceType",m.source_reference AS "sourceReference",m.actor_user_id AS "actorUserId",
      m.balance_version_after AS version,m.created_at AS "createdAt"
      FROM inventory.stock_movements m WHERE m.brand_id=$1 AND ($2::uuid IS NULL OR m.variant_id=$2) AND ($3::uuid IS NULL OR m.location_id=$3)
       AND EXISTS (SELECT 1 FROM access.effective_permissions p WHERE p.user_id=$4 AND p.permission_code=$5
        AND ((p.scope_type='global' AND p.brand_id IS NULL) OR (p.scope_type='brand' AND p.brand_id=m.brand_id)))
      ORDER BY m.created_at DESC,m.id DESC LIMIT $6`,
    [context.brandId, query.variantId ?? null, query.locationId ?? null, context.userId, context.permission, Math.max(1, Math.min(query.limit, 100))]);
    return result.rows;
  }

  async resolveCase(context: BrandAccessContext, caseId: string, input: {
    decision: 'DISMISS' | 'COMPENSATE'; expectedVersion: number; reason: string; adjustmentId?: string;
  }, key: string) {
    if (!input.reason.trim() || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
      || (input.decision === 'COMPENSATE') !== Boolean(input.adjustmentId)) throw failure('STOCK_RECONCILIATION_REQUEST_INVALID');
    return this.transaction(async (client) => {
      await this.authorize(client, context);
        return this.idempotent(client, context, 'reconciliation.resolve', key, { caseId, ...input }, async () => {
        const found = await client.query(`SELECT id,variant_id,location_id,row_version,case_state FROM inventory.reconciliation_cases
          WHERE id=$1 AND brand_id=$2 FOR UPDATE`, [caseId, context.brandId]);
        const item = found.rows[0];
        if (!item) throw failure('STOCK_RECONCILIATION_NOT_FOUND', 404);
        if (Number(item.row_version) !== input.expectedVersion) throw failure('STOCK_VERSION_CONFLICT', 409);
        if (!['OPEN','UNDER_REVIEW'].includes(item.case_state)) throw failure('STOCK_RECONCILIATION_ALREADY_CLOSED', 409);
        if (input.decision === 'COMPENSATE') {
          const approved = await client.query(`SELECT 1 FROM inventory.stock_adjustments WHERE id=$1 AND brand_id=$2
            AND variant_id=$3 AND location_id=$4 AND approval_state='APPLIED'`,
          [input.adjustmentId, context.brandId, item.variant_id, item.location_id]);
          if (!approved.rowCount) throw failure('STOCK_RECONCILIATION_ADJUSTMENT_REQUIRED', 409);
        }
        const state = input.decision === 'DISMISS' ? 'DISMISSED' : 'RESOLVED';
        const updated = await client.query(`UPDATE inventory.reconciliation_cases SET case_state=$3,resolution_reason=$4,
          resolution_adjustment_id=$5,resolved_by=$6,resolved_at=now(),row_version=row_version+1
          WHERE id=$1 AND brand_id=$2 AND row_version=$7 RETURNING id,row_version`,
        [caseId, context.brandId, state, input.reason, input.adjustmentId ?? null, context.userId, input.expectedVersion]);
        if (!updated.rowCount) throw failure('STOCK_VERSION_CONFLICT', 409);
        await client.query(`INSERT INTO inventory.reconciliation_case_events(case_id,brand_id,action,actor_user_id,
          expected_case_version,adjustment_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [caseId, context.brandId, input.decision === 'DISMISS' ? 'DISMISSED' : 'COMPENSATED', context.userId,
          input.expectedVersion, input.adjustmentId ?? null, input.reason]);
        return { id: caseId, state, version: Number(updated.rows[0].row_version) };
      });
    });
  }
}
