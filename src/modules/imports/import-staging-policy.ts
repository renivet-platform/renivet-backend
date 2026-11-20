/**
 * Import acceptance is independent from catalog eligibility.
 * Source rows are persisted at upload time and are retained for editing even
 * when category, attribute, SKU or source mappings cannot yet be applied.
 * Only safe CREATE/UPDATE actions write private draft products.
 */
export type ImportCatalogAction = 'CREATE' | 'UPDATE' | 'NOOP' | 'NEEDS_REVIEW' | 'INVALID' | 'CONFLICT';

export function shouldStageForCatalogEdit(action: string): boolean {
  return action !== 'CREATE' && action !== 'UPDATE' && action !== 'NOOP';
}

export function mayWritePrivateDraft(action: string): boolean {
  return action === 'CREATE' || action === 'UPDATE';
}
