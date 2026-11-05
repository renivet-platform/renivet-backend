import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';

export type CatalogReviewDecision = 'APPROVED' | 'REJECTED' | 'CORRECTION_REQUIRED' | 'RESTRICTED';
export interface CatalogReviewInput {
  readonly decision: CatalogReviewDecision;
  readonly reasonCode: string;
  readonly expectedRevisionId: string;
  readonly expectedRowVersion: number;
  readonly comment?: string | null;
}
export interface CatalogReviewContext { readonly userId: string; readonly brandId: string; readonly idempotencyKey: string; }
export interface CatalogReviewRepository { decide(productId: string, input: CatalogReviewInput, context: CatalogReviewContext): Promise<Record<string, unknown>>; }
export const CATALOG_REVIEW_REPOSITORY = Symbol('CATALOG_REVIEW_REPOSITORY');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECISIONS = new Set<CatalogReviewDecision>(['APPROVED', 'REJECTED', 'CORRECTION_REQUIRED', 'RESTRICTED']);

export function validateReviewDecision(input: CatalogReviewInput): CatalogReviewInput {
  if (!input || !DECISIONS.has(input.decision) || typeof input.reasonCode !== 'string'
    || !/^[A-Z][A-Z0-9_]{1,63}$/.test(input.reasonCode) || !UUID.test(input.expectedRevisionId)
    || !Number.isSafeInteger(input.expectedRowVersion) || input.expectedRowVersion < 1
    || (input.comment !== undefined && input.comment !== null && (typeof input.comment !== 'string' || input.comment.length > 2_000))) {
    throw Object.assign(new Error('The catalog review decision is invalid.'), { code: 'CATALOG_REVIEW_REQUEST_INVALID' });
  }
  return { ...input, comment: input.comment?.trim() || null };
}

@Injectable()
export class CatalogReviewService {
  constructor(@Inject(CATALOG_REVIEW_REPOSITORY) private readonly repository: CatalogReviewRepository) {}
  async decide(productId: string, input: CatalogReviewInput, context: CatalogReviewContext): Promise<Record<string, unknown>> {
    if (!UUID.test(productId) || !context || !UUID.test(context.userId) || !UUID.test(context.brandId)
      || typeof context.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(context.idempotencyKey)) {
      throw Object.assign(new Error('The catalog review request is invalid.'), { code: 'CATALOG_REVIEW_REQUEST_INVALID' });
    }
    const normalized = validateReviewDecision(input);
    try { return await this.repository.decide(productId, normalized, context); }
    catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === 'CATALOG_REVIEW_REQUEST_INVALID') throw new UnprocessableEntityException({ code, message: 'The review decision is invalid.' });
      if (['CATALOG_REVIEW_VERSION_CONFLICT', 'CATALOG_REVIEW_STATE_CONFLICT', 'CATALOG_REVIEW_IDEMPOTENCY_CONFLICT',
        'CATALOG_REVIEW_ALREADY_DECIDED'].includes(code ?? '')) throw new ConflictException({ code, message: 'The product changed or this revision already has a review decision.' });
      if (code === 'CATALOG_REVIEW_NOT_FOUND') throw new NotFoundException({ code, message: 'The submitted revision was not found.' });
      if (['CATALOG_REVIEW_ACCESS_DENIED', 'CATALOG_REVIEW_MAKER_CHECKER_CONFLICT'].includes(code ?? '')) throw new ForbiddenException({ code, message: 'The review could not be authorized.' });
      if (['CATALOG_REVIEW_EVIDENCE_INVALID', 'CATALOG_REVIEW_MEDIA_INVALID', 'CATALOG_REVIEW_PRICE_INVALID'].includes(code ?? '')) {
        throw new UnprocessableEntityException({ code, message: 'The submitted content no longer meets catalog review requirements.' });
      }
      if (code === 'CATALOG_REVIEW_DATABASE_UNAVAILABLE') throw new ServiceUnavailableException({ code, message: 'Review storage is temporarily unavailable.' });
      throw error;
    }
  }
}
