// Report over events.jsonl: context saved (net of every overhead), cost, added delay, failures.
//
// Token estimate: 4 characters per token, the same heuristic DSH's token meter uses.
// Baseline: what the host would have put in context without ctx-filter, i.e. the raw output capped
// at the host's own tool-result limit (DSH dsh-base: spill-policy maxInlineTokens = 12,500).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CallEvent } from "./log.ts";

export interface StatsOptions {
  since?: Date;
  until?: Date;
  client?: string;
  /** Host cap on one tool result, in estimated tokens. */
  baselineCapTokens: number;
  /** Sessions the fixed overhead (tool schemas + instructions) is charged to. */
  sessions: number;
  /** Characters of tool definitions the host shows the model (measured by the caller). */
  toolSchemaChars: number;
  /** Characters of the ctx-filter section in the host's instruction file. */
  instructionChars: number;
  /** Optional main-model input price, USD per million tokens, to value the tokens saved once. */
  pricePerMTok?: number;
}

export const tok = (chars: number) => Math.ceil(chars / 4);
/** Fixed tokens per tool call and result (call id, name, wrappers), on top of their text. */
const CALL_ENVELOPE_TOKENS = 30;
/** A Bash call carries a command and a short description; ctx-filter adds want (instead of the description) and cwd. */
const BASH_DESCRIPTION_CHARS = 60;
/** DSH's spill notice when a result is capped. */
const SPILL_NOTICE_TOKENS = 45;

const PRIMARY = new Set(["run", "hook:Bash", "cli:run", "cli:file"]);
const isPrimary = (e: CallEvent) => PRIMARY.has(e.tool) || (e.tool === "filter" && !e.parentId);
const isFollowUp = (e: CallEvent) => e.tool === "read_output" || e.tool === "grep_output" || (e.tool === "filter" && !!e.parentId);

export function parseWhen(s: string, now = new Date()): Date {
  const rel = s.match(/^(\d+)\s*([mhd])$/);
  if (rel) return new Date(now.getTime() - Number(rel[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as "m" | "h" | "d"]);
  const hm = s.match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date(now);
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    return d;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`cannot read time "${s}" (use 30m, 2h, 13:10 or an ISO date)`);
  return d;
}

