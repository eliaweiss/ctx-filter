// Cheap pre-rank: decides which passages the model judges when the output is larger than its budget,
// and ranks the rest when the model is unavailable or out of time. It never decides what is returned
// on its own when the model answered.
import type { Chunk } from "./chunk.ts";

const SIGNAL =
  /\b(error|errors|failed|failure|fail|fatal|exception|traceback|panic|assert(ion)?|denied|refused|timeout|timed out|not found|cannot|can't|unable|warning|warn|undefined|segfault|exit code|non-zero)\b|✘|✗|×|FAIL|ERR!/i;
const SUMMARY = /\b(\d+\s+(passed|failed|skipped|errors?|warnings?|tests?)|total|summary|done in|finished)\b/i;

const STOP = new Set(
  "a an and are as at be by do does for from has have how i if in is it its me my of on or show tell that the this to was what when where which who why with you your all any find get give list".split(" "),
);

export function words(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}_][\p{L}\p{N}_.\-/]*/gu) ?? [])
    .flatMap((w) => [w, ...w.split(/[.\-/]/)])
    .filter((w) => w.length > 1 && !STOP.has(w));
}

export function prerank(chunks: Chunk[], want: string): number[] {
  const n = chunks.length;
  if (n === 0) return [];
  const query = [...new Set(words(want))];
  const docs = chunks.map((c) => new Set(words(c.text)));
  const idf = new Map<string, number>();
  for (const q of query) {
    const df = docs.reduce((acc, d) => acc + (d.has(q) ? 1 : 0), 0);
    idf.set(q, df === 0 ? 0 : Math.log(1 + n / df));
  }
  const scores = chunks.map((c, i) => {
    let s = 0;
    for (const q of query) if (docs[i]!.has(q)) s += idf.get(q) ?? 0;
    if (SIGNAL.test(c.text)) s += 1.5;
    if (SUMMARY.test(c.text)) s += 1;
    if (i === 0) s += 0.75;
    if (i >= n - 2) s += 1;
    return s;
  });
  return chunks.map((_, i) => i).sort((a, b) => scores[b]! - scores[a]! || a - b);
}

/** Indices to judge: best pre-ranked first, until the byte budget is used. */
export function pickCandidates(chunks: Chunk[], order: number[], maxBytes: number): number[] {
  const out: number[] = [];
  let used = 0;
  for (const i of order) {
    const b = chunks[i]!.bytes;
    if (used + b > maxBytes) continue;
    out.push(i);
    used += b;
  }
  return out;
}
