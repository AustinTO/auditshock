import { parseMoneyToCents } from './money';
import { isValidDate } from '../rules/coverage';

export interface ParsedLedgerRow {
  vendorName: string;
  paymentDate?: string;
  workStartDate?: string;
  workEndDate?: string;
  amountCents: number;
  memo?: string;
}

export function parseCsvLedger(
  csvContent: string,
  columnMapping: { vendor: string; amount: string; date?: string; memo?: string }
): ParsedLedgerRow[] {
  const records = parseCsvRecords(csvContent.replace(/^\uFEFF/, ''));
  const header = records.shift();
  if (!header) return [];
  const headers = header.map(value => value.trim().toLowerCase());
  if (new Set(headers).size !== headers.length) throw new Error('Duplicate CSV headers');
  const indexFor = (column: string): number => {
    const index = headers.indexOf(column.trim().toLowerCase());
    if (index === -1) throw new Error(`Mapped column not found: ${column}`);
    return index;
  };
  const vendorIdx = indexFor(columnMapping.vendor);
  const amountIdx = indexFor(columnMapping.amount);
  const dateIdx = columnMapping.date ? indexFor(columnMapping.date) : -1;
  const memoIdx = columnMapping.memo ? indexFor(columnMapping.memo) : -1;
  return records.map((cols, index) => {
    const rowNumber = index + 2;
    if (cols.length !== headers.length) throw new Error(`CSV row ${rowNumber} has an invalid column count`);
    const vendorName = cols[vendorIdx]!.trim();
    if (!vendorName) throw new Error(`CSV row ${rowNumber} has no vendor`);
    const row: ParsedLedgerRow = { vendorName, amountCents: parseMoneyToCents(cols[amountIdx]!) };
    if (dateIdx !== -1 && cols[dateIdx]!.trim()) {
      const paymentDate = cols[dateIdx]!.trim();
      if (!isValidDate(paymentDate)) throw new Error(`CSV row ${rowNumber} requires a valid YYYY-MM-DD date`);
      row.paymentDate = paymentDate;
    }
    if (memoIdx !== -1) row.memo = cols[memoIdx]!.trim();
    return row;
  });
}

function parseCsvRecords(content: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;
  const finishRecord = () => {
    record.push(field);
    if (record.some(value => value.trim() !== '') || record.length > 1) records.push(record);
    record = [];
    field = '';
    closedQuote = false;
  };
  for (let i = 0; i < content.length; i++) {
    const char = content[i]!;
    if (quoted) {
      if (char === '"') {
        if (content[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closedQuote = true; }
      } else field += char;
    } else if (char === ',') {
      record.push(field); field = ''; closedQuote = false;
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && content[i + 1] === '\n') i++;
      finishRecord();
    } else if (char === '"') {
      if (field || closedQuote) throw new Error('Malformed CSV quote');
      quoted = true;
    } else {
      if (closedQuote) throw new Error('Unexpected text after CSV quote');
      field += char;
    }
  }
  if (quoted) throw new Error('Unterminated CSV quote');
  if (field || record.length || closedQuote) finishRecord();
  return records;
}