/** The "# ... ctx-filter" section of an instruction file, up to the next heading of the same level. */
export function instructionSectionChars(file: string): number {
  if (!existsSync(file)) return 0;
  const lines = readFileSync(file, "utf8").split("\n");
  const start = lines.findIndex((l) => /^#{1,3} .*ctx-filter/.test(l));
  if (start === -1) return 0;
  const level = lines[start]!.match(/^#+/)![0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i]!.match(/^(#+) /);
    if (m && m[1]!.length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").length;
}

export function instructionFileFor(client: string | undefined): string {
  return client && /claude/i.test(client) ? join(homedir(), ".claude", "CLAUDE.md") : join(homedir(), ".dsh", "AGENTS.md");
}

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const n = (x: number) => Math.round(x).toLocaleString("en-US");
const sec = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const usd = (x: number) => (x === 0 ? "$0" : x < 0.01 ? `$${x.toFixed(6)}` : `$${x.toFixed(4)}`);

export interface PrimaryRow {
  ev: CallEvent;
  baselineTok: number;
  replyTok: number;
  argExtraTok: number;
  savedTok: number;
  followUps: number;
}

export function compute(events: CallEvent[], o: StatsOptions) {
  const evs = events.filter(
    (e) => (!o.since || new Date(e.ts) >= o.since) && (!o.until || new Date(e.ts) <= o.until) && (!o.client || e.client === o.client || e.client === "hook"),
  );
  const primary = evs.filter(isPrimary);
  const follow = evs.filter(isFollowUp);
  const followById = new Map<string, number>();
  for (const f of follow) if (f.parentId) followById.set(f.parentId, (followById.get(f.parentId) ?? 0) + 1);

  const rows: PrimaryRow[] = primary.map((e) => {
    const raw = e.rawChars ?? e.replyChars;
    const rawTok = tok(raw);
    const baselineTok = rawTok > o.baselineCapTokens ? o.baselineCapTokens : rawTok;
    const replyTok = tok(e.replyChars);
    const cmdChars = (e.command ?? "").length;
    const argExtraTok = e.tool === "hook:Bash" ? 0 : tok(Math.max(0, e.argChars - cmdChars - BASH_DESCRIPTION_CHARS));
    return { ev: e, baselineTok, replyTok, argExtraTok, savedTok: baselineTok - replyTok - argExtraTok, followUps: e.id ? followById.get(e.id) ?? 0 : 0 };
  });
  const followTok = follow.map((f) => tok(f.argChars + f.replyChars) + CALL_ENVELOPE_TOKENS);
  const fixedTok = (tok(o.toolSchemaChars) + tok(o.instructionChars)) * o.sessions;
  const grossSaved = sum(rows.map((r) => r.savedTok));
  const followCost = sum(followTok);
  const net = grossSaved - followCost - fixedTok;
  const baselineTotal = sum(rows.map((r) => r.baselineTok));
  const filtered = rows.filter((r) => !r.ev.whole && r.ev.ok);
  const cost = sum(evs.map((e) => e.costUsd ?? 0));
  return { evs, primary, follow, rows, followTok, fixedTok, grossSaved, followCost, net, baselineTotal, filtered, cost };
}

export function report(events: CallEvent[], o: StatsOptions): string {
  const c = compute(events, o);
  const { evs, rows, follow, filtered } = c;
  if (evs.length === 0) return "No ctx-filter calls in this window.";
  const first = evs[0]!.ts;
  const last = evs[evs.length - 1]!.ts;
  const L: string[] = [];
  const clients = [...new Set(evs.map((e) => e.client))].join(", ");
  L.push(`ctx-filter report · ${new Date(first).toLocaleString()} → ${new Date(last).toLocaleTimeString()} · clients: ${clients}`);
  L.push(`calls: ${evs.length} (${rows.length} primary: run/filter-by-path/hook · ${follow.length} follow-ups: filter-by-id/read/grep)`);
  L.push("");

  // --- context
  const capped = rows.filter((r) => tok(r.ev.rawChars ?? 0) > o.baselineCapTokens).length;
  L.push("CONTEXT (estimated tokens, 4 chars/token, as DSH estimates)");
  L.push(`  without ctx-filter the agent would have seen   ${n(c.baselineTotal).padStart(9)}   (${rows.length} outputs; ${capped} capped by the host at ${n(o.baselineCapTokens)} + notice)`);
  L.push(`  replies it got instead                         ${n(sum(rows.map((r) => r.replyTok))).padStart(9)}`);
  L.push(`  extra arguments (want, cwd)                    ${n(sum(rows.map((r) => r.argExtraTok))).padStart(9)}`);
  L.push(`  = saved on primary calls                       ${n(c.grossSaved).padStart(9)}`);
  L.push(`  − follow-up calls (${follow.length}: args + replies + envelope) ${n(c.followCost).padStart(9)}`);
  L.push(`  − fixed: tool definitions ${n(tok(o.toolSchemaChars))} + instructions ${n(tok(o.instructionChars))}, × ${o.sessions} session(s) ${n(c.fixedTok).padStart(6)}`);
  const pctSaved = c.baselineTotal > 0 ? ` (${((100 * c.net) / c.baselineTotal).toFixed(1)}% of the baseline)` : "";
  L.push(`  = NET CONTEXT SAVED                            ${n(c.net).padStart(9)}${pctSaved}`);
  if (o.pricePerMTok) L.push(`    valued once at $${o.pricePerMTok}/M input tokens: ${usd((c.net / 1e6) * o.pricePerMTok)} (more in practice: context is re-read every later turn)`);
  const small = rows.filter((r) => r.ev.whole).length;
  if (small) L.push(`  note: ${small} outputs were small (≤4 KB) and came back whole; they cost only the extra arguments.`);
  L.push("");

  // --- cost
  const reqs = sum(evs.map((e) => e.modelRequests ?? 0));
  const inTok = sum(evs.map((e) => e.modelInputTokens ?? 0));
  const models = [...new Set(evs.map((e) => e.model).filter((m): m is string => !!m && m !== "none"))].join(", ") || "none";
  L.push("COST (exact, as reported by the gateway)");
  L.push(`  filter model: ${models}`);
  L.push(`  ${reqs} model requests · ${n(inTok)} input tokens · total ${usd(c.cost)}`);
  if (filtered.length) L.push(`  per filtered output ${usd(c.cost / filtered.length)} · per 1,000 tokens saved ${usd(c.grossSaved > 0 ? (1000 * c.cost) / c.grossSaved : 0)}`);
  L.push("");

  // --- delay
  const fms = filtered.map((r) => r.ev.filterMs ?? 0);
  const jms = filtered.map((r) => r.ev.judgeMs ?? 0);
  const exe = rows.map((r) => r.ev.execMs ?? 0).filter((x) => x > 0);
  const fu = follow.map((f) => f.totalMs);
  L.push("DELAY ADDED");
  L.push(`  filtering (chunk + model + render), per filtered output: p50 ${sec(pct(fms, 50))} · p95 ${sec(pct(fms, 95))} · max ${sec(Math.max(0, ...fms))} · total ${sec(sum(fms))}`);
  L.push(`    of which waiting on the model: p50 ${sec(pct(jms, 50))} · p95 ${sec(pct(jms, 95))}`);
  L.push(`  follow-up calls: ${follow.length} · tool time total ${sec(sum(fu))} · each also costs one extra agent turn (model latency, not measured here)`);
  L.push(`  = added tool time ${sec(sum(fms) + sum(fu))}   (for scale: the commands themselves ran ${sec(sum(exe))})`);
  L.push("");

  // --- outcomes
  const failed = evs.filter((e) => !e.ok);
  const fallback = evs.filter((e) => e.fallback);
  const partial = evs.filter((e) => e.partial && !e.fallback);
  const below = evs.filter((e) => e.belowThreshold);
  const overflow = evs.filter((e) => (e.overflow ?? 0) > 0);
  const replacedIds = new Set(filtered.map((r) => r.ev.id).filter(Boolean));
  const withFollow = rows.filter((r) => replacedIds.has(r.ev.id) && r.followUps > 0).length;
  const nonzero = rows.filter((r) => r.ev.exitCode !== undefined && r.ev.exitCode !== 0).length;
  L.push("SUCCESS / FAILURES");
  L.push(`  tool calls failed:                 ${failed.length}${failed.length ? "  ← " + failed.slice(-3).map((e) => `${e.tool}: ${e.error}`).join(" | ") : ""}`);
  L.push(`  model unavailable (pre-rank used): ${fallback.length}${fallback.length ? "  ← " + [...new Set(fallback.map((e) => e.judgeError))].slice(0, 2).join(" | ") : ""}`);
  L.push(`  model ran out of time (partial):   ${partial.length}`);
  L.push(`  model requests split for size:     ${sum(evs.map((e) => e.modelSplits ?? 0))} (rejected as too large, halved and retried; nothing lost)`);
  L.push(`  nothing judged relevant:           ${below.length}`);
  L.push(`  relevant passages did not fit:     ${overflow.length}`);
  L.push(`  filtered outputs needing a follow-up: ${withFollow} of ${replacedIds.size}${replacedIds.size ? ` (${Math.round((100 * withFollow) / replacedIds.size)}%)` : ""}   ← a rough miss rate`);
  L.push(`  commands that exited non-zero:     ${nonzero} (the command's own result, not a filter failure)`);
  return L.join("\n");
}

export function timeline(events: CallEvent[], o: Pick<StatsOptions, "since" | "until" | "client">): string {
  const evs = events.filter((e) => (!o.since || new Date(e.ts) >= o.since) && (!o.until || new Date(e.ts) <= o.until) && (!o.client || e.client === o.client || e.client === "hook"));
  return evs
    .map((e) => {
      const t = new Date(e.ts).toLocaleTimeString();
      const what = e.tool === "read_output" || e.tool === "grep_output" ? `on ${e.parentId}` : (e.command ?? "").slice(0, 60);
      const size = e.rawChars !== undefined ? `${n(tok(e.rawChars))}→${n(tok(e.replyChars))} tok` : `reply ${n(tok(e.replyChars))} tok`;
      const flags = [!e.ok && "FAILED", e.fallback && "fallback", e.belowThreshold && "none-relevant", (e.overflow ?? 0) > 0 && `+${e.overflow} didn't fit`, e.whole && "whole"].filter(Boolean).join(",");
      const timing = e.filterMs !== undefined ? ` filter ${sec(e.filterMs)}` : ` ${sec(e.totalMs)}`;
      return `${t} ${e.tool.padEnd(11)} ${size.padEnd(18)}${timing}${e.costUsd ? " " + usd(e.costUsd) : ""}${flags ? " [" + flags + "]" : ""}  ${what}${e.want ? `  want: ${e.want.slice(0, 60)}` : ""}`;
    })
    .join("\n");
}
