export interface StockBuckets {
  physical: number;
  quarantine: number;
  committed: number;
  allocated: number;
  buffer: number;
}

export function validateBalance(balance: StockBuckets): void {
  const values = Object.values(balance);
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)
    || balance.physical < balance.quarantine + balance.committed) {
    throw Object.assign(new Error('Stock balance violates physical accounting rules'), { code: 'STOCK_BALANCE_INVALID' });
  }
}

export function calculateAvailableToSell(balance: StockBuckets): number {
  validateBalance(balance);
  return Math.max(0, balance.physical - balance.quarantine - balance.committed - balance.allocated - balance.buffer);
}

export interface AdjustmentPolicy {
  absoluteUnits: number;
  percentage: number;
  version: string;
}

export function needsIndependentApproval(delta: number, currentPhysical: number, policy: AdjustmentPolicy): boolean {
  if (!Number.isSafeInteger(delta) || !Number.isSafeInteger(currentPhysical) || currentPhysical < 0
    || !Number.isSafeInteger(policy.absoluteUnits) || policy.absoluteUnits < 1
    || !Number.isFinite(policy.percentage) || policy.percentage <= 0
    || !/^[A-Za-z0-9._:-]{1,64}$/.test(policy.version)) {
    throw Object.assign(new Error('Adjustment approval policy is invalid'), { code: 'STOCK_POLICY_INVALID' });
  }
  return Math.abs(delta) > policy.absoluteUnits
    || (currentPhysical > 0 && Math.abs(delta) / currentPhysical * 100 > policy.percentage);
}
