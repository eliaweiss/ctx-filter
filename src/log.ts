// One JSON line per tool call in <home>/events.jsonl. Logging never throws: a failed write is dropped.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./config.ts";
import type { FilterOutcome } from "./filter.ts";

export const EVENTS_FILE = join(HOME_DIR, "events.jsonl");

export type ToolName = "run" | "filter" | "read_output" | "grep_output" | "hook:Bash" | "cli:run" | "cli:file";

export interface CallEvent {
  ts: string;
  /** Which host called: MCP clientInfo name (e.g. "dsh", "claude-code"), or "hook"/"cli". */
  client: string;
  pid: number;
  tool: ToolName;
  ok: boolean;
  error?: string;
  /** Stored output this call produced (run, filter by path) or read (filter/read/grep by id). */
  id?: string;
  /** For follow-ups: the id the agent asked about. */
  parentId?: string;
  cwd?: string;
  command?: string;
  want?: string;
  provider?: string;
  /** Characters the agent sent as tool arguments (JSON). */
  argChars: number;
  /** Characters the agent got back. */
  replyChars: number;
  /** Characters of the full output (before filtering); absent for read/grep. */
  rawChars?: number;
  rawLines?: number;
  exitCode?: number | null;
  /** Output came back whole (at or under the trigger size). */
  whole?: boolean;
  passages?: number;
  judged?: number;
  kept?: number;
  belowThreshold?: boolean;
  fallback?: boolean;
  judgeError?: string;
  partial?: boolean;
  overflow?: number;
  /** Command run time (the cost the agent pays with or without ctx-filter). */
  execMs?: number;
  /** Delay added by ctx-filter: chunk + model + render. */
  filterMs?: number;
  judgeMs?: number;
  totalMs: number;
  model?: string;
  modelRequests?: number;
  modelInputTokens?: number;
  modelOutputTokens?: number;
  /** Model requests rejected as too large, then split and retried. */
  modelSplits?: number;
  costUsd?: number;
}

const clip = (s: string | undefined, n = 300) => (s === undefined ? undefined : s.length > n ? s.slice(0, n) + "…" : s);

export function outcomeFields(out: FilterOutcome): Partial<CallEvent> {
  return {
    whole: out.whole,
    passages: out.totalPassages,
    judged: out.judged,
    kept: out.kept.length,
    belowThreshold: out.belowThreshold,
    fallback: out.fallback,
    judgeError: clip(out.judgeError, 200),
    partial: out.partial,
    overflow: out.overflow,
    filterMs: out.ms,
    judgeMs: out.judgeMs,
    model: out.judge,
    modelRequests: out.usage.requests,
    modelInputTokens: out.usage.inputTokens,
    modelOutputTokens: out.usage.outputTokens,
    modelSplits: out.usage.splits,
    costUsd: out.usage.costUsd,
  };
}

export function logEvent(ev: Omit<CallEvent, "ts" | "pid">): void {
  try {
    mkdirSync(HOME_DIR, { recursive: true });
    const full: CallEvent = { ts: new Date().toISOString(), pid: process.pid, ...ev, command: clip(ev.command), want: clip(ev.want) };
    appendFileSync(EVENTS_FILE, JSON.stringify(full) + "\n");
  } catch {
    // logging must never break a tool call
  }
}

export function readEvents(file = EVENTS_FILE): CallEvent[] {
  if (!existsSync(file)) return [];
  const out: CallEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as CallEvent);
    } catch {
      // skip a torn line
    }
  }
  return out;
}
