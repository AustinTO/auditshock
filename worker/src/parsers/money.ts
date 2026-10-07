export function parseMoneyToCents(moneyStr: string): number {
  const cleaned = moneyStr.trim().replace(/^\$\s*/, '');
  if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(cleaned)) {
    throw new Error('Invalid monetary amount');
  }
  const [whole = '', fraction = ''] = cleaned.replace(/,/g, '').replace(/^[+-]/, '').split('.');
  const sign = cleaned.startsWith('-') ? -1n : 1n;
  const cents = sign * (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')));
  const value = Number(cents);
  if (!Number.isSafeInteger(value)) throw new Error('Monetary amount exceeds safe integer range');
  return value;
}

export function centsToMoney(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error('Cents must be a safe integer');
  const absolute = BigInt(cents < 0 ? -cents : cents);
  return `${cents < 0 ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}
