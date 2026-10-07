export interface DateRange {
  start: string;
  end: string;
}

export function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validRange(range: DateRange): boolean {
  return isValidDate(range.start) && isValidDate(range.end) && range.start <= range.end;
}

export function doRangesOverlap(work: DateRange, coverage: DateRange): boolean {
  return validRange(work) && validRange(coverage) && work.start <= coverage.end && work.end >= coverage.start;
}

export function isFullyCovered(work: DateRange, coverage: DateRange): boolean {
  return validRange(work) && validRange(coverage) && work.start >= coverage.start && work.end <= coverage.end;
}

export function determineCoverageStatus(
  workDates: { start?: string; end?: string; paymentProxy?: string },
  coverages: DateRange[]
): 'DOCUMENTED_FOR_PERIOD' | 'PARTIALLY_DOCUMENTED' | 'NO_MATCHING_COI' | 'DOCUMENT_DATES_DO_NOT_COVER_PERIOD' | 'WORK_DATE_UNKNOWN' {
  if (coverages.length === 0) return 'NO_MATCHING_COI';
  const workRange = workDates.start || workDates.end
    ? { start: workDates.start ?? '', end: workDates.end ?? '' }
    : { start: workDates.paymentProxy ?? '', end: workDates.paymentProxy ?? '' };
  if (!validRange(workRange)) return 'WORK_DATE_UNKNOWN';

  const ranges = coverages.filter(validRange).map(range => ({ ...range })).sort((a, b) => a.start.localeCompare(b.start));
  const merged: DateRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && Date.parse(`${range.start}T00:00:00Z`) <= Date.parse(`${previous.end}T00:00:00Z`) + 86400000) {
      if (range.end > previous.end) previous.end = range.end;
    } else merged.push(range);
  }
  if (merged.some(range => isFullyCovered(workRange, range))) return 'DOCUMENTED_FOR_PERIOD';
  if (merged.some(range => doRangesOverlap(workRange, range))) return 'PARTIALLY_DOCUMENTED';
  return 'DOCUMENT_DATES_DO_NOT_COVER_PERIOD';
}
