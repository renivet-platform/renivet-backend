import { createHash } from 'node:crypto';
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';

export interface SubmissionReadinessInput {
  category: { active: boolean; isLeaf: boolean; published: boolean; schemaVersion: number; currentSchemaVersion: number };
  attributesValid: boolean;
  variants: Array<{ id: string; active: boolean; currentApprovedPrice: boolean }>;
  media: Array<{ id: string; clean: boolean; rightsApproved: boolean; derivativeReady: boolean }>;
  claims: Array<{ id: string; verified: boolean; evidenceEligible: boolean }>;
}

export interface SubmissionIssue { code: string; path: string; message: string }

function canonicalValue(value: unknown, seen: Set<object>): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw Object.assign(new Error('Submission snapshot contains a non-finite number.'), { code: 'SUBMISSION_SNAPSHOT_INVALID' });
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw Object.assign(new Error('Submission snapshot contains a cycle.'), { code: 'SUBMISSION_SNAPSHOT_INVALID' });
    seen.add(value);
    const result = `[${value.map((entry) => canonicalValue(entry, seen)).join(',')}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    if (seen.has(value)) throw Object.assign(new Error('Submission snapshot contains a cycle.'), { code: 'SUBMISSION_SNAPSHOT_INVALID' });
    seen.add(value);
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().map((key) => {
      if (record[key] === undefined) throw Object.assign(new Error('Submission snapshot contains an unsupported value.'), { code: 'SUBMISSION_SNAPSHOT_INVALID' });
      return `${JSON.stringify(key)}:${canonicalValue(record[key], seen)}`;
    });
    seen.delete(value);
    return `{${entries.join(',')}}`;
  }
  throw Object.assign(new Error('Submission snapshot contains an unsupported value.'), { code: 'SUBMISSION_SNAPSHOT_INVALID' });
}

export function canonicalizeSnapshot(snapshot: unknown): string {
  return canonicalValue(snapshot, new Set());
}

export function snapshotSha256(snapshot: unknown): string {
  return createHash('sha256').update(canonicalizeSnapshot(snapshot), 'utf8').digest('hex');
}

export function validateSubmissionReadiness(input: SubmissionReadinessInput): SubmissionIssue[] {
  const issues: SubmissionIssue[] = [];
  const add = (code: string, path: string, message: string) => issues.push({ code, path, message });
  if (!input.category.active || !input.category.isLeaf || !input.category.published) {
    add('CATEGORY_NOT_LEAF', 'categoryCode', 'Choose an active leaf category with a published schema.');
  }
  if (input.category.schemaVersion !== input.category.currentSchemaVersion) {
    add('CATEGORY_SCHEMA_NOT_CURRENT', 'categorySchemaVersion', 'Update the draft to the current published category schema.');
  }
  if (!input.attributesValid) add('PRODUCT_ATTRIBUTES_INVALID', 'attributes', 'Complete the required category attributes.');
  if (!input.variants.some((variant) => variant.active)) add('ACTIVE_VARIANT_REQUIRED', 'variants', 'Add at least one active variant.');
  for (const variant of input.variants.filter((item) => item.active && !item.currentApprovedPrice)) {
    add('APPROVED_PRICE_REQUIRED', `variants.${variant.id}.price`, 'Each active variant needs a currently effective approved price.');
  }
  if (input.media.length === 0) add('PRODUCT_MEDIA_REQUIRED', 'media', 'Add at least one eligible product image.');
  for (const asset of input.media) {
    if (!asset.clean || !asset.derivativeReady) add('MEDIA_NOT_READY', `media.${asset.id}`, 'The selected media must be clean and derivative-ready.');
    if (!asset.rightsApproved) add('MEDIA_RIGHTS_REQUIRED', `media.${asset.id}`, 'The selected media needs reviewed or attested rights.');
  }
  for (const claim of input.claims) {
    if (!claim.verified) add('CLAIM_NOT_VERIFIED', `claims.${claim.id}`, 'Claims included in the submitted snapshot must be independently verified.');
    if (!claim.evidenceEligible) add('CLAIM_EVIDENCE_INELIGIBLE', `claims.${claim.id}.evidence`, 'Claim evidence must be eligible for this brand.');
  }
  return issues;
}

export interface ProductSubmissionContext {
  readonly userId: string;
  readonly brandId: string;
  readonly expectedRowVersion: number;
  readonly idempotencyKey: string;
  readonly sourceKind: 'MANUAL' | 'IMPORT';
  readonly sourceReference: string | null;
}

export interface ProductSubmissionRepository {
  submit(productId: string, context: ProductSubmissionContext): Promise<Record<string, unknown>>;
}

export const PRODUCT_SUBMISSION_REPOSITORY = Symbol('PRODUCT_SUBMISSION_REPOSITORY');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class ProductSubmissionService {
  constructor(@Inject(PRODUCT_SUBMISSION_REPOSITORY) private readonly repository: ProductSubmissionRepository) {}

  async submit(productId: string, context: ProductSubmissionContext): Promise<Record<string, unknown>> {
    if (!context || !UUID.test(productId) || !UUID.test(context.userId) || !UUID.test(context.brandId)
      || !Number.isSafeInteger(context.expectedRowVersion) || context.expectedRowVersion < 1
      || typeof context.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(context.idempotencyKey)
      || !['MANUAL', 'IMPORT'].includes(context.sourceKind)
      || (context.sourceReference !== null && (typeof context.sourceReference !== 'string' || context.sourceReference.length > 256))) {
      throw Object.assign(new Error('The submission request is invalid.'), { code: 'SUBMISSION_REQUEST_INVALID' });
    }
    try { return await this.repository.submit(productId, context); }
    catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === 'SUBMISSION_INCOMPLETE') {
        throw new UnprocessableEntityException({ code, message: 'Complete the highlighted product fields before submitting.', details: (error as { details?: Record<string, unknown> }).details });
      }
      if (code === 'SUBMISSION_REQUEST_INVALID' || code === 'SUBMISSION_SNAPSHOT_INVALID'
        || code === 'SUBMISSION_ATTRIBUTE_TYPE_INVALID' || code === 'PRODUCT_ATTRIBUTE_INVALID' || code === 'VARIANT_ATTRIBUTE_INVALID') {
        throw new UnprocessableEntityException({ code, message: 'The product submission is invalid.' });
      }
      if (code === 'SUBMISSION_VERSION_CONFLICT' || code === 'SUBMISSION_IDEMPOTENCY_CONFLICT'
        || code === 'SUBMISSION_STATE_INVALID') {
        throw new ConflictException({ code, message: 'The product changed or the submission conflicts with its current state.' });
      }
      if (code === 'SUBMISSION_NOT_FOUND') throw new NotFoundException({ code, message: 'The product was not found.' });
      if (code === 'SUBMISSION_ACCESS_DENIED') throw new ForbiddenException({ code, message: 'The operation could not be authorized.' });
      if (code === 'SUBMISSION_DATABASE_UNAVAILABLE') throw new ServiceUnavailableException({ code, message: 'Submission storage is temporarily unavailable.' });
      throw error;
    }
  }
}
