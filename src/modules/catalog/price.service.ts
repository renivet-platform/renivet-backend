import { Inject, Injectable } from '@nestjs/common';

export interface PriceProposalInput {
  readonly currency: 'INR';
  readonly sellingPriceMinor: number;
  readonly mrpMinor: number;
  readonly validFrom: string;
  readonly validTo?: string | null;
  readonly ruleVersion: number;
  readonly reasonCode?: string;
}

export interface NormalizedPriceProposal {
  readonly currency: 'INR';
  readonly sellingPriceMinor: number;
  readonly mrpMinor: number;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly ruleVersion: number;
  readonly reasonCode?: string;
}

export interface PriceMutationContext {
  readonly userId: string;
  readonly brandId: string;
  readonly permission: 'pricing.write';
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface PriceReadContext {
  readonly userId: string;
  readonly brandId: string;
  readonly permission: 'pricing.read';
}

export interface PriceDecisionInput {
  readonly decision: 'APPROVE' | 'REJECT';
  readonly reasonCode: string;
  readonly comment?: string;
  readonly expectedState?: 'PENDING';
}

export interface PriceDecisionContext {
  readonly userId: string;
  readonly brandId: string;
  readonly permission: 'pricing.approve';
  readonly requestId: string;
  readonly idempotencyKey: string;
}

export interface PriceRepository {
  propose(variantId: string, input: NormalizedPriceProposal, expectedVariantVersion: number, context: PriceMutationContext): Promise<Record<string, unknown>>;
  list(variantId: string, context: PriceReadContext): Promise<Record<string, unknown>>;
  decide(priceId: string, input: PriceDecisionInput, context: PriceDecisionContext): Promise<Record<string, unknown>>;
}

export const PRICE_REPOSITORY = Symbol('PRICE_REPOSITORY');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,120}$/;
const RFC3339_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)$/;
const PROPOSAL_FIELDS = new Set(['currency', 'sellingPriceMinor', 'mrpMinor', 'validFrom', 'validTo', 'ruleVersion', 'reasonCode']);
const DECISION_FIELDS = new Set(['decision', 'reasonCode', 'comment', 'expectedState']);

export class PriceError extends Error {
  constructor(readonly code: string) { super(code); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function instant(value: unknown): string | null {
  if (typeof value !== 'string' || !RFC3339_WITH_ZONE.test(value)) return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second] = parts.map(Number);
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (calendarDate.getUTCFullYear() !== year || calendarDate.getUTCMonth() + 1 !== month || calendarDate.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

export function normalizePriceProposal(value: unknown): NormalizedPriceProposal {
  if (!isRecord(value) || Object.keys(value).some((key) => !PROPOSAL_FIELDS.has(key))) throw new PriceError('PRICE_PROPOSAL_INVALID');
  const { currency, sellingPriceMinor, mrpMinor, validFrom, validTo, ruleVersion, reasonCode } = value;
  const normalizedFrom = instant(validFrom);
  const normalizedTo = validTo === undefined || validTo === null ? null : instant(validTo);
  if (currency !== 'INR'
    || !Number.isSafeInteger(sellingPriceMinor) || Number(sellingPriceMinor) < 0
    || !Number.isSafeInteger(mrpMinor) || Number(mrpMinor) < 1
    || Number(sellingPriceMinor) > Number(mrpMinor)
    || !Number.isSafeInteger(ruleVersion) || Number(ruleVersion) < 1
    || !normalizedFrom
    || (validTo !== undefined && validTo !== null && !normalizedTo)
    || (normalizedTo !== null && Date.parse(normalizedTo) <= Date.parse(normalizedFrom))
    || (reasonCode !== undefined && (typeof reasonCode !== 'string' || reasonCode.trim().length === 0
      || reasonCode.trim().length > 100 || [...reasonCode].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })))) {
    throw new PriceError('PRICE_PROPOSAL_INVALID');
  }
  return {
    currency: 'INR', sellingPriceMinor: Number(sellingPriceMinor), mrpMinor: Number(mrpMinor),
    validFrom: normalizedFrom, validTo: normalizedTo, ruleVersion: Number(ruleVersion),
    ...(reasonCode === undefined ? {} : { reasonCode: reasonCode.trim() }),
  };
}

export function parsePriceIfMatch(value: string | string[] | undefined): number {
  const candidate = typeof value === 'string' ? value : undefined;
  if (!candidate || !/^"[1-9]\d{0,15}"$/.test(candidate)) throw new PriceError('PRICE_IF_MATCH_INVALID');
  const parsed = Number(candidate.slice(1, -1));
  if (!Number.isSafeInteger(parsed)) throw new PriceError('PRICE_IF_MATCH_INVALID');
  return parsed;
}

export function normalizePriceDecision(value: unknown): PriceDecisionInput {
  if (!isRecord(value) || Object.keys(value).some((key) => !DECISION_FIELDS.has(key))) throw new PriceError('PRICE_DECISION_INVALID');
  const { decision, reasonCode, comment, expectedState } = value;
  const validText = (item: unknown, max: number) => typeof item === 'string' && item.trim().length > 0
    && item.trim().length <= max && ![...item].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  if ((decision !== 'APPROVE' && decision !== 'REJECT') || !validText(reasonCode, 100)
    || (comment !== undefined && !validText(comment, 500))
    || (expectedState !== undefined && expectedState !== 'PENDING')) throw new PriceError('PRICE_DECISION_INVALID');
  return { decision, reasonCode: (reasonCode as string).trim(),
    ...(comment === undefined ? {} : { comment: (comment as string).trim() }),
    ...(expectedState === undefined ? {} : { expectedState: 'PENDING' }) };
}

function assertUuid(value: string): void {
  if (!UUID.test(value)) throw new PriceError('PRICE_REQUEST_INVALID');
}

@Injectable()
export class PriceService {
  constructor(@Inject(PRICE_REPOSITORY) private readonly repository: PriceRepository) {}

  async propose(variantId: string, input: unknown, ifMatch: string | string[] | undefined, context: PriceMutationContext): Promise<Record<string, unknown>> {
    assertUuid(variantId);
    if (!IDEMPOTENCY_KEY.test(context.idempotencyKey)) throw new PriceError('PRICE_REQUEST_INVALID');
    const normalized = normalizePriceProposal(input);
    const expectedVersion = parsePriceIfMatch(ifMatch);
    return this.repository.propose(variantId, normalized, expectedVersion, context);
  }

  async list(variantId: string, context: PriceReadContext): Promise<Record<string, unknown>> {
    assertUuid(variantId);
    return this.repository.list(variantId, context);
  }

  async decide(priceId: string, input: unknown, context: PriceDecisionContext): Promise<Record<string, unknown>> {
    assertUuid(priceId);
    if (!IDEMPOTENCY_KEY.test(context.idempotencyKey)) throw new PriceError('PRICE_REQUEST_INVALID');
    return this.repository.decide(priceId, normalizePriceDecision(input), context);
  }
}
