// Event log (one JSON line per tool result) and the statistics computed from it.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { percentile } from "./core.js";

export const EVENTS_FILE = process.env.CTX_FILTER_DSH_EVENTS ?? join(homedir(), ".ctx-filter", "dsh", "events.jsonl");

export function appendEvent(event, file = EVENTS_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(event) + "\n");
}

export function readEvents(sinceMs = 0, file = EVENTS_FILE) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if ((e.at ?? 0) >= sinceMs) out.push(e);
    } catch {
      // skip a torn line
    }
  }
  return out;
}

/**
 * For one filtered result: model requests that re-sent it (assistant messages after its tool/result
 * until the next compaction), and whether a compaction followed.
 */
export function laterRequests(events, callId) {
  let at = -1;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e?.type === "tool/result" && e.data?.message?.toolCallId === callId) {
      at = i;
      break;
    }
  }
  if (at < 0) return undefined;
  let requests = 0;
  let compacted = false;
  for (let i = at + 1; i < events.length; i++) {
    const t = events[i]?.type ?? "";
    if (t.startsWith("compaction/")) {
      compacted = true;
      break;
    }
    if (t === "assistant/message") requests++;
  }
  return { requests, compacted };
}

export function countCompactions(events) {
  let n = 0;
  let last = "";
  for (const e of events) {
    const t = e?.type ?? "";
    // One condensation writes several compaction/* events in a row; count runs, not events.
    if (t.startsWith("compaction/")) {
      if (!last.startsWith("compaction/")) n++;
    }
    last = t;
  }
  return n;
}

const round = (n, d = 0) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Aggregate statistics. `sessionEvents(id)` returns a session's event array or undefined.
 */
export function computeStats(events, { days, priceInputPerM, priceCachedPerM, sessionEvents, now = Date.now() }) {
  const since = now - days * 86400000;
  const evs = events.filter((e) => (e.at ?? 0) >= since);
  const seen = evs.filter((e) => e.kind === "result");
  const followups = evs.filter((e) => e.kind === "followup");
  const filtered = seen.filter((e) => e.action === "filtered");
  const shadow = seen.filter((e) => e.action === "shadow");
  const judgedRuns = [...filtered, ...shadow];
  const actions = {};
  for (const e of seen) actions[e.action] = (actions[e.action] ?? 0) + 1;

  const allTokens = seen.reduce((a, e) => a + (e.tokensBefore ?? 0), 0);
  const savedOnce = filtered.reduce((a, e) => a + Math.max(0, e.tokensBefore - e.tokensAfter), 0);
  const shadowWouldSave = shadow.reduce((a, e) => a + Math.max(0, e.tokensBefore - e.tokensAfter), 0);
  // Every Jev call costs, including runs that ended up passing the result through.
  const jevCost = seen.reduce((a, e) => a + (e.jev?.costUsd ?? 0), 0);
  const jevIn = judgedRuns.reduce((a, e) => a + (e.jev?.inputTokens ?? 0), 0);
  const jevOut = judgedRuns.reduce((a, e) => a + (e.jev?.outputTokens ?? 0), 0);
  const delays = judgedRuns.map((e) => e.ms ?? 0);

  // Re-sent tokens avoided: each filtered result's saving times the model requests that followed it.
  const sessions = new Map();
  let resentAvoided = 0;
  let laterKnown = 0;
  let laterTotal = 0;
  let compactedAfter = 0;
  for (const e of filtered) {
    let sev = sessions.get(e.sid);
    if (sev === undefined && sessionEvents) {
      sev = sessionEvents(e.sid) ?? null;
      sessions.set(e.sid, sev);
    }
    const later = sev ? laterRequests(sev, e.callId) : undefined;
    if (!later) continue;
    laterKnown++;
    laterTotal += later.requests;
    if (later.compacted) compactedAfter++;
    resentAvoided += Math.max(0, e.tokensBefore - e.tokensAfter) * later.requests;
  }
  const affectedSessions = new Set(filtered.map((e) => e.sid));
  let compactions = 0;
  for (const sid of affectedSessions) {
    const sev = sessions.get(sid) ?? (sessionEvents ? sessionEvents(sid) : undefined);
    if (sev) compactions += countCompactions(sev);
  }
  const mainModelSaving = (savedOnce * priceInputPerM + resentAvoided * priceCachedPerM) / 1e6;

  const followupCalls = new Set(followups.map((f) => f.ofCallId));
  const byTool = {};
  for (const e of seen) {
    const t = (byTool[e.tool] ??= { tool: e.tool, results: 0, tokens: 0, filtered: 0, saved: 0, followups: 0 });
    t.results++;
    t.tokens += e.tokensBefore ?? 0;
    if (e.action === "filtered") {
      t.filtered++;
      t.saved += Math.max(0, e.tokensBefore - e.tokensAfter);
      if (followupCalls.has(e.callId)) t.followups++;
    }
  }
  const byDay = {};
  for (const e of filtered) {
    const d = new Date(e.at).toISOString().slice(0, 10);
    const b = (byDay[d] ??= { day: d, filtered: 0, saved: 0, jevCost: 0 });
    b.filtered++;
    b.saved += Math.max(0, e.tokensBefore - e.tokensAfter);
    b.jevCost += e.jev?.costUsd ?? 0;
  }
  const recent = seen
    .filter((e) => ["filtered", "shadow", "jev-error", "no-gain", "mostly-relevant"].includes(e.action))
    .slice(-60)
    .reverse()
    .map((e) => ({ ...e, followedUp: followupCalls.has(e.callId) }));

  return {
    days,
    since,
    eventsFile: EVENTS_FILE,
    results: seen.length,
    resultTokens: allTokens,
    actions,
    filtered: filtered.length,
    shadow: shadow.length,
    tokensBeforeFiltered: filtered.reduce((a, e) => a + e.tokensBefore, 0),
    tokensAfterFiltered: filtered.reduce((a, e) => a + e.tokensAfter, 0),
    savedOnce,
    shadowWouldSave,
    savedShareOfAllToolOutput: allTokens > 0 ? round(savedOnce / allTokens, 4) : 0,
    resentAvoided,
    laterRequests: { known: laterKnown, average: laterKnown > 0 ? round(laterTotal / laterKnown, 1) : 0, compactedAfter },
    mainModelSaving: round(mainModelSaving, 4),
    jev: { costUsd: round(jevCost, 5), inputTokens: jevIn, outputTokens: jevOut, runs: judgedRuns.length },
    netSaving: round(mainModelSaving - jevCost, 4),
    delayMs: { average: delays.length ? round(delays.reduce((a, b) => a + b, 0) / delays.length) : 0, p50: percentile(delays, 50), p95: percentile(delays, 95), total: delays.reduce((a, b) => a + b, 0) },
    failures: actions["jev-error"] ?? 0,
    followups: { calls: followupCalls.size, rate: filtered.length > 0 ? round(followupCalls.size / filtered.length, 3) : 0 },
    sessions: { affected: affectedSessions.size, compactions },
    byTool: Object.values(byTool).sort((a, b) => b.tokens - a.tokens),
    byDay: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)),
    recent,
    toolsSeen: [...new Set(seen.map((e) => e.tool))].sort(),
  };
}
