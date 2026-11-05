import { ForbiddenException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { DurableEvent, DurableJob } from './durable-worker';

const SAFE_IDENTIFIER = /^[a-z][a-z0-9._-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isPrincipalId = (value: string): boolean => SAFE_IDENTIFIER.test(value) || UUID.test(value);

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

/** Returned by an implementation-specific service-to-service authentication adapter. */
export type WorkerPrincipal = Readonly<{
  id: string;
  active: boolean;
  permittedConsumers: readonly string[];
  provenance: string;
}>;

/** Authentication transport is deliberately a port: W2 does not require a new JWT. */
export interface WorkerPrincipalProvider {
  authenticate(): Promise<WorkerPrincipal>;
}

export type BrandWorkerPolicy = Readonly<{
  purpose: string;
  effects: readonly string[];
}>;

export type WorkerAuthorizationContext = Readonly<{
  principalId: string;
  jobId: string;
  sourceEventId: string;
  brandId: string;
  purpose: string;
  effects: readonly string[];
  provenance: string;
  authorizeEffect(effectKey: string, targetBrandId: string): Promise<void>;
}>;

export type WorkerAuthorizationRequest = Readonly<{
  job: DurableJob;
  event: DurableEvent;
  policy: BrandWorkerPolicy;
}>;

export type WorkerJobBindingRequest = Readonly<{
  jobId: string;
  consumerId: string;
  event: DurableEvent;
  policy: BrandWorkerPolicy;
}>;

export interface WorkerAuthorizationPort {
  bindJob(request: WorkerJobBindingRequest, transaction: PoolClient): Promise<void>;
  authorize(request: WorkerAuthorizationRequest, transaction: PoolClient): Promise<WorkerAuthorizationContext>;
}

type WorkerAuditInput = Readonly<{ jobId: string; event: DurableEvent; policy: BrandWorkerPolicy }>;

/**
 * Default database-backed authorization adapter for W2 brand-owned events.
 * Authority comes from the service-authentication port and the persisted source
 * aggregate. Event payload fields never establish the worker's brand scope.
 */
export class DatabaseWorkerAuthorizationService implements WorkerAuthorizationPort {
  constructor(private readonly pool: Pool, private readonly principals: WorkerPrincipalProvider) {}

  async bindJob(request: WorkerJobBindingRequest, transaction: PoolClient): Promise<void> {
    const existing = await transaction.query<{
      actorId: string;
      sourceEventId: string;
      brandId: string;
      purpose: string;
      permittedEffects: string[];
    }>(
      `SELECT actor_id AS "actorId", source_event_id AS "sourceEventId", brand_id AS "brandId",
              purpose, permitted_effects AS "permittedEffects"
       FROM platform.worker_job_authorizations WHERE job_id = $1 FOR SHARE`,
      [request.jobId],
    );
    if (existing.rowCount === 1) {
      const binding = existing.rows[0];
      if (binding.sourceEventId !== request.event.id || binding.purpose !== request.policy.purpose ||
        !sameValues(binding.permittedEffects, request.policy.effects)) {
        await this.recordDenial(
          { jobId: request.jobId, event: request.event, policy: request.policy },
          binding.actorId,
          binding.brandId,
          binding.brandId,
          'service.auth.port',
          'JOB_POLICY_MISMATCH',
        );
        throw this.denied();
      }
      return;
    }

    let principal: WorkerPrincipal | null = null;
    let reason: string | null = null;
    try { principal = await this.principals.authenticate(); }
    catch { reason = 'AUTHENTICATION_UNAVAILABLE'; }
    const brandId = await this.resolveSourceBrand(request.event, transaction);
    reason ??= this.validatePrincipal(principal, request.consumerId);
    reason ??= this.validatePolicy(request.policy);
    if (!brandId) reason ??= 'SOURCE_NOT_FOUND';
    if (!['media_asset', 'stock_event', 'catalogue.product'].includes(request.event.aggregateType)) reason ??= 'UNSUPPORTED_SOURCE';

    if (reason || !brandId || !principal) {
      await this.recordDenial(
        { jobId: request.jobId, event: request.event, policy: request.policy },
        principal && typeof principal.id === 'string' && isPrincipalId(principal.id) ? principal.id : 'worker.auth.unknown',
        brandId,
        null,
        principal && SAFE_IDENTIFIER.test(principal.provenance) ? principal.provenance : 'service.auth.port',
        reason ?? 'AUTHORIZATION_DENIED',
      );
      throw this.denied();
    }

    await transaction.query(
      `INSERT INTO platform.worker_job_authorizations
         (job_id, actor_id, source_event_id, brand_id, purpose, permitted_effects, authorization_provenance)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7)`,
      [request.jobId, principal.id, request.event.id, brandId, request.policy.purpose,
        [...request.policy.effects], principal.provenance],
    );
  }

  async authorize(request: WorkerAuthorizationRequest, transaction: PoolClient): Promise<WorkerAuthorizationContext> {
    let principal: WorkerPrincipal | null = null;
    let reason: string | null = null;
    try { principal = await this.principals.authenticate(); }
    catch { reason = 'AUTHENTICATION_UNAVAILABLE'; }
    const sourceBrandId = await this.resolveSourceBrand(request.event, transaction);
    let payloadTargetBrandId: string | null = null;
    reason ??= this.validatePrincipal(principal, request.job.jobKind);
    reason ??= this.validatePolicy(request.policy);

    const entitlement = await transaction.query<{
      actorId: string;
      sourceEventId: string;
      brandId: string;
      purpose: string;
      permittedEffects: string[];
    }>(
      `SELECT actor_id AS "actorId", source_event_id AS "sourceEventId", brand_id AS "brandId",
              purpose, permitted_effects AS "permittedEffects"
       FROM platform.worker_job_authorizations WHERE job_id = $1 FOR SHARE`,
      [request.job.id],
    );
    const binding = entitlement.rows[0];
    if (!binding) reason ??= 'JOB_ENTITLEMENT_NOT_FOUND';
    else if (binding.sourceEventId !== request.event.id || binding.brandId !== sourceBrandId) reason ??= 'JOB_SCOPE_MISMATCH';
    else if (binding.purpose !== request.policy.purpose || !sameValues(binding.permittedEffects, request.policy.effects)) reason ??= 'JOB_POLICY_MISMATCH';
    else if (principal && binding.actorId !== principal.id) reason ??= 'PRINCIPAL_MISMATCH';

    const payload = request.event.eventPayload;
    if (payload && typeof payload === 'object' && 'brandId' in payload && typeof payload.brandId === 'string') {
      if (UUID.test(payload.brandId)) payloadTargetBrandId = payload.brandId;
      if (!UUID.test(payload.brandId) || payload.brandId !== sourceBrandId) reason ??= 'TARGET_BRAND_MISMATCH';
    }

    if (reason || !sourceBrandId || !principal || !binding) {
      await this.recordDenial(
        { jobId: request.job.id, event: request.event, policy: request.policy },
        principal && typeof principal.id === 'string' && isPrincipalId(principal.id) ? principal.id : 'worker.auth.unknown',
        sourceBrandId,
        payloadTargetBrandId,
        principal && SAFE_IDENTIFIER.test(principal.provenance) ? principal.provenance : 'service.auth.port',
        reason ?? 'AUTHORIZATION_DENIED',
      );
      throw this.denied();
    }

    for (const effect of request.policy.effects) {
      await this.writeAudit(transaction, { jobId: request.job.id, event: request.event, policy: request.policy }, principal.id, sourceBrandId, sourceBrandId, principal.provenance, 'allowed', effect);
    }
    const effects = Object.freeze([...request.policy.effects]);
    return Object.freeze({
      principalId: principal!.id,
      jobId: request.job.id,
      sourceEventId: request.event.id,
      brandId: sourceBrandId,
      purpose: request.policy.purpose,
      effects,
      provenance: principal!.provenance,
      authorizeEffect: async (effectKey: string, targetBrandId: string) => {
        const deniedReason = !effects.includes(effectKey)
          ? 'EFFECT_NOT_ALLOWLISTED'
          : (!UUID.test(targetBrandId) || targetBrandId !== sourceBrandId ? 'TARGET_BRAND_MISMATCH' : null);
        if (deniedReason) {
          await this.recordDenial(
            { jobId: request.job.id, event: request.event, policy: request.policy },
            principal.id,
            sourceBrandId,
            UUID.test(targetBrandId) ? targetBrandId : null,
            principal.provenance,
            deniedReason,
          );
          throw this.denied();
        }
      },
    });
  }

  private validatePrincipal(principal: WorkerPrincipal | null, consumerId: string): string | null {
    if (!principal) return 'AUTHENTICATION_UNAVAILABLE';
    if (typeof principal.id !== 'string' || !isPrincipalId(principal.id) || typeof principal.provenance !== 'string' ||
      !SAFE_IDENTIFIER.test(principal.provenance)) return 'INVALID_PRINCIPAL';
    if (principal.active !== true) return 'PRINCIPAL_REVOKED';
    if (!Array.isArray(principal.permittedConsumers) || principal.permittedConsumers.some((id) => typeof id !== 'string') ||
      !principal.permittedConsumers.includes(consumerId)) return 'CONSUMER_NOT_AUTHORIZED';
    return null;
  }

  private validatePolicy(policy: BrandWorkerPolicy): string | null {
    if (typeof policy.purpose !== 'string' || !SAFE_IDENTIFIER.test(policy.purpose) || !Array.isArray(policy.effects) || policy.effects.length === 0 ||
      policy.effects.length > 32 || policy.effects.some((effect) => typeof effect !== 'string' || !SAFE_IDENTIFIER.test(effect)) ||
      new Set(policy.effects).size !== policy.effects.length) return 'INVALID_POLICY';
    return null;
  }

  private async resolveSourceBrand(event: DurableEvent, transaction: PoolClient): Promise<string | null> {
    if (event.aggregateType === 'media_asset') {
      const row = await transaction.query<{ brandId: string }>(
        'SELECT brand_id AS "brandId" FROM media.media_assets WHERE id = $1 FOR SHARE', [event.aggregateId],
      );
      return row.rows[0]?.brandId ?? null;
    }
    if (event.aggregateType === 'stock_event') {
      const row = await transaction.query<{ brandId: string }>(
        'SELECT brand_id AS "brandId" FROM inventory.stock_events WHERE id = $1 FOR SHARE', [event.aggregateId],
      );
      return row.rows[0]?.brandId ?? null;
    }
    if (event.aggregateType === 'catalogue.product') {
      const row = await transaction.query<{ brandId: string }>(
        `SELECT p.brand_id AS "brandId" FROM catalogue.products p
          JOIN brands.brands b ON b.id=p.brand_id AND b.onboarding_state='approved'
         WHERE p.id=$1 FOR SHARE OF p,b`, [event.aggregateId],
      );
      return row.rows[0]?.brandId ?? null;
    }
    return null;
  }

  private async recordDenial(
    request: WorkerAuditInput,
    principalId: string,
    sourceBrandId: string | null,
    targetBrandId: string | null,
    provenance: string,
    reason: string,
  ): Promise<void> {
    const auditClient = await this.pool.connect();
    try {
      await auditClient.query('BEGIN');
      await this.writeAudit(auditClient, request, principalId, sourceBrandId, targetBrandId, provenance, 'denied', reason);
      await auditClient.query('COMMIT');
    } catch (error) {
      await auditClient.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      auditClient.release();
    }
  }

  private denied(): ForbiddenException {
    return new ForbiddenException({ code: 'WORKER_AUTHORIZATION_DENIED', message: 'The worker operation could not be authorized.' });
  }

  private async writeAudit(
    client: PoolClient,
    request: WorkerAuditInput,
    principalId: string,
    sourceBrandId: string | null,
    targetBrandId: string | null,
    provenance: string,
    decision: 'allowed' | 'denied',
    effectOrReason: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO platform.worker_authorization_audit
         (actor_type, actor_id, job_id, source_event_id, brand_id, source_brand_id, target_brand_id,
          purpose, effect_key, decision, reason_code, authorization_provenance)
       VALUES ('worker', $1, $2, $3, $4, $4, $5, $6, $7, $8, $9, $10)`,
      [principalId, request.jobId, request.event.id, sourceBrandId, targetBrandId,
        SAFE_IDENTIFIER.test(request.policy.purpose) ? request.policy.purpose : 'worker.authorization',
        decision === 'allowed' ? effectOrReason : 'authorization.check',
        decision, decision === 'denied' ? effectOrReason : null, provenance],
    );
  }

}
