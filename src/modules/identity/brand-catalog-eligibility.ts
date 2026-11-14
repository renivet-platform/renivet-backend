import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';

export type BrandApprovalDecision = 'approved' | 'rejected';

export interface BrandApprovalOutcome {
  readonly eventId: string;
  readonly brandId: string;
  readonly applicantUserId: string;
  readonly decision: BrandApprovalDecision;
  readonly approvedByUserId: string;
  readonly checkedByUserId: string;
  readonly requestId: string;
}

export interface BrandCatalogEligibilityRepository {
  applyOutcome(outcome: BrandApprovalOutcome): Promise<Record<string, unknown>>;
}

export const BRAND_CATALOG_ELIGIBILITY_REPOSITORY = Symbol('BRAND_CATALOG_ELIGIBILITY_REPOSITORY');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;

@Injectable()
export class BrandCatalogEligibilityService {
  constructor(
    @Inject(BRAND_CATALOG_ELIGIBILITY_REPOSITORY)
    private readonly repository: BrandCatalogEligibilityRepository,
  ) {}

  async applyOutcome(outcome: BrandApprovalOutcome): Promise<Record<string, unknown>> {
    if (!outcome || !UUID.test(outcome.eventId) || !UUID.test(outcome.brandId)
      || !UUID.test(outcome.applicantUserId) || !UUID.test(outcome.approvedByUserId)
      || !UUID.test(outcome.checkedByUserId) || !REQUEST_ID.test(outcome.requestId)
      || !['approved', 'rejected'].includes(outcome.decision)) {
      throw new BadRequestException({ code: 'BRAND_APPROVAL_EVENT_INVALID', message: 'The brand review outcome is invalid.' });
    }
    if (outcome.approvedByUserId === outcome.checkedByUserId
      || outcome.applicantUserId === outcome.approvedByUserId
      || outcome.applicantUserId === outcome.checkedByUserId) {
      throw new ConflictException({ code: 'BRAND_APPROVAL_MAKER_CHECKER_REQUIRED', message: 'Independent brand review is required.' });
    }
    try {
      return await this.repository.applyOutcome(outcome);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code === 'BRAND_APPROVAL_REVIEWER_DENIED') {
        throw new ForbiddenException({ code, message: 'The brand review outcome could not be applied.' });
      }
      if (code === 'BRAND_NOT_FOUND') throw new NotFoundException({ code, message: 'The brand review outcome could not be applied.' });
      if (['BRAND_APPROVAL_EVENT_CONFLICT', 'BRAND_STATE_NOT_REVIEWABLE', 'BRAND_MEMBERSHIP_REQUIRED', 'BRAND_MEMBERSHIP_NOT_REVIEWABLE'].includes(code ?? '')) {
        throw new ConflictException({ code, message: 'The brand review outcome could not be applied.' });
      }
      throw error;
    }
  }
}
