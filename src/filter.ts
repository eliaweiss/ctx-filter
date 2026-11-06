// The filter: chunk -> pre-rank -> model judges -> keep whole passages over the threshold, within the byte budget.
import { chunkText, type Chunk } from "./chunk.ts";
import type { Config, Provider } from "./config.ts";
import { D1Judge } from "./judge/d1.ts";
import { JevJudge } from "./judge/jev.ts";
import { emptyUsage, type Judge, type JudgeUsage } from "./judge/types.ts";
import { pickCandidates, prerank } from "./prerank.ts";

export interface Kept {
  chunk: Chunk;
  /** Undefined when the passage was picked by the pre-rank, not the model. */
  p?: number;
}

export interface FilterOutcome {
  whole: boolean;
  kept: Kept[];
  totalPassages: number;
  judged: number;
  judge: string;
  /** No passage reached the threshold; `kept` holds the single best guess, if any. */
  belowThreshold: boolean;
  notes: string[];
  ms: number;
  /** Time spent waiting on the model. */
  judgeMs: number;
  usage: JudgeUsage;
  /** The model failed outright and the pre-rank picked the passages. */
  fallback: boolean;
  /** The model's error, when it failed outright. */
  judgeError?: string;
  /** Some candidate passages were not judged (time budget or a failed batch). */
  partial: boolean;
  /** Passages judged relevant that did not fit the return budget. */
  overflow: number;
}

export function makeJudge(provider: Provider, cfg: Config): Judge | null {
  if (provider === "jev") return new JevJudge(cfg.jev);
  if (provider === "d1") return new D1Judge(cfg.d1);
  return null;
}

export function judgeBudget(provider: Provider, cfg: Config): number {
  return provider === "d1" ? cfg.d1.maxJudgeBytes : cfg.jev.maxJudgeBytes;
}

export async function filterText(
  text: string,
  want: string,
  cfg: Config,
  opts: { provider?: Provider; source?: string; judge?: Judge | null } = {},
): Promise<FilterOutcome> {
  const t0 = Date.now();
  const provider = opts.provider ?? cfg.provider;
  if (Buffer.byteLength(text) <= cfg.triggerBytes) {
    return {
      whole: true, kept: [], totalPassages: 0, judged: 0, judge: "none", belowThreshold: false, notes: [], ms: 0,
      judgeMs: 0, usage: emptyUsage(), fallback: false, partial: false, overflow: 0,
    };
  }
  const chunks = chunkText(text, cfg.chunkBytes);
  const order = prerank(chunks, want);
  const notes: string[] = [];
  const judge = opts.judge !== undefined ? opts.judge : makeJudge(provider, cfg);
  let probs = new Map<number, number>();
  let usage = emptyUsage();
  let judgeMs = 0;
  let fallback = false;
  let judgeError: string | undefined;
  let partial = false;
  if (judge) {
    const candidates = pickCandidates(chunks, order, judgeBudget(provider, cfg));
    if (candidates.length < chunks.length) notes.push(`${chunks.length - candidates.length} lower-ranked passages were not sent to the model`);
    const tj = Date.now();
    try {
      const res = await judge.judge({
        want,
        source: opts.source,
        passages: candidates.map((i) => chunks[i]!),
        deadline: t0 + cfg.judgeTimeoutMs,
      });
      probs = res.probs;
      usage = res.usage;
      partial = res.probs.size < candidates.length;
      if (res.note) notes.push(res.note);
    } catch (e) {
      fallback = true;
      judgeError = (e as Error).message;
      notes.push(`model unavailable (${judgeError}); passages picked by keyword pre-rank`);
    }
    judgeMs = Date.now() - tj;
  } else {
    notes.push("no model configured; passages picked by keyword pre-rank");
  }

  let ranked: Kept[];
  let belowThreshold = false;
  if (probs.size > 0) {
    const passing = [...probs.entries()].filter(([, p]) => p >= cfg.threshold).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    if (passing.length > 0) {
      ranked = passing.map(([i, p]) => ({ chunk: chunks[i]!, p }));
    } else {
      belowThreshold = true;
      const best = [...probs.entries()].sort((a, b) => b[1] - a[1])[0]!;
      ranked = [{ chunk: chunks[best[0]]!, p: best[1] }];
    }
  } else {
    ranked = order.map((i) => ({ chunk: chunks[i]! }));
  }

  const kept: Kept[] = [];
  let used = 0;
  for (const k of ranked) {
    if (used + k.chunk.bytes > cfg.returnBytes) continue; // whole passages only; a smaller one may still fit
    kept.push(k);
    used += k.chunk.bytes;
  }
  const dropped = ranked.length - kept.length;
  if (probs.size > 0 && !belowThreshold && dropped > 0) notes.push(`${dropped} more relevant passages did not fit the ${cfg.returnBytes} B budget`);
  kept.sort((a, b) => a.chunk.index - b.chunk.index);
  return {
    whole: false,
    kept,
    totalPassages: chunks.length,
    judged: probs.size,
    judge: judge?.name ?? "none",
    belowThreshold,
    notes,
    ms: Date.now() - t0,
    judgeMs,
    usage,
    fallback,
    judgeError,
    partial,
    overflow: probs.size > 0 && !belowThreshold ? dropped : 0,
  };
}

export interface RenderInfo {
  id: string;
  path: string;
  want: string;
  bytes: number;
  lines: number;
  exitCode?: number | null;
  /** Mention the MCP tools in the footer (false for the Bash hook when the server may not be installed). */
  mcpTools: boolean;
}

function kb(n: number): string {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

export function render(out: FilterOutcome, text: string, info: RenderInfo): string {
  const exit = info.exitCode === undefined ? "" : `exit ${info.exitCode ?? "killed"} · `;
  if (out.whole) return info.exitCode === undefined ? text : `${text}${text.endsWith("\n") || text === "" ? "" : "\n"}[exit ${info.exitCode ?? "killed"}]`;
  const body: string[] = [];
  let prevEnd = 0;
  for (const k of out.kept) {
    const gap = k.chunk.startLine > prevEnd + 1 ? "… " : "";
    const p = k.p === undefined ? "" : ` p=${k.p.toFixed(2)}`;
    body.push(`${gap}── lines ${k.chunk.startLine}-${k.chunk.endLine}${p}`);
    body.push(k.chunk.text);
    prevEnd = k.chunk.endLine;
  }
  if (prevEnd < info.lines && out.kept.length > 0) body.push("…");
  const keptBytes = out.kept.reduce((a, k) => a + k.chunk.bytes, 0);
  const head = out.belowThreshold
    ? `No passage was judged relevant to the want; the best guess is shown.`
    : `Kept ${out.kept.length} of ${out.totalPassages} passages (${kb(keptBytes)}).`;
  const footer = [
    `[ctx-filter] ${exit}${info.lines} lines · ${kb(info.bytes)} · id ${info.id} · ${out.judge}, judged ${out.judged}, ${out.ms} ms`,
    `want: ${JSON.stringify(info.want.length > 200 ? info.want.slice(0, 200) + "…" : info.want)}`,
    head,
    ...out.notes.map((n) => `note: ${n}`),
    `full output: ${info.path}`,
    info.mcpTools
      ? `more: filter({id:"${info.id}", want}) · read_output({id, from_line, to_line}) · grep_output({id, pattern})`
      : `more: Read the file with offset/limit, or grep -n it.`,
  ];
  return [...body, "", ...footer].join("\n");
}
