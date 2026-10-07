export function normalizeName(name: string | null | undefined): string {
  if (!name) return '';
  let norm = name.toLowerCase().replace(/&/g, ' and ');
  norm = norm.replace(/[.,:;'"!@#\$%\^\*\(\)\[\]\{\}\\\/\|\?\>\<~`]/g, ' ').replace(/\s+/g, ' ').trim();
  const suffix = /(?:^|\s)(?:llc|l l c|inc|incorporated|corp|corporation|co|company|pllc|lp|llp|ltd|limited)$/;
  while (suffix.test(norm)) norm = norm.replace(suffix, '').trim();
  return norm;
}
