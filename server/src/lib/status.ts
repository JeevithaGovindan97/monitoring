/** Expected-status expressions: "200-399", "200,204,301-302". */
export type StatusRange = [number, number];

export function parseExpectedStatus(expr: string): StatusRange[] {
  const ranges: StatusRange[] = [];
  for (const partRaw of expr.split(',')) {
    const part = partRaw.trim();
    if (!part) continue;
    const m = /^(\d{3})(?:\s*-\s*(\d{3}))?$/.exec(part);
    if (!m) throw new Error(`Invalid status expression "${part}"`);
    const lo = Number(m[1]);
    const hi = m[2] ? Number(m[2]) : lo;
    if (lo < 100 || hi > 599 || hi < lo) throw new Error(`Invalid status range "${part}"`);
    ranges.push([lo, hi]);
  }
  if (!ranges.length) throw new Error('Expected status is empty');
  return ranges;
}

export function isValidExpectedStatus(expr: string): boolean {
  try {
    parseExpectedStatus(expr);
    return true;
  } catch {
    return false;
  }
}

export function statusMatches(expr: string, code: number): boolean {
  return parseExpectedStatus(expr).some(([lo, hi]) => code >= lo && code <= hi);
}
