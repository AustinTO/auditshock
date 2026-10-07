import { describe, it, expect } from 'vitest';
import { parseMoneyToCents, centsToMoney } from '../src/parsers/money';

describe('Money Parser', () => {
  it('parses valid money strings', () => {
    expect(parseMoneyToCents('$1,500.00')).toBe(150000);
    expect(parseMoneyToCents('5000.50')).toBe(500050);
    expect(parseMoneyToCents('$ 200')).toBe(20000);
  });

  it('handles invalid strings gracefully', () => {
    expect(() => parseMoneyToCents('')).toThrow();
    expect(() => parseMoneyToCents('abc')).toThrow();
  });

  it('converts cents to money string', () => {
    expect(centsToMoney(150000)).toBe('1500.00');
    expect(centsToMoney(200)).toBe('2.00');
  });
});

it('rejects partial, malformed, fractional-cent and unsafe amounts', () => {
  for (const value of ['12abc', '1,00', 'Infinity', '1.005', '90071992547410']) {
    expect(() => parseMoneyToCents(value)).toThrow();
  }
  expect(parseMoneyToCents('0.29')).toBe(29);
  expect(parseMoneyToCents('-1.01')).toBe(-101);
  expect(centsToMoney(Number.MAX_SAFE_INTEGER)).toBe('90071992547409.91');
});
