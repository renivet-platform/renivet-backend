/**
 * Bulk catalogue import review rules.
 *
 * Pure decision logic, deliberately separate from persistence and controllers.
 * An import approval is never permission to publish or to bypass product QC,
 * price, media-rights, taxonomy, or stock checks.
 */
export type BulkImportReviewState = 'STAGED' | 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
export type BulkImportReviewDecision = 'SUBMIT' | 'APPROVE' | 'REJECT';
export type BulkImportReviewActor = 'BRAND_EDITOR' | 'AUTHORISED_REVIEWER';
export type ImportFieldDomain = 'CATALOG' | 'VARIANT' | 'PRICE' | 'MEDIA' | 'CATEGORY' | 'ATTRIBUTES';

export interface BulkImportRowReview {
  readonly state: BulkImportReviewState;
  readonly version: number;
  readonly brandId: string;
  readonly submittedBy: string | null;
  readonly reviewedBy: string | null;
  readonly fields: readonly ImportFieldDomain[];
  readonly rejectionReason: string | null;
}

export type ReviewTransitionResult =
  | { ok: true; next: BulkImportRowReview }
  | { ok: false; code: string };

export function transitionBulkImportReview(
  current: BulkImportRowReview,
  decision: BulkImportReviewDecision,
  actor: { userId: string; brandId: string; role: BulkImportReviewActor },
  expectedVersion: number,
  reason?: string,
): ReviewTransitionResult {
  if (!actor.userId || !actor.brandId || actor.brandId !== current.brandId) return { ok: false, code: 'IMPORT_REVIEW_SCOPE_DENIED' };
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== current.version) return { ok: false, code: 'IMPORT_REVIEW_STALE' };
  if (decision === 'SUBMIT') {
    if (current.state !== 'STAGED') return { ok: false, code: 'IMPORT_REVIEW_TRANSITION_DENIED' };
    return { ok: true, next: { ...current, state: 'PENDING_REVIEW', version: current.version + 1,
      submittedBy: actor.userId, reviewedBy: null, rejectionReason: null } };
  }
  if (actor.role !== 'AUTHORISED_REVIEWER' || current.state !== 'PENDING_REVIEW') return { ok: false, code: 'IMPORT_REVIEW_TRANSITION_DENIED' };
  if (!current.submittedBy || actor.userId === current.submittedBy) return { ok: false, code: 'IMPORT_REVIEW_SELF_APPROVAL_DENIED' };
  if (decision === 'REJECT') {
    if (!reason || !reason.trim() || reason.trim().length > 1000) return { ok: false, code: 'IMPORT_REVIEW_REASON_REQUIRED' };
    return { ok: true, next: { ...current, state: 'REJECTED', version: current.version + 1,
      reviewedBy: actor.userId, rejectionReason: reason.trim() } };
  }
  if (decision === 'APPROVE') {
    return { ok: true, next: { ...current, state: 'APPROVED', version: current.version + 1,
      reviewedBy: actor.userId, rejectionReason: null } };
  }
  return { ok: false, code: 'IMPORT_REVIEW_TRANSITION_DENIED' };
}

/**
 * The approval queue cannot itself make a product visible in the storefront.
 * Callers must still enforce the canonical publication and QC/published-revision rules.
 */
export function bulkImportMayPublish(row: BulkImportRowReview): boolean {
  void row;
  return false;
}
