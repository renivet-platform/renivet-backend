import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';

export type PublicationOperation = 'PUBLISH' | 'RESTRICT' | 'UNPUBLISH';
export interface PublishRevisionInput { readonly approvedRevisionId: string; readonly approvedReviewId: string; }
export interface ReasonedPublicationInput { readonly reasonCode: string; readonly comment?: string | null; readonly appealReference?: string | null; }
export type PublicationInput = PublishRevisionInput | ReasonedPublicationInput;
export interface PublicationCommandContext {
  readonly userId: string; readonly brandId: string; readonly expectedProductVersion: number; readonly idempotencyKey: string;
}
export interface CatalogPublicationRepository {
  publish(productId: string, input: PublishRevisionInput, context: PublicationCommandContext): Promise<Record<string, unknown>>;
  restrict(productId: string, input: ReasonedPublicationInput, context: PublicationCommandContext): Promise<Record<string, unknown>>;
  unpublish(productId: string, input: ReasonedPublicationInput, context: PublicationCommandContext): Promise<Record<string, unknown>>;
}
export const CATALOG_PUBLICATION_REPOSITORY = Symbol('CATALOG_PUBLICATION_REPOSITORY');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validatePublicationInput(operation: PublicationOperation, input: PublicationInput, context: PublicationCommandContext): { input: PublicationInput; context: PublicationCommandContext } {
  const invalidContext = !context || !UUID.test(context.userId) || !UUID.test(context.brandId)
    || !Number.isSafeInteger(context.expectedProductVersion) || context.expectedProductVersion < 1
    || typeof context.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{1,120}$/.test(context.idempotencyKey);
  const invalidInput = !input || (operation === 'PUBLISH'
    ? !UUID.test((input as PublishRevisionInput).approvedRevisionId) || !UUID.test((input as PublishRevisionInput).approvedReviewId)
    : typeof (input as ReasonedPublicationInput).reasonCode !== 'string'
      || !/^[A-Z][A-Z0-9_]{1,63}$/.test((input as ReasonedPublicationInput).reasonCode)
      || ((input as ReasonedPublicationInput).comment != null && (typeof (input as ReasonedPublicationInput).comment !== 'string'
        || (input as ReasonedPublicationInput).comment!.length > 2_000))
      || ((input as ReasonedPublicationInput).appealReference != null && (typeof (input as ReasonedPublicationInput).appealReference !== 'string'
        || (input as ReasonedPublicationInput).appealReference!.length > 256)));
  if (!['PUBLISH','RESTRICT','UNPUBLISH'].includes(operation) || invalidContext || invalidInput) {
    throw Object.assign(new Error('The catalog publication request is invalid.'), { code: 'CATALOG_PUBLICATION_REQUEST_INVALID' });
  }
  if (operation === 'PUBLISH') return { input, context };
  const reasoned = input as ReasonedPublicationInput;
  return { input: { ...reasoned, reasonCode: reasoned.reasonCode.trim(), comment: reasoned.comment?.trim() || null,
    appealReference: reasoned.appealReference?.trim() || null }, context };
}

@Injectable()
export class CatalogPublicationService {
  constructor(@Inject(CATALOG_PUBLICATION_REPOSITORY) private readonly repository: CatalogPublicationRepository) {}

  async publish(productId: string, input: PublishRevisionInput, context: PublicationCommandContext): Promise<Record<string, unknown>> {
    if (!UUID.test(productId)) throw Object.assign(new Error('Invalid product id.'), { code: 'CATALOG_PUBLICATION_REQUEST_INVALID' });
    validatePublicationInput('PUBLISH', input, context); return this.execute(() => this.repository.publish(productId, input, context));
  }
  async restrict(productId: string, input: ReasonedPublicationInput, context: PublicationCommandContext): Promise<Record<string, unknown>> {
    if (!UUID.test(productId)) throw Object.assign(new Error('Invalid product id.'), { code: 'CATALOG_PUBLICATION_REQUEST_INVALID' });
    const normalized = validatePublicationInput('RESTRICT', input, context).input as ReasonedPublicationInput;
    return this.execute(() => this.repository.restrict(productId, normalized, context));
  }
  async unpublish(productId: string, input: ReasonedPublicationInput, context: PublicationCommandContext): Promise<Record<string, unknown>> {
    if (!UUID.test(productId)) throw Object.assign(new Error('Invalid product id.'), { code: 'CATALOG_PUBLICATION_REQUEST_INVALID' });
    const normalized = validatePublicationInput('UNPUBLISH', input, context).input as ReasonedPublicationInput;
    return this.execute(() => this.repository.unpublish(productId, normalized, context));
  }

  private async execute(work: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    try { return await work(); }
    catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === 'CATALOG_PUBLICATION_REQUEST_INVALID') throw new UnprocessableEntityException({ code, message: 'The publication request is invalid.' });
      if (['CATALOG_PUBLICATION_VERSION_CONFLICT','CATALOG_PUBLICATION_STATE_CONFLICT','CATALOG_PUBLICATION_ALREADY_APPLIED',
        'CATALOG_PUBLICATION_IDEMPOTENCY_CONFLICT'].includes(code ?? '')) throw new ConflictException({ code, message: 'The product changed or the lifecycle command conflicts with current state.' });
      if (code === 'CATALOG_PUBLICATION_NOT_FOUND') throw new NotFoundException({ code, message: 'The product was not found.' });
      if (code === 'CATALOG_PUBLICATION_ACCESS_DENIED') throw new ForbiddenException({ code, message: 'The lifecycle command is not authorized.' });
      if (['CATALOG_PUBLICATION_CATEGORY_INVALID','CATALOG_PUBLICATION_PRICE_INVALID','CATALOG_PUBLICATION_MEDIA_INVALID',
        'CATALOG_PUBLICATION_EVIDENCE_INVALID','CATALOG_PUBLICATION_APPROVAL_INVALID'].includes(code ?? '')) {
        throw new UnprocessableEntityException({ code, message: 'The approved revision no longer meets publication requirements.' });
      }
      if (code === 'CATALOG_PUBLICATION_DATABASE_UNAVAILABLE') throw new ServiceUnavailableException({ code, message: 'Publication storage is temporarily unavailable.' });
      throw error;
    }
  }
}
