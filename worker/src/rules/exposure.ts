export interface PaymentRecord {
  amountCents: number;
  coverageStatus: string;
  userExcluded?: boolean;
}

export interface ExposureAssumptions {
  basis: 'FULL_VENDOR_PAYMENTS' | 'USER_ENTERED_LABOR_PORTION' | 'CUSTOM_EXPOSURE';
  wcRateMicrosPer100: number; // e.g. 5.00 rate -> 5000000 micros
}

export function calculatePotentialExposure(
  payments: PaymentRecord[],
  assumptions: ExposureAssumptions
): { totalExposureCents: number; estimatedPremiumImpactCents: number } {

  if (assumptions.basis !== 'FULL_VENDOR_PAYMENTS') {
    throw new Error('Only FULL_VENDOR_PAYMENTS exposure basis is supported');
  }
  if (!Number.isSafeInteger(assumptions.wcRateMicrosPer100) || assumptions.wcRateMicrosPer100 < 0) {
    throw new Error('Rate must be a nonnegative safe integer');
  }
  let exposure = 0n;
  for (const payment of payments) {
    if (!Number.isSafeInteger(payment.amountCents)) throw new Error('Payment cents must be a safe integer');
    if (!payment.userExcluded && payment.coverageStatus !== 'DOCUMENTED_FOR_PERIOD') {
      exposure += BigInt(payment.amountCents);
    }
  }
  const product = exposure * BigInt(assumptions.wcRateMicrosPer100);
  const denominator = 100000000n;
  // Match Math.round, including negative refund amounts, without floating point multiplication.
  const numerator = product + denominator / 2n;
  const premium = numerator >= 0n ? numerator / denominator : -((-numerator + denominator - 1n) / denominator);
  const totalExposureCents = Number(exposure);
  const estimatedPremiumImpactCents = Number(premium);
  if (!Number.isSafeInteger(totalExposureCents) || !Number.isSafeInteger(estimatedPremiumImpactCents)) {
    throw new Error('Exposure exceeds safe integer range');
  }
  return { totalExposureCents, estimatedPremiumImpactCents };
}
