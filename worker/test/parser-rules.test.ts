import { describe, expect, it } from 'vitest';
import { parseCsvLedger } from '../src/parsers/csv';
import { determineCoverageStatus, doRangesOverlap } from '../src/rules/coverage';
import { calculatePotentialExposure } from '../src/rules/exposure';
import { normalizeName } from '../src/matching/normalize-name';

const mapping = { vendor: 'vendor', amount: 'amount', date: 'date', memo: 'memo' };

describe('Ledger integrity', () => {
  it('preserves quoted multiline fields and escaped quotes', () => {
    expect(parseCsvLedger('\uFEFFvendor,amount,date,memo\r\n"A, B",0.29,2024-02-29,"first\n""second"""\r\n', mapping)).toEqual([
      { vendorName: 'A, B', amountCents: 29, paymentDate: '2024-02-29', memo: 'first\n"second"' }
    ]);
  });
  it('rejects malformed records instead of silently dropping payments', () => {
    for (const row of ['A,12abc,2024-02-29,x', 'A,12,2023-02-29,x', ',12,2024-02-29,x', 'A,12', '"A,12,2024-02-29,x', '"A"x,12,2024-02-29,x']) {
      expect(() => parseCsvLedger(`vendor,amount,date,memo\n${row}`, mapping)).toThrow();
    }
    expect(() => parseCsvLedger('vendor,amount\nA,12', mapping)).toThrow();
  });
});

it('validates work and policy dates and joins consecutive policies without hiding gaps', () => {
  const work = { start: '2024-01-01', end: '2024-12-31' };
  expect(determineCoverageStatus(work, [{ start: '2024-07-01', end: '2024-12-31' }, { start: '2024-01-01', end: '2024-06-30' }])).toBe('DOCUMENTED_FOR_PERIOD');
  expect(determineCoverageStatus(work, [{ start: '2024-01-01', end: '2024-06-29' }, { start: '2024-07-01', end: '2024-12-31' }])).toBe('PARTIALLY_DOCUMENTED');
  expect(determineCoverageStatus({ start: '2024-02-30', end: '2024-03-01' }, [work])).toBe('WORK_DATE_UNKNOWN');
  expect(doRangesOverlap({ start: '2024-12-31', end: '2024-01-01' }, work)).toBe(false);
});

it('calculates exposure exactly and rejects unavailable bases', () => {
  const payments = [{ amountCents: 100000, coverageStatus: 'NO_MATCHING_COI' }, { amountCents: 200000, coverageStatus: 'DOCUMENTED_FOR_PERIOD' }, { amountCents: 300000, coverageStatus: 'NO_MATCHING_COI', userExcluded: true }];
  expect(calculatePotentialExposure(payments, { basis: 'FULL_VENDOR_PAYMENTS', wcRateMicrosPer100: 5000000 })).toEqual({ totalExposureCents: 100000, estimatedPremiumImpactCents: 5000 });
  expect(() => calculatePotentialExposure(payments, { basis: 'CUSTOM_EXPOSURE', wcRateMicrosPer100: 5000000 })).toThrow();
  expect(() => calculatePotentialExposure(payments, { basis: 'FULL_VENDOR_PAYMENTS', wcRateMicrosPer100: NaN })).toThrow();
});

it('preserves meaningful internal words and equates ampersands with and', () => {
  expect(normalizeName('Company Store LLC')).toBe('company store');
  expect(normalizeName('A&B, Inc.')).toBe(normalizeName('A and B LLC'));
  expect(normalizeName('Acme L.L.C.')).toBe('acme');
});
