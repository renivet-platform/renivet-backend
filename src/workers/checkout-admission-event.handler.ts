import type { PoolClient } from 'pg';
import { InventoryPostgresRepository } from '../modules/inventory/inventory.repository';
import type { DurableEvent, EventHandler } from './durable-worker';
import type { WorkerAuthorizationContext } from './worker-authorization';

export const CHECKOUT_ADMISSION_CONSUMER = 'inventory.checkout_admission';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function payloadObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw codedError('WORKER_SOURCE_NOT_VERIFIED');
  return value as Record<string, unknown>;
}

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function uuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
function positiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }

/**
 * Dormant W2 consumer for W3-issued admission proofs. Do not register this
 * handler in the application worker until the W3 producer and rollout gates
 * are approved and live.
 */
export class CheckoutAdmissionEventHandler implements EventHandler {
  readonly consumerId = CHECKOUT_ADMISSION_CONSUMER;
  readonly eventTypes = ['checkout.allocation_eligible', 'checkout.allocation_skipped'] as const;
  readonly authorization = Object.freeze({
    scope: 'brand' as const,
    purpose: 'inventory.checkout_admission',
    effects: ['inventory.allocate', 'inventory.admission.skip'] as const,
  });

  constructor(private readonly inventory: InventoryPostgresRepository) {}

  async handle(event: DurableEvent, _transaction: PoolClient, authorization?: WorkerAuthorizationContext): Promise<void> {
    if (!authorization || event.aggregateType !== 'checkout.order' || event.eventVersion !== 1 ||
      !this.eventTypes.includes(event.eventType as (typeof this.eventTypes)[number])) {
      throw codedError('WORKER_SOURCE_NOT_VERIFIED');
    }
    const payload = payloadObject(event.eventPayload);
    const line = payloadObject(payload.line);
    if (!uuid(payload.brandId) || payload.brandId !== authorization.brandId || !uuid(event.aggregateId) ||
      !uuid(payload.acceptedEventId) || !uuid(line.checkoutLineId) || !uuid(line.variantId) || !uuid(line.locationId) ||
      !positiveInteger(payload.acceptedSequence) || !positiveInteger(payload.eligibilitySequence)) {
      throw codedError('WORKER_SOURCE_NOT_VERIFIED');
    }

    if (event.eventType === 'checkout.allocation_eligible') {
      if (!positiveInteger(line.quantity)) throw codedError('WORKER_SOURCE_NOT_VERIFIED');
      await this.inventory.allocateTrusted(authorization, {
        brandId: payload.brandId,
        checkoutId: event.aggregateId,
        checkoutLineId: line.checkoutLineId,
        acceptedSequence: payload.acceptedSequence,
        variantId: line.variantId,
        locationId: line.locationId,
        quantity: line.quantity,
        idempotencyKey: event.id,
      });
      return;
    }

    if (typeof payload.reasonCode !== 'string' ||
      !['PREDECESSOR_INVALID', 'PREDECESSOR_EXPIRED', 'PREDECESSOR_CANCELLED', 'OPERATOR_RECOVERY'].includes(payload.reasonCode)) {
      throw codedError('CHECKOUT_ADMISSION_SKIP_INVALID');
    }
    await this.inventory.skipCheckoutAdmission(authorization, {
      brandId: payload.brandId,
      checkoutId: event.aggregateId,
      acceptedSequence: payload.acceptedSequence,
      acceptedEventId: payload.acceptedEventId,
      variantId: line.variantId,
      locationId: line.locationId,
      eligibilitySequence: payload.eligibilitySequence,
      reasonCode: payload.reasonCode as 'PREDECESSOR_INVALID' | 'PREDECESSOR_EXPIRED' | 'PREDECESSOR_CANCELLED' | 'OPERATOR_RECOVERY',
      idempotencyKey: event.id,
    });
  }
}
