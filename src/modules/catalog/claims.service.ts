import { Inject, Injectable } from '@nestjs/common';

export interface ClaimProposal {
  readonly claimCode: string;
  readonly claimText: string;
  readonly evidenceAssetIds: string[];
  readonly expiresAt: string | null;
}
export interface ClaimMutationContext {
  readonly userId: string; readonly brandId: string; readonly permission: string;
  readonly requestId: string; readonly idempotencyKey: string;
}
export interface ClaimReadContext { readonly userId: string; readonly brandId: string; readonly permission: string; }
export interface ClaimsRepository {
  propose(productId: string, proposal: ClaimProposal, expectedVersion: number, context: ClaimMutationContext): Promise<Record<string, unknown>>;
  list(productId: string, context: ClaimReadContext): Promise<Record<string, unknown>>;
}
export const CLAIMS_REPOSITORY = Symbol('CLAIMS_REPOSITORY');

export class ClaimsError extends Error {
  constructor(readonly code: string) { super(code); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)$/;
const KEY = /^[A-Za-z0-9._:-]{1,120}$/;
const FIELDS = new Set(['claimCode', 'claimText', 'evidenceAssetIds', 'expiresAt']);
function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.normalize('NFC').trim().length > 0
    && value.normalize('NFC').trim().length <= max
    && ![...value].some((character) => { const c = character.codePointAt(0)!; return c < 32 || c === 127; });
}
function validDate(value: unknown): string | null {
  if (typeof value !== 'string' || !DATE.test(value)) return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!parts) return null;
  const [year, month, day, hour, minute, second] = parts.slice(1).map(Number);
  const check = new Date(Date.UTC(year!, month! - 1, day!));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day
    || hour! > 23 || minute! > 59 || second! > 59) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

export function normalizeClaimProposal(value: unknown): ClaimProposal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ClaimsError('CLAIM_PROPOSAL_INVALID');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !FIELDS.has(key)) || !validText(input.claimCode, 80)
    || !/^[A-Za-z0-9_.-]+$/.test(input.claimCode.trim()) || !validText(input.claimText, 500)
    || !Array.isArray(input.evidenceAssetIds) || input.evidenceAssetIds.length < 1 || input.evidenceAssetIds.length > 10
    || !input.evidenceAssetIds.every((id) => typeof id === 'string' && UUID.test(id))
    || new Set(input.evidenceAssetIds).size !== input.evidenceAssetIds.length) throw new ClaimsError('CLAIM_PROPOSAL_INVALID');
  const expiresAt = input.expiresAt === undefined || input.expiresAt === null ? null : validDate(input.expiresAt);
  if (input.expiresAt !== undefined && input.expiresAt !== null
    && (!expiresAt || Date.parse(expiresAt) <= Date.now())) throw new ClaimsError('CLAIM_PROPOSAL_INVALID');
  return { claimCode: input.claimCode.trim(), claimText: input.claimText.normalize('NFC').trim(),
    evidenceAssetIds: [...input.evidenceAssetIds] as string[], expiresAt };
}

export function parseClaimIfMatch(value: string | string[] | undefined): number {
  const candidate = typeof value === 'string' ? value : undefined;
  if (!candidate || !/^"[1-9]\d{0,15}"$/.test(candidate)) throw new ClaimsError('CLAIM_IF_MATCH_INVALID');
  const parsed = Number(candidate.slice(1, -1));
  if (!Number.isSafeInteger(parsed)) throw new ClaimsError('CLAIM_IF_MATCH_INVALID');
  return parsed;
}

@Injectable()
export class ClaimsService {
  constructor(@Inject(CLAIMS_REPOSITORY) private readonly repository: ClaimsRepository) {}
  async propose(productId: string, body: unknown, ifMatch: string | string[] | undefined, context: ClaimMutationContext) {
    this.assertUuid(productId);
    if (!KEY.test(context.idempotencyKey)) throw new ClaimsError('CLAIM_REQUEST_INVALID');
    const expectedVersion = parseClaimIfMatch(ifMatch);
    return this.repository.propose(productId, normalizeClaimProposal(body), expectedVersion, context);
  }
  async list(productId: string, context: ClaimReadContext) {
    this.assertUuid(productId);
    return this.repository.list(productId, context);
  }
  private assertUuid(value: string) { if (!UUID.test(value)) throw new ClaimsError('CLAIM_REQUEST_INVALID'); }
}
