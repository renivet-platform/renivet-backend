import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PoolClient } from 'pg';
import { IdentityInfrastructure } from '../identity/identity-infrastructure';
import { BrandAccessContext } from '../access/brand-access.guard';
import type { WorkerAuthorizationContext } from '../../workers/worker-authorization';
import { AdjustmentPolicy, needsIndependentApproval, validateBalance } from './inventory-domain';

export interface StockBalance {
  brand_id: string; variant_id: string; location_id: string; physical_on_hand: string;
  quarantined: string; other_non_sellable: string; allocated_not_dispatched: string;
  safety_buffer: string; row_version: string; suspended: boolean;
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
  physical: Number(row.physical_on_hand), quarantine: Number(row.quarantined),
  unsellable: Number(row.other_non_sellable), allocatedNotDispatched: Number(row.allocated_not_dispatched), buffer: Number(row.safety_buffer),
});
const balanceView = (row: StockBalance) => {
  const value = buckets(row); validateBalance(value);
  return { brandId: row.brand_id, variantId: row.variant_id, locationId: row.location_id,
    physical: value.physical, quarantine: value.quarantine, otherNonSellable: value.unsellable,
    allocatedNotDispatched: value.allocatedNotDispatched, buffer: value.buffer,
    availableToSell: Math.max(0, value.physical - value.quarantine - value.unsellable - value.allocatedNotDispatched - value.buffer),
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
      await this.ensureGenesis(client, context, variantId, locationId);
      return balanceView(result.rows[0]);
    });
  }

  private async ensureGenesis(client: PoolClient, context: BrandAccessContext, variantId: string, locationId: string) {
    const locked = await client.query<StockBalance>(`SELECT * FROM inventory.stock_balances
      WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3 FOR UPDATE`, [context.brandId, variantId, locationId]);
    const balance = locked.rows[0];
    if (!balance) throw failure('STOCK_TARGET_NOT_FOUND', 404);
    const effectKey = `genesis.${variantId}.${locationId}`;
    const prior = await client.query(`SELECT pool_sequence,variant_id,location_id FROM inventory.stock_events
      WHERE brand_id=$1 AND business_effect_key=$2`, [context.brandId, effectKey]);
    if (prior.rows[0]) {
      if (Number(prior.rows[0].pool_sequence) !== 1 || prior.rows[0].variant_id !== variantId || prior.rows[0].location_id !== locationId) {
        throw failure('STOCK_POOL_GENESIS_INVALID', 409);
      }
      return balance;
    }
    const existingEvents = await client.query(`SELECT 1 FROM inventory.stock_events
      WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3 LIMIT 1`, [context.brandId, variantId, locationId]);
    if (existingEvents.rowCount || Number(balance.row_version) !== 1 || Number(balance.physical_on_hand) !== 0
      || Number(balance.quarantined) !== 0 || Number(balance.other_non_sellable) !== 0
      || Number(balance.allocated_not_dispatched) !== 0 || Number(balance.safety_buffer) !== 0) {
      throw failure('STOCK_POOL_GENESIS_REQUIRES_REVIEW', 409);
    }
    const eventId = randomUUID();
    const snapshot = balanceView(balance);
    const payloadHash = digest({ brandId: context.brandId, variantId, locationId, eventKind: 'GENESIS', sequence: 1 });
    await client.query(`INSERT INTO inventory.stock_events(id,brand_id,variant_id,location_id,pool_sequence,event_kind,business_effect_key,payload_sha256,
      delta_physical,delta_quarantined,delta_other_non_sellable,delta_allocated,delta_buffer,actor_user_id,before_balance,after_balance,correlation_id)
      VALUES($1,$2,$3,$4,1,'PHYSICAL',$5,$6,0,0,0,0,0,$7,$8::jsonb,$8::jsonb,$9)`,
    [eventId, context.brandId, variantId, locationId, effectKey, payloadHash, context.userId, JSON.stringify(snapshot), randomUUID()]);
    await client.query(`INSERT INTO inventory.stock_movements(stock_event_id,brand_id,variant_id,location_id,delta_physical,delta_quarantined,
      delta_other_non_sellable,movement_reason,business_effect_key,source_type,source_reference,actor_user_id,balance_version_after)
      VALUES($1,$2,$3,$4,0,0,0,'GENESIS',$5,'SYSTEM',$6,$7,1)`,
    [eventId, context.brandId, variantId, locationId, effectKey, `pool:${variantId}:${locationId}`, context.userId]);
    await client.query(`INSERT INTO platform.outbox_events(aggregate_type,aggregate_id,event_type,event_version,event_payload,event_key)
      VALUES('inventory.stock_pool',$1,'inventory.stock.changed',1,$2::jsonb,$3)`,
    [variantId, JSON.stringify({ brandId: context.brandId, variantId, locationId, eventId, eventKind: 'GENESIS', sequence: 1,
      businessEffectKey: effectKey, sourceReference: `pool:${variantId}:${locationId}`, before: snapshot, after: snapshot }), `stock.${eventId}`]);
    return balance;
  }

  async openingReceipt(context: BrandAccessContext, input: {
    variantId: string; locationId: string; quantity: number; unit: 'EACH'; sourceType: string; sourceReference: string;
  }, key: string) {
    return this.transaction(async (client) => {
      await this.authorize(client, context);
      return this.idempotent(client, context, 'stock.opening_receipt', key, input, async () => {
        if (input.unit !== 'EACH' || !Number.isSafeInteger(input.quantity) || input.quantity < 1
          || !input.sourceType.trim() || !input.sourceReference.trim()) throw failure('STOCK_OPENING_RECEIPT_INVALID');
        const targets = await client.query(`SELECT
          EXISTS(SELECT 1 FROM catalogue.product_variants WHERE id=$2 AND brand_id=$1) AS variant_ok,
          EXISTS(SELECT 1 FROM inventory.stock_locations WHERE id=$3 AND brand_id=$1 AND active) AS location_ok`,
        [context.brandId, input.variantId, input.locationId]);
        if (!targets.rows[0].variant_ok || !targets.rows[0].location_ok) throw failure('STOCK_TARGET_NOT_FOUND', 404);
        await client.query(`INSERT INTO inventory.stock_balances(brand_id,variant_id,location_id) VALUES($1,$2,$3)
          ON CONFLICT(brand_id,variant_id,location_id) DO NOTHING`, [context.brandId, input.variantId, input.locationId]);
        const effectKey = `opening.${digest([context.brandId,input.variantId,input.locationId,input.sourceType,input.sourceReference]).slice(0,48)}`;
        const prior = await client.query('SELECT 1 FROM inventory.stock_events WHERE brand_id=$1 AND business_effect_key=$2', [context.brandId, effectKey]);
        const balance = await client.query<StockBalance>(`SELECT * FROM inventory.stock_balances
          WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3 FOR UPDATE`, [context.brandId, input.variantId, input.locationId]);
        const current = balance.rows[0];
        if (!current) throw failure('STOCK_TARGET_NOT_FOUND', 404);
        if (!prior.rowCount && (Number(current.row_version) !== 1 || Number(current.physical_on_hand) !== 0
          || Number(current.quarantined) !== 0 || Number(current.other_non_sellable) !== 0
          || Number(current.allocated_not_dispatched) !== 0 || Number(current.safety_buffer) !== 0)) {
          throw failure('STOCK_POOL_ALREADY_OPENED', 409);
        }
        const result = await this.applyMovement(client, context, { variantId: input.variantId, locationId: input.locationId,
          expectedVersion: prior.rowCount ? undefined : 1, effectKey, reason: 'OPENING_RECEIPT', sourceType: input.sourceType,
          sourceReference: input.sourceReference, deltaPhysical: input.quantity });
        return { ...result, opened: !prior.rowCount };
      });
    });
  }

  /**
   * Apply one internally authorized verified-checkout line to its stock pool.
   * The context must come from the durable worker authorization port; request
   * bodies and HTTP callers must never construct this authority themselves.
   */
  async allocateTrusted(authorization: WorkerAuthorizationContext, input: {
    brandId: string; checkoutId: string; checkoutLineId: string; acceptedSequence: number;
    variantId: string; locationId: string; quantity: number; idempotencyKey: string;
  }) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!authorization || typeof authorization.principalId !== 'string' ||
      !/^[a-z][a-z0-9._-]{0,127}$/.test(authorization.principalId) ||
      typeof authorization.jobId !== 'string' || !uuid.test(authorization.jobId) ||
      typeof authorization.sourceEventId !== 'string' || !uuid.test(authorization.sourceEventId) ||
      authorization.purpose !== 'inventory.allocate' || !Array.isArray(authorization.effects) ||
      !authorization.effects.includes('inventory.allocate') || typeof authorization.authorizeEffect !== 'function') {
      throw failure('WORKER_AUTHORIZATION_DENIED', 403);
    }
    if (!input || !uuid.test(input.brandId) ||
      !uuid.test(input.checkoutId) || !uuid.test(input.checkoutLineId) || !uuid.test(input.variantId) ||
      !uuid.test(input.locationId) || !Number.isSafeInteger(input.acceptedSequence) || input.acceptedSequence < 1 ||
      !Number.isSafeInteger(input.quantity) || input.quantity < 1 ||
      !/^[A-Za-z0-9._:-]{1,120}$/.test(input.idempotencyKey)) throw failure('STOCK_ALLOCATION_REQUEST_INVALID');
    if (input.brandId !== authorization.brandId) throw failure('WORKER_AUTHORIZATION_DENIED', 403);

    // Effect authorization is checked against the worker's server-resolved brand
    // before any stock lookup, so a caller cannot probe another tenant's IDs.
    await authorization.authorizeEffect('inventory.allocate', input.brandId);
    return this.transaction(async (client) => {
      const lockKeys = [
        `inventory.receipt:${input.brandId}:checkout.allocate:${input.idempotencyKey}`,
        `inventory.allocation:${input.brandId}:${input.checkoutId}:${input.checkoutLineId}:${input.locationId}`,
      ].sort();
      for (const lockKey of lockKeys) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [lockKey]);

      const source = await client.query(`SELECT aggregate_type,event_type,aggregate_id,event_payload->>'brandId' AS brand_id
        FROM platform.outbox_events WHERE id=$1 FOR SHARE`,
      [authorization.sourceEventId]);
      const accepted = source.rows[0];
      if (!accepted || accepted.aggregate_type !== 'checkout.order' || accepted.event_type !== 'checkout.accepted' ||
        accepted.aggregate_id !== input.checkoutId || accepted.brand_id !== input.brandId) {
        throw failure('WORKER_SOURCE_NOT_VERIFIED', 403);
      }

      const request = { ...input, actor: authorization.principalId,
        sourceEventId: authorization.sourceEventId };
      const requestHash = digest(request);
      const prior = await client.query<{ request_sha256: string; response: Record<string, unknown> }>(
        `SELECT request_sha256,response FROM inventory.stock_command_receipts
         WHERE brand_id=$1 AND operation='checkout.allocate' AND idempotency_key=$2 FOR UPDATE`,
        [input.brandId, input.idempotencyKey]);
      if (prior.rows[0]) {
        if (prior.rows[0].request_sha256 !== requestHash) throw failure('IDEMPOTENCY_KEY_REUSED', 409);
        return { ...prior.rows[0].response, replayed: true };
      }

      const existing = await client.query(`SELECT id,brand_id,variant_id,location_id,checkout_id,checkout_line_id,
          accepted_sequence,quantity,allocation_state FROM inventory.stock_allocations
        WHERE checkout_id=$1 AND checkout_line_id=$2 AND location_id=$3 FOR UPDATE`,
      [input.checkoutId, input.checkoutLineId, input.locationId]);
      if (existing.rows[0]) {
        const allocation = existing.rows[0];
        if (allocation.brand_id !== input.brandId || allocation.variant_id !== input.variantId ||
          Number(allocation.accepted_sequence) !== input.acceptedSequence || Number(allocation.quantity) !== input.quantity) {
          throw failure('CHECKOUT_ALLOCATION_CONFLICT', 409);
        }
        const response = { state: allocation.allocation_state, allocationId: allocation.id,
          acceptedSequence: Number(allocation.accepted_sequence), replayed: true };
        await this.recordWorkerAllocationReceipt(client, authorization, input, requestHash, response);
        return response;
      }

      const target = await client.query(`SELECT 1 FROM catalogue.product_variants v
        JOIN brands.brands b ON b.id=v.brand_id AND b.onboarding_state='approved'
        JOIN inventory.stock_locations l ON l.brand_id=v.brand_id AND l.id=$3 AND l.active
        WHERE v.id=$2 AND v.brand_id=$1`, [input.brandId, input.variantId, input.locationId]);
      if (!target.rowCount) throw failure('STOCK_TARGET_NOT_FOUND', 404);
      const locked = await client.query<StockBalance>(`SELECT * FROM inventory.stock_balances
        WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3 FOR UPDATE`, [input.brandId, input.variantId, input.locationId]);
      const before = locked.rows[0];
      let response: Record<string, unknown>;
      if (!before) {
        response = { state: 'PAID_STOCK_UNAVAILABLE', allocationId: null,
          acceptedSequence: input.acceptedSequence, reason: 'NO_STOCK_POOL', replayed: false };
      } else {
        const snapshot = balanceView(before);
        if (snapshot.suspended || snapshot.availableToSell < input.quantity) {
          response = { state: 'PAID_STOCK_UNAVAILABLE', allocationId: null,
            acceptedSequence: input.acceptedSequence,
            reason: snapshot.suspended ? 'STOCK_POOL_SUSPENDED' : 'INSUFFICIENT_AVAILABLE_STOCK', replayed: false };
        } else {
          const allocationId = randomUUID();
          const eventId = randomUUID();
          const sequence = Number(before.row_version) + 1;
          const effectKey = `allocation.${digest([input.brandId,input.checkoutId,input.checkoutLineId,input.locationId]).slice(0,48)}`;
          const after = { ...snapshot, allocatedNotDispatched: snapshot.allocatedNotDispatched + input.quantity,
            availableToSell: snapshot.availableToSell - input.quantity, version: sequence };
          const eventHash = digest({ allocationId, ...request, before: snapshot, after });
          const updated = await client.query<StockBalance>(`UPDATE inventory.stock_balances SET allocated_not_dispatched=$4,
            row_version=$5,updated_at=now() WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3 AND row_version=$6 RETURNING *`,
          [input.brandId, input.variantId, input.locationId, after.allocatedNotDispatched, sequence, before.row_version]);
          if (!updated.rowCount) throw failure('STOCK_VERSION_CONFLICT', 409);
          await client.query(`INSERT INTO inventory.stock_allocations(id,brand_id,variant_id,location_id,checkout_id,
            checkout_line_id,accepted_sequence,quantity,allocation_state)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ALLOCATED')`,
          [allocationId,input.brandId,input.variantId,input.locationId,input.checkoutId,input.checkoutLineId,
            input.acceptedSequence,input.quantity]);
          await client.query(`INSERT INTO inventory.stock_events(id,brand_id,variant_id,location_id,pool_sequence,event_kind,
            business_effect_key,payload_sha256,delta_physical,delta_quarantined,delta_other_non_sellable,delta_allocated,
            delta_buffer,actor_user_id,actor_service_principal,source_event_id,before_balance,after_balance,correlation_id)
            VALUES($1,$2,$3,$4,$5,'COMMITMENT',$6,$7,0,0,0,$8,0,NULL,$9,$10,$11::jsonb,$12::jsonb,$13)`,
          [eventId,input.brandId,input.variantId,input.locationId,sequence,effectKey,eventHash,input.quantity,
            authorization.principalId,authorization.sourceEventId,JSON.stringify(snapshot),JSON.stringify(after),randomUUID()]);
          await client.query(`INSERT INTO inventory.stock_commitment_events(stock_event_id,brand_id,variant_id,location_id,
            allocation_id,delta_allocated,business_effect_key,reason,balance_version_after)
            VALUES($1,$2,$3,$4,$5,$6,$7,'CHECKOUT_ACCEPTED',$8)`,
          [eventId,input.brandId,input.variantId,input.locationId,allocationId,input.quantity,effectKey,sequence]);
          await client.query(`INSERT INTO platform.outbox_events(aggregate_type,aggregate_id,event_type,event_version,event_payload,event_key)
            VALUES('inventory.stock_pool',$1,'inventory.stock.changed',1,$2::jsonb,$3)`,
          [input.variantId,JSON.stringify({ brandId: input.brandId, variantId: input.variantId,
            locationId: input.locationId, allocationId, eventId, eventKind: 'COMMITMENT', sequence,
            sourceEventId: authorization.sourceEventId, acceptedSequence: input.acceptedSequence,
            before: snapshot, after }),`stock.${eventId}`]);
          response = { state: 'ALLOCATED', allocationId, acceptedSequence: input.acceptedSequence,
            eventSequence: sequence, balanceVersion: sequence, replayed: false };
        }
      }
      await this.recordWorkerAllocationReceipt(client, authorization, input, requestHash, response);
      return response;
    });
  }

  private async recordWorkerAllocationReceipt(client: PoolClient, authorization: WorkerAuthorizationContext,
    input: { brandId: string; idempotencyKey: string }, requestHash: string, response: Record<string, unknown>): Promise<void> {
    await client.query(`INSERT INTO inventory.stock_command_receipts(brand_id,operation,idempotency_key,request_sha256,
      response,actor_user_id,actor_service_principal,source_event_id)
      VALUES($1,'checkout.allocate',$2,$3,$4::jsonb,NULL,$5,$6)`,
    [input.brandId,input.idempotencyKey,requestHash,JSON.stringify(response),authorization.principalId,authorization.sourceEventId]);
  }

  async movement(context: BrandAccessContext, input: {
    variantId: string; locationId: string; expectedVersion?: number; effectKey: string; reason: string; allocationId?: string;
    sourceType: string; sourceReference: string; deltaPhysical?: number; deltaQuarantined?: number;
    deltaOtherNonSellable?: number; deltaAllocated?: number; deltaBuffer?: number;
  }) {
    return this.transaction(async (client) => {
      await this.authorize(client, context);
      return this.applyMovement(client, context, input);
    });
  }

  private async applyMovement(client: PoolClient, context: BrandAccessContext, input: {
    variantId: string; locationId: string; expectedVersion?: number; effectKey: string; reason: string; allocationId?: string;
    sourceType: string; sourceReference: string; deltaPhysical?: number; deltaQuarantined?: number;
    deltaOtherNonSellable?: number; deltaAllocated?: number; deltaBuffer?: number;
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
    await this.ensureGenesis(client, context, input.variantId, input.locationId);
    const locked = await client.query<StockBalance>(`SELECT * FROM inventory.stock_balances WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3 FOR UPDATE`,
      [context.brandId, input.variantId, input.locationId]);
    const before = locked.rows[0]; if (!before) throw failure('STOCK_TARGET_NOT_FOUND', 404);
    if (input.expectedVersion !== undefined && Number(before.row_version) !== input.expectedVersion) throw failure('STOCK_VERSION_CONFLICT', 409);
    const next = {
      physical: Number(before.physical_on_hand) + (input.deltaPhysical ?? 0),
      quarantine: Number(before.quarantined) + (input.deltaQuarantined ?? 0),
      other: Number(before.other_non_sellable) + (input.deltaOtherNonSellable ?? 0),
      allocatedNotDispatched: Number(before.allocated_not_dispatched) + (input.deltaAllocated ?? 0),
      buffer: Number(before.safety_buffer) + (input.deltaBuffer ?? 0),
    };
    const kind = (input.deltaPhysical || input.deltaQuarantined || input.deltaOtherNonSellable) ? 'PHYSICAL'
      : input.deltaBuffer ? 'BUFFER' : 'COMMITMENT';
    const availableToSell = next.physical - next.quarantine - next.other - next.allocatedNotDispatched - next.buffer;
    if (Object.values(next).some((n) => !Number.isSafeInteger(n) || n < 0)
      || next.physical < next.quarantine + next.other
      || kind === 'PHYSICAL' && availableToSell < 0
      || (kind === 'COMMITMENT' || (kind === 'BUFFER' && (input.deltaBuffer ?? 0) > 0)) && availableToSell < 0) {
      throw failure('STOCK_BALANCE_INVALID');
    }
    const sequence = Number(before.row_version) + 1;
    if (kind === 'PHYSICAL' && (input.deltaAllocated || input.deltaBuffer)
      || kind === 'BUFFER' && (input.deltaPhysical || input.deltaQuarantined || input.deltaOtherNonSellable || input.deltaAllocated)) {
      throw failure('STOCK_EVENT_KIND_INVALID');
    }
    const eventId = randomUUID();
    const beforeJson = balanceView(before);
    const afterJson = { ...beforeJson, physical: next.physical, quarantine: next.quarantine,
      otherNonSellable: next.other, allocatedNotDispatched: next.allocatedNotDispatched, buffer: next.buffer,
      availableToSell: Math.max(0, next.physical - next.quarantine - next.other - next.allocatedNotDispatched - next.buffer), version: sequence };
    await client.query(`INSERT INTO inventory.stock_events(id,brand_id,variant_id,location_id,pool_sequence,event_kind,business_effect_key,payload_sha256,
      delta_physical,delta_quarantined,delta_other_non_sellable,delta_allocated,delta_buffer,actor_user_id,before_balance,after_balance,correlation_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16::jsonb,$17)`,
    [eventId, context.brandId, input.variantId, input.locationId, sequence, kind, input.effectKey, hash,
      input.deltaPhysical ?? 0, input.deltaQuarantined ?? 0, input.deltaOtherNonSellable ?? 0,
      input.deltaAllocated ?? 0, input.deltaBuffer ?? 0, context.userId, JSON.stringify(beforeJson), JSON.stringify(afterJson), randomUUID()]);
    if (kind === 'PHYSICAL') {
      await client.query(`INSERT INTO inventory.stock_movements(stock_event_id,brand_id,variant_id,location_id,delta_physical,delta_quarantined,
        delta_other_non_sellable,movement_reason,business_effect_key,source_type,source_reference,actor_user_id,balance_version_after)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [eventId, context.brandId, input.variantId, input.locationId,
        input.deltaPhysical ?? 0, input.deltaQuarantined ?? 0, input.deltaOtherNonSellable ?? 0,
        input.reason, input.effectKey, input.sourceType, input.sourceReference, context.userId, sequence]);
    } else if (kind === 'BUFFER') {
      await client.query(`INSERT INTO inventory.stock_buffer_events(stock_event_id,brand_id,variant_id,location_id,delta_buffer,business_effect_key,balance_version_after,approved_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [eventId, context.brandId, input.variantId, input.locationId, input.deltaBuffer, input.effectKey, sequence, context.userId]);
    } else {
      if (!input.allocationId || !(input.deltaAllocated)) throw failure('STOCK_COMMITMENT_SOURCE_REQUIRED');
      const allocation = await client.query(`SELECT quantity FROM inventory.stock_allocations
        WHERE id=$1 AND brand_id=$2 AND variant_id=$3 AND location_id=$4 FOR UPDATE`,
      [input.allocationId, context.brandId, input.variantId, input.locationId]);
      const applied = allocation.rows[0] && await client.query(`SELECT COALESCE(sum(delta_allocated),0)::bigint AS quantity
        FROM inventory.stock_commitment_events WHERE allocation_id=$1`, [input.allocationId]);
      if (!allocation.rows[0] || Number(applied?.rows[0].quantity ?? 0) + input.deltaAllocated < 0
        || Number(applied?.rows[0].quantity ?? 0) + input.deltaAllocated > Number(allocation.rows[0].quantity)) {
        throw failure('STOCK_ALLOCATION_QUANTITY_INVALID');
      }
      await client.query(`INSERT INTO inventory.stock_commitment_events(stock_event_id,brand_id,variant_id,location_id,allocation_id,delta_allocated,business_effect_key,reason,balance_version_after)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [eventId, context.brandId, input.variantId, input.locationId, input.allocationId,
        input.deltaAllocated, input.effectKey, input.reason, sequence]);
    }
    const updated = await client.query<StockBalance>(`UPDATE inventory.stock_balances SET physical_on_hand=$4,quarantined=$5,other_non_sellable=$6,
      allocated_not_dispatched=$7,safety_buffer=$8,row_version=$9,updated_at=now()
      WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3 AND row_version=$10 RETURNING *`,
    [context.brandId, input.variantId, input.locationId, next.physical, next.quarantine, next.other, next.allocatedNotDispatched, next.buffer, sequence, before.row_version]);
    if (!updated.rowCount) throw failure('STOCK_VERSION_CONFLICT', 409);
    await client.query(`INSERT INTO platform.outbox_events(aggregate_type,aggregate_id,event_type,event_version,event_payload,event_key)
      VALUES('inventory.stock_pool',$1,'inventory.stock.changed',$2,$3::jsonb,$4)`,
    [input.variantId, sequence, JSON.stringify({ brandId: context.brandId, variantId: input.variantId, locationId: input.locationId,
      eventId, eventKind: kind, sequence, businessEffectKey: input.effectKey, sourceReference: input.sourceReference,
      before: beforeJson, after: afterJson }), `stock.${eventId}`]);
    return { ...balanceView(updated.rows[0]), replayed: false, eventSequence: sequence };
  }

  async proposeAdjustment(context: BrandAccessContext, input: { variantId: string; locationId: string; expectedVersion: number; delta: number; reason: string; evidenceRef: string | null; effectKey: string; reconciliationCaseId?: string; sourceObservationId?: string }) {
    return this.transaction(async (client) => {
      await this.authorize(client, context);
      return this.idempotent(client, context, 'adjustment.propose', input.effectKey, input, async () => {
      if (!input.reason.trim() || !Number.isSafeInteger(input.delta) || input.delta === 0 || input.effectKey.length > 114) throw failure('STOCK_ADJUSTMENT_INVALID');
      const result = await client.query<StockBalance>('SELECT * FROM inventory.stock_balances WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3 FOR UPDATE',
        [context.brandId, input.variantId, input.locationId]);
      const pool = result.rows[0]; if (!pool) throw failure('STOCK_TARGET_NOT_FOUND', 404);
      if (Number(pool.row_version) !== input.expectedVersion) throw failure('STOCK_VERSION_CONFLICT', 409);
      const physicalBefore = Number(pool.physical_on_hand);
      if (physicalBefore + input.delta < 0) throw failure('STOCK_BALANCE_INVALID');
      if (input.sourceObservationId) {
        const observation = await client.query(`SELECT source_as_of,source_mode,reported_meaning,reported_quantity,review_state,
          freshness_state,expected_balance_version FROM inventory.stock_observations
          WHERE id=$1 AND brand_id=$2 AND variant_id=$3 AND location_id=$4 FOR UPDATE`,
        [input.sourceObservationId, context.brandId, input.variantId, input.locationId]);
        const observed = observation.rows[0];
        const sourceAge = observed ? Date.now() - Date.parse(observed.source_as_of) : Number.POSITIVE_INFINITY;
        const pauseAfter = observed?.source_mode === 'CONNECTED' ? 60 * 60_000 : 48 * 60 * 60_000;
        if (!observed || observed.review_state !== 'STAGED' || observed.reported_meaning !== 'physical'
          || observed.freshness_state === 'STALE' || observed.freshness_state === 'CONFLICT' || sourceAge >= pauseAfter
          || Number(observed.expected_balance_version) !== input.expectedVersion) throw failure('STOCK_OBSERVATION_REQUIRES_REVIEW', 409);
        if (Number(observed.reported_quantity) - physicalBefore !== input.delta) throw failure('STOCK_OBSERVATION_DELTA_MISMATCH', 409);
      }
      if (input.reconciliationCaseId) {
        const linkedCase = await client.query(`SELECT variance_physical,counted_physical,expected_balance_version,case_state
          FROM inventory.reconciliation_cases WHERE id=$1 AND brand_id=$2 AND variant_id=$3 AND location_id=$4 FOR UPDATE`,
        [input.reconciliationCaseId, context.brandId, input.variantId, input.locationId]);
        const item = linkedCase.rows[0];
        if (!item || item.case_state !== 'OPEN') throw failure('STOCK_RECONCILIATION_CASE_NOT_FOUND', 404);
        if (Number(item.expected_balance_version) !== input.expectedVersion || Number(item.variance_physical) !== input.delta
          || item.counted_physical === null) throw failure('STOCK_RECONCILIATION_CORRECTION_MISMATCH', 409);
      }
      const configured = await client.query<{ absolute_units: string; percentage: string; version: string; source_status: string }>(
        `SELECT absolute_units,percentage,version,source_status FROM inventory.stock_adjustment_policy WHERE policy_key='D05' ORDER BY effective_at DESC LIMIT 1`);
      if (!configured.rows[0]) throw failure('STOCK_ADJUSTMENT_POLICY_NOT_CONFIGURED');
      const adjustmentPolicy: AdjustmentPolicy = { absoluteUnits: Number(configured.rows[0].absolute_units),
        percentage: Number(configured.rows[0].percentage), version: configured.rows[0].version };
      const approvalRequired = needsIndependentApproval(input.delta, Number(pool.physical_on_hand), adjustmentPolicy);
      const id = randomUUID();
      await client.query(`INSERT INTO inventory.stock_adjustments(id,brand_id,variant_id,location_id,expected_balance_version,requested_physical_delta,reason_code,evidence_ref,proposed_by,approval_state,business_effect_key,requires_independent_review,approval_policy_version,reconciliation_case_id,source_observation_id,physical_before,physical_after)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'PROPOSED',$10,$11,$12,$13,$14,$15,$16)`,
      [id, context.brandId, input.variantId, input.locationId, input.expectedVersion, input.delta, input.reason, input.evidenceRef, context.userId,
        input.effectKey, approvalRequired, adjustmentPolicy.version, input.reconciliationCaseId ?? null, input.sourceObservationId ?? null,
        physicalBefore, physicalBefore === null ? null : physicalBefore + input.delta]);
      await client.query(`INSERT INTO inventory.stock_adjustment_events(adjustment_id,brand_id,action,actor_user_id,reason)
        VALUES($1,$2,'PROPOSED',$3,$4)`, [id, context.brandId, context.userId, input.reason]);
      if (input.sourceObservationId) await client.query(`UPDATE inventory.stock_observations SET review_state='PROPOSED',
        decision_reason=$3 WHERE id=$1 AND brand_id=$2`, [input.sourceObservationId, context.brandId, `Adjustment ${id} proposed for independent review.`]);
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
        if (a.source_observation_id) await client.query(`UPDATE inventory.stock_observations SET review_state='REJECTED',reviewed_by=$2,reviewed_at=now(),decision_reason=$3 WHERE id=$1`,
          [a.source_observation_id, context.userId, input.reason]);
        await client.query(`INSERT INTO inventory.stock_adjustment_events(adjustment_id,brand_id,action,actor_user_id,reason)
          VALUES($1,$2,'REJECTED',$3,$4)`, [a.id, context.brandId, context.userId, input.reason]);
        return { id: a.id, state: 'REJECTED' };
      }
      const movement = await this.applyMovement(client, context, { variantId: a.variant_id, locationId: a.location_id,
        expectedVersion: input.expectedVersion, effectKey: `${a.business_effect_key}.apply`, reason: input.reason,
        sourceType: 'ADJUSTMENT', sourceReference: a.id, deltaPhysical: Number(a.requested_physical_delta) });
      const linked = await client.query('SELECT id,stock_event_id FROM inventory.stock_movements WHERE brand_id=$1 AND business_effect_key=$2', [context.brandId, `${a.business_effect_key}.apply`]);
      await client.query(`UPDATE inventory.stock_adjustments SET approval_state='APPLIED',reviewed_by=$2,applied_movement_id=$3 WHERE id=$1`, [a.id, context.userId, linked.rows[0].id]);
      if (a.source_observation_id) await client.query(`UPDATE inventory.stock_observations SET review_state='ACCEPTED',reviewed_by=$2,reviewed_at=now(),decision_reason=$3 WHERE id=$1`,
        [a.source_observation_id, context.userId, input.reason]);
      await client.query(`INSERT INTO inventory.stock_adjustment_events(adjustment_id,brand_id,action,actor_user_id,reason,stock_event_id)
        VALUES($1,$2,'APPROVED',$3,$4,$5),($1,$2,'APPLIED',$3,$4,$5)`, [a.id, context.brandId, context.userId, input.reason, linked.rows[0].stock_event_id]);
      return { id: a.id, state: 'APPLIED', movement };
      });
    });
  }

  async listAdjustments(context: BrandAccessContext, limit = 50) {
    return this.transaction(async (client) => {
      await this.authorize(client, context);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw failure('STOCK_PAGE_SIZE_INVALID');
      const result = await client.query(`SELECT a.*,coalesce(json_agg(json_build_object('action',e.action,'actorUserId',e.actor_user_id,
          'reason',e.reason,'stockEventId',e.stock_event_id,'recordedAt',e.recorded_at)
          ORDER BY e.recorded_at,CASE e.action WHEN 'PROPOSED' THEN 0 WHEN 'APPROVED' THEN 1 WHEN 'REJECTED' THEN 1 ELSE 2 END,e.id)
          FILTER (WHERE e.id IS NOT NULL),'[]'::json) AS history
        FROM inventory.stock_adjustments a LEFT JOIN inventory.stock_adjustment_events e
          ON e.adjustment_id=a.id AND e.brand_id=a.brand_id
        WHERE a.brand_id=$1 GROUP BY a.id ORDER BY a.created_at DESC,a.id LIMIT $2`, [context.brandId, limit]);
      return result.rows;
    });
  }

  async submitObservation(context: BrandAccessContext, input: { variantId: string; locationId: string; sourceNamespace: string; sourceReference: string; sourceVersion?: string; asOf: string; meaning: string; quantity: number; rawPayload?: unknown; sourceMode?: 'MANUAL' | 'CONNECTED' }, key: string) {
    return this.transaction(async (client) => {
      await this.authorize(client, context);
      return this.idempotent(client, context, 'observation.submit', key, input, async () => {
      const asOf = Date.parse(input.asOf); const sourceMode = input.sourceMode ?? 'MANUAL';
      if (!Number.isSafeInteger(input.quantity) || input.quantity < 0 || !Number.isFinite(asOf) || asOf > Date.now()
        || !['MANUAL','CONNECTED'].includes(sourceMode)) throw failure('STOCK_OBSERVATION_INVALID');
      const previous = await client.query(`SELECT source_as_of,reported_quantity,raw_payload,
          $6::timestamptz<source_as_of AS older_than_latest,$6::timestamptz=source_as_of AS same_as_latest
        FROM inventory.stock_observations WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3 AND source_namespace=$4 AND source_reference=$5
        ORDER BY source_as_of DESC,submitted_at DESC,id DESC LIMIT 1`,
      [context.brandId, input.variantId, input.locationId, input.sourceNamespace, input.sourceReference, input.asOf]);
      let freshness: 'CURRENT' | 'ALERT' | 'PAUSED' | 'STALE' | 'CONFLICT' = 'CURRENT';
      if (previous.rows[0]) {
        if (previous.rows[0].older_than_latest) freshness = 'STALE';
        else if (previous.rows[0].same_as_latest && Number(previous.rows[0].reported_quantity) !== input.quantity) freshness = 'CONFLICT';
        // Same-timestamp reports with identical quantities are harmless duplicate
        // observations; different values are retained as explicit conflicts.
      }
      const sourceAge = Date.now() - asOf;
      const alertAfter = sourceMode === 'CONNECTED' ? 15 * 60_000 : 24 * 60 * 60_000;
      const pauseAfter = sourceMode === 'CONNECTED' ? 60 * 60_000 : 48 * 60 * 60_000;
      if (freshness === 'CURRENT' && sourceAge >= pauseAfter) freshness = 'PAUSED';
      else if (freshness === 'CURRENT' && sourceAge >= alertAfter) freshness = 'ALERT';
      const pool = await client.query('SELECT row_version FROM inventory.stock_balances WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3', [context.brandId, input.variantId, input.locationId]);
      if (!pool.rows[0]) throw failure('STOCK_TARGET_NOT_FOUND', 404);
      const id = randomUUID();
      await client.query(`INSERT INTO inventory.stock_observations(id,brand_id,variant_id,location_id,source_namespace,source_reference,source_version,source_as_of,reported_meaning,reported_quantity,review_state,raw_payload,freshness_state,expected_balance_version,source_mode)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'STAGED',$11::jsonb,$12,$13,$14)`, [id, context.brandId, input.variantId, input.locationId,
        input.sourceNamespace, input.sourceReference, input.sourceVersion ?? null, input.asOf, input.meaning, input.quantity,
        JSON.stringify(input.rawPayload ?? null), freshness, Number(pool.rows[0].row_version), sourceMode]);
      return { id, state: 'STAGED', freshness, sourceMode, balanceVersion: Number(pool.rows[0].row_version) };
      });
    });
  }

  async listObservations(context: BrandAccessContext, limit = 50) {
    return this.transaction(async (client) => {
      await this.authorize(client, context);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw failure('STOCK_PAGE_SIZE_INVALID');
      const result = await client.query(`SELECT o.id,o.variant_id,o.location_id,o.source_namespace,o.source_reference,o.source_version,
        o.source_as_of,o.reported_meaning,o.reported_quantity,o.review_state,o.expected_balance_version,o.source_mode,
        b.row_version AS current_balance_version,
        CASE
          WHEN o.freshness_state IN ('CONFLICT','STALE','REVIEW_REQUIRED') THEN o.freshness_state
          WHEN EXISTS(SELECT 1 FROM inventory.stock_observations n WHERE n.brand_id=o.brand_id AND n.variant_id=o.variant_id
            AND n.location_id=o.location_id AND n.source_namespace=o.source_namespace AND n.source_reference=o.source_reference
            AND (n.source_as_of,n.submitted_at,n.id)>(o.source_as_of,o.submitted_at,o.id)) THEN 'STALE'
          WHEN o.expected_balance_version IS NOT NULL AND o.expected_balance_version<>b.row_version THEN 'REVIEW_REQUIRED'
          WHEN now()-o.source_as_of >= CASE o.source_mode WHEN 'CONNECTED' THEN interval '60 minutes' ELSE interval '48 hours' END THEN 'PAUSED'
          WHEN now()-o.source_as_of >= CASE o.source_mode WHEN 'CONNECTED' THEN interval '15 minutes' ELSE interval '24 hours' END THEN 'ALERT'
          ELSE 'CURRENT'
        END AS freshness
        FROM inventory.stock_observations o JOIN inventory.stock_balances b USING(brand_id,variant_id,location_id)
        WHERE o.brand_id=$1 ORDER BY o.source_as_of DESC,o.submitted_at DESC,o.id DESC LIMIT $2`, [context.brandId, limit]);
      return result.rows;
    });
  }

  async proposeAdjustmentFromObservation(context: BrandAccessContext, observationId: string, reason: string, effectKey: string) {
    const observation = await this.transaction(async (client) => {
      await this.authorize(client, context);
      const result = await client.query(`SELECT o.variant_id,o.location_id,o.expected_balance_version,o.reported_meaning,o.reported_quantity,
        b.physical_on_hand FROM inventory.stock_observations o JOIN inventory.stock_balances b USING(brand_id,variant_id,location_id)
        WHERE o.id=$1 AND o.brand_id=$2`, [observationId, context.brandId]);
      return result.rows[0];
    });
    if (!observation) throw failure('STOCK_OBSERVATION_NOT_FOUND', 404);
    if (observation.reported_meaning !== 'physical' || observation.expected_balance_version === null) {
      throw failure('STOCK_OBSERVATION_REQUIRES_REVIEW', 409);
    }
    const delta = Number(observation.reported_quantity) - Number(observation.physical_on_hand);
    if (!delta) throw failure('STOCK_OBSERVATION_NO_ADJUSTMENT_REQUIRED', 409);
    return this.proposeAdjustment(context, { variantId: observation.variant_id, locationId: observation.location_id,
      expectedVersion: Number(observation.expected_balance_version), delta, reason,
      evidenceRef: `observation:${observationId}`, effectKey, sourceObservationId: observationId });
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
        for (const locationId of [...locations].sort()) await this.ensureGenesis(client, context, input.variantId, locationId);
        const locked = await client.query<StockBalance>(`SELECT * FROM inventory.stock_balances
          WHERE brand_id=$1 AND variant_id=$2 AND location_id=ANY($3::uuid[]) ORDER BY location_id FOR UPDATE`,
        [context.brandId, input.variantId, locations]);
        const from = locked.rows.find((row) => row.location_id === input.fromLocationId);
        const to = locked.rows.find((row) => row.location_id === input.toLocationId);
        if (!from || !to) throw failure('STOCK_TARGET_NOT_FOUND', 404);
        if (Number(from.row_version) !== input.expectedFromVersion) throw failure('STOCK_VERSION_CONFLICT', 409);
        const source = buckets(from);
        const ats = Math.max(0, source.physical - source.quarantine - source.unsellable - source.allocatedNotDispatched - source.buffer);
        if (ats < input.quantity) throw failure('STOCK_TRANSFER_QUANTITY_UNAVAILABLE');
        const transferId = randomUUID();
        const outKey = `transfer.${transferId}.out`;
        const inKey = `transfer.${transferId}.in`;
        await client.query(`INSERT INTO inventory.stock_transfers(id,brand_id,variant_id,from_location_id,to_location_id,quantity,state,dispatch_effect_key,receipt_effect_key)
          VALUES($1,$2,$3,$4,$5,$6,'CREATED',$7,$8)`, [transferId, context.brandId, input.variantId, input.fromLocationId, input.toLocationId, input.quantity, outKey, inKey]);
        const out = await this.applyMovement(client, context, { variantId: input.variantId, locationId: input.fromLocationId,
          expectedVersion: input.expectedFromVersion, effectKey: outKey, reason: 'TRANSFER_OUT', sourceType: 'TRANSFER', sourceReference: transferId, deltaPhysical: -input.quantity });
        const event = await client.query(`SELECT id FROM inventory.stock_events WHERE brand_id=$1 AND business_effect_key=$2`, [context.brandId, outKey]);
        await client.query(`UPDATE inventory.stock_transfers SET state='IN_TRANSIT',out_event_id=$2 WHERE id=$1`, [transferId, event.rows[0].id]);
        return { id: transferId, state: 'IN_TRANSIT', quantity: input.quantity, from: out, toLocationId: input.toLocationId,
          receiptEffectKey: inKey, destinationVersion: Number(to.row_version) };
      });
    });
  }

  async receiveTransfer(context: BrandAccessContext, transferId: string, expectedDestinationVersion: number, key: string) {
    return this.transaction(async (client) => {
      await this.authorize(client, context);
      return this.idempotent(client, context, 'stock.transfer.receive', key, { transferId, expectedDestinationVersion }, async () => {
        const result = await client.query(`SELECT * FROM inventory.stock_transfers WHERE id=$1 AND brand_id=$2 FOR UPDATE`, [transferId, context.brandId]);
        const transfer = result.rows[0];
        if (!transfer) throw failure('STOCK_TRANSFER_NOT_FOUND', 404);
        if (transfer.state !== 'IN_TRANSIT') throw failure('STOCK_TRANSFER_NOT_IN_TRANSIT', 409);
        const destination = await client.query(`SELECT row_version FROM inventory.stock_balances WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3 FOR UPDATE`,
          [context.brandId, transfer.variant_id, transfer.to_location_id]);
        if (!destination.rows[0]) throw failure('STOCK_TARGET_NOT_FOUND', 404);
        if (Number(destination.rows[0].row_version) !== expectedDestinationVersion) throw failure('STOCK_VERSION_CONFLICT', 409);
        const inKey = transfer.receipt_effect_key;
        const received = await this.applyMovement(client, context, { variantId: transfer.variant_id, locationId: transfer.to_location_id,
          expectedVersion: expectedDestinationVersion, effectKey: inKey, reason: 'TRANSFER_IN', sourceType: 'TRANSFER', sourceReference: transferId,
          deltaPhysical: Number(transfer.quantity) });
        const event = await client.query(`SELECT id FROM inventory.stock_events WHERE brand_id=$1 AND business_effect_key=$2`, [context.brandId, inKey]);
        await client.query(`UPDATE inventory.stock_transfers SET state='RECEIVED',in_event_id=$2,accepted_by=$3,accepted_at=now() WHERE id=$1`,
          [transferId, event.rows[0].id, context.userId]);
        return { id: transferId, state: 'RECEIVED', quantity: Number(transfer.quantity), destination: received };
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
      const ledger = await client.query(`SELECT e.pool_sequence,e.event_kind,e.delta_physical,e.delta_quarantined,e.delta_other_non_sellable,e.delta_allocated,e.delta_buffer,e.business_effect_key
        FROM inventory.stock_events e WHERE e.brand_id=$1 AND e.variant_id=$2 AND e.location_id=$3 ORDER BY e.pool_sequence`, [context.brandId, input.variantId, input.locationId]);
      const replay = { physical: 0, quarantine: 0, otherNonSellable: 0, allocatedNotDispatched: 0, buffer: 0 };
      for (const e of ledger.rows) { replay.physical += Number(e.delta_physical); replay.quarantine += Number(e.delta_quarantined);
        replay.otherNonSellable += Number(e.delta_other_non_sellable); replay.allocatedNotDispatched += Number(e.delta_allocated); replay.buffer += Number(e.delta_buffer); }
      if (!ledger.rowCount) replay.physical = 0;
      const sequenceValid = ledger.rows.every((event, index) => Number(event.pool_sequence) === index + 1)
        && Number(ledger.rows.at(-1)?.pool_sequence ?? 1) === Number(current.row_version);
      const currentBuckets = buckets(current);
      const observed = { physical: Number(current.physical_on_hand), quarantine: currentBuckets.quarantine, otherNonSellable: currentBuckets.unsellable,
        allocatedNotDispatched: currentBuckets.allocatedNotDispatched, buffer: currentBuckets.buffer };
      const id = randomUUID(); const eventHash = digest(ledger.rows);
      await client.query(`INSERT INTO inventory.cycle_counts(id,brand_id,variant_id,location_id,reported_physical,observed_balance_version,count_state,requested_by,recorded_balance,journal_digest,completed_at)
        VALUES($1,$2,$3,$4,$5,$6,'REVIEWED',$7,$8::jsonb,$9,now())`, [id, context.brandId, input.variantId, input.locationId, input.physical, input.expectedVersion,
        context.userId, JSON.stringify(observed), eventHash]);
      let caseId: string | null = null;
      if (!sequenceValid || input.physical !== observed.physical || Object.keys(replay).some((key) => replay[key as keyof typeof replay] !== observed[key as keyof typeof observed])) {
        const c = await client.query(`INSERT INTO inventory.reconciliation_cases(brand_id,variant_id,location_id,variance_physical,case_state,reason_code,detection_source,expected_balance,observed_balance,counted_physical,expected_balance_version)
          VALUES($1,$2,$3,$4,'OPEN',$5,'JOURNAL_REPLAY',$6::jsonb,$7::jsonb,$8,$9) RETURNING id`,
        [context.brandId, input.variantId, input.locationId, input.physical - replay.physical,
          sequenceValid ? 'CYCLE_COUNT_DRIFT' : 'JOURNAL_SEQUENCE_GAP', JSON.stringify(replay), JSON.stringify(observed), input.physical, input.expectedVersion]);
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
        const found = await client.query(`SELECT id,variant_id,location_id,row_version,case_state,variance_physical,counted_physical,expected_balance_version FROM inventory.reconciliation_cases
          WHERE id=$1 AND brand_id=$2 FOR UPDATE`, [caseId, context.brandId]);
        const item = found.rows[0];
        if (!item) throw failure('STOCK_RECONCILIATION_NOT_FOUND', 404);
        if (Number(item.row_version) !== input.expectedVersion) throw failure('STOCK_VERSION_CONFLICT', 409);
        if (!['OPEN','UNDER_REVIEW'].includes(item.case_state)) throw failure('STOCK_RECONCILIATION_ALREADY_CLOSED', 409);
        if (input.decision === 'COMPENSATE') {
          const approved = await client.query(`SELECT 1 FROM inventory.stock_adjustments WHERE id=$1 AND brand_id=$2
            AND variant_id=$3 AND location_id=$4 AND reconciliation_case_id=$5 AND approval_state='APPLIED'
            AND requested_physical_delta=$6 AND expected_balance_version=$7`,
          [input.adjustmentId, context.brandId, item.variant_id, item.location_id, caseId, item.variance_physical, item.expected_balance_version]);
          if (!approved.rowCount) throw failure('STOCK_RECONCILIATION_ADJUSTMENT_REQUIRED', 409);
          const corrected = await client.query(`SELECT physical_on_hand FROM inventory.stock_balances
            WHERE brand_id=$1 AND variant_id=$2 AND location_id=$3`, [context.brandId, item.variant_id, item.location_id]);
          if (!corrected.rowCount || Number(corrected.rows[0].physical_on_hand) !== Number(item.counted_physical)) {
            throw failure('STOCK_RECONCILIATION_NOT_RECONCILED', 409);
          }
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
