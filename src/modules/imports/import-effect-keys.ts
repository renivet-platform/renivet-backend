import { createHash } from 'node:crypto';

export type ImportEffectKind = 'PRODUCT_CREATE' | 'PRODUCT_UPDATE' | 'VARIANT_UPSERT' | 'MEDIA_LINK';

export interface ImportEffectIdentity {
  brandId: string;
  batchId: string;
  sourceRowNumber: number;
  effectKind: ImportEffectKind;
  logicalTargetKey: string;
  payload: unknown;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export function deriveImportEffectKey(identity: ImportEffectIdentity): { effectKey: string; payloadHash: string } {
  const payloadHash = sha256(canonical(identity.payload));
  const effectKey = sha256(canonical({ brandId: identity.brandId, batchId: identity.batchId,
    sourceRowNumber: identity.sourceRowNumber, effectKind: identity.effectKind,
    logicalTargetKey: identity.logicalTargetKey, payloadHash }));
  return { effectKey, payloadHash };
}

