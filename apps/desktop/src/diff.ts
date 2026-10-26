export interface DiffLine {
  op: ' ' | '+' | '-';
  text: string;
}

/** Line diff by longest common subsequence, with `context` unchanged lines around each change and "…" for the rest. */
export function diffLines(a: string, b: string, context = 2): DiffLine[] {
  const x = a.split('\n');
  const y = b.split('\n');
  const lcs: number[][] = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) {
      lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const all: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { all.push({ op: ' ', text: x[i]! }); i++; j++; }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) all.push({ op: '-', text: x[i++]! });
    else all.push({ op: '+', text: y[j++]! });
  }
  while (i < x.length) all.push({ op: '-', text: x[i++]! });
  while (j < y.length) all.push({ op: '+', text: y[j++]! });

  if (!all.some((l) => l.op !== ' ')) return [];
  // keep changes plus `context` lines either side; collapse every skipped stretch (including at the ends) to one "…"
  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((l, k) => {
    if (l.op === ' ') return;
    for (let n = Math.max(0, k - context); n <= Math.min(all.length - 1, k + context); n++) keep[n] = true;
  });
  const out: DiffLine[] = [];
  all.forEach((l, k) => {
    if (keep[k]) out.push(l);
    else if (out[out.length - 1]?.text !== '…') out.push({ op: ' ', text: '…' });
  });
  return out;
}

export const diffJson = (before: unknown, after: unknown, context = 2): DiffLine[] =>
  diffLines(JSON.stringify(before, null, 2), JSON.stringify(after, null, 2), context);

export const changedLines = (d: DiffLine[]): number => d.filter((l) => l.op !== ' ').length;
