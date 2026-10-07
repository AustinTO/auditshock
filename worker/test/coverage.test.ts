import { describe, it, expect } from 'vitest';
import { doRangesOverlap, isFullyCovered, determineCoverageStatus } from '../src/rules/coverage';

describe('Coverage Engine', () => {
  it('detects overlap correctly', () => {
    const work = { start: '2026-06-01', end: '2026-06-30' };
    const cov1 = { start: '2026-01-01', end: '2027-01-01' };
    const cov2 = { start: '2026-07-01', end: '2027-07-01' };

    expect(doRangesOverlap(work, cov1)).toBe(true);
    expect(doRangesOverlap(work, cov2)).toBe(false);
  });

  it('detects full coverage correctly', () => {
    const work = { start: '2026-06-01', end: '2026-06-30' };
    const cov1 = { start: '2026-01-01', end: '2027-01-01' };
    const cov2 = { start: '2026-06-15', end: '2027-01-01' };

    expect(isFullyCovered(work, cov1)).toBe(true);
    expect(isFullyCovered(work, cov2)).toBe(false);
  });

  it('determines status', () => {
    const work = { start: '2026-06-01', end: '2026-06-30' };
    const coverages = [{ start: '2026-01-01', end: '2027-01-01' }];

    expect(determineCoverageStatus(work, coverages)).toBe('DOCUMENTED_FOR_PERIOD');
  });
});
