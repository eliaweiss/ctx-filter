// Event log (one JSON line per tool result) and the statistics computed from it.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { percentile } from "./core.js";

export const EVENTS_FILE = process.env.CTX_FILTER_DSH_EVENTS ?? join(homedir(), ".ctx-filter", "dsh", "events.jsonl");

export function appendEvent(event, file = EVENTS_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(event) + "\n");
}

/**
 * Reset the statistics: move the event log aside as `events-archive-<stamp>.jsonl` next to it, so the next
 * event starts a new log. Nothing is deleted. Returns the archive path, or undefined when there was no log.
 */
export function resetEvents(file = EVENTS_FILE, now = new Date()) {
  if (!existsSync(file)) return undefined;
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const stem = basename(file).replace(/\.jsonl$/, "");
  let archive = join(dirname(file), `${stem}-archive-${stamp}.jsonl`);
  for (let i = 2; existsSync(archive); i++) archive = join(dirname(file), `${stem}-archive-${stamp}-${i}.jsonl`);
  renameSync(file, archive);
  return archive;
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

/** The model request (assistant message) that issued tool call `callId`: its usage and how many calls it made. */
export function callingRequest(events, callId) {
  for (const e of events) {
    if (e?.type !== "assistant/message") continue;
    const content = e.data?.message?.content;
    if (!Array.isArray(content)) continue;
    const calls = content.filter((b) => b?.type === "tool-call");
    if (calls.some((b) => b.id === callId)) return { usage: e.data?.usage, calls: calls.length };
  }
  return undefined;
}

/** Price of one model request from its usage, $ per million tokens. */
export function requestCostUsd(usage, prices) {
  if (!usage) return undefined;
  const n = (k) => (typeof usage[k] === "number" ? usage[k] : 0);
  return (
    (n("inputTokens") * prices.priceInputPerM +
      n("cacheReadTokens") * prices.priceCachedPerM +
      n("cacheWriteTokens") * (prices.priceCacheWritePerM ?? prices.priceInputPerM) +
      n("outputTokens") * (prices.priceOutputPerM ?? 0)) /
    1e6
  );
}

/** Tokens a tool result added to the context, from the session's own tool/result event. */
function resultTokensInSession(events, callId) {
  for (const e of events) {
    if (e?.type !== "tool/result" || e.data?.message?.toolCallId !== callId) continue;
    const c = e.data?.message?.content;
    const text = Array.isArray(c) ? c.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n") : typeof c === "string" ? c : "";
    return Math.ceil(text.length / 4);
  }
  return undefined;
}

// Used when no re-read request in the period has measured usage: a typical agent request re-sends about
// 100k cached tokens and writes a few hundred.
const FALLBACK_REQUEST = { inputTokens: 0, cacheReadTokens: 100000, cacheWriteTokens: 1000, outputTokens: 300 };

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
 *
 * Saving of a cut: the tokens it kept out, paid once uncached, then re-sent cached on every later model
 * request until a compaction.
 *
 * Re-read cost of a cut the agent reopened (a later call names its saved full result). Without the filter
 * neither part happens:
 *  - the extra model request that issued the re-read, priced from the usage DSH recorded for it (split
 *    evenly when that request made several calls), and
 *  - the re-read result itself, paid once uncached and re-sent cached on every request after it.
 *
 * Net saving = saving − Jev cost (every run) − re-read cost. Where a session cannot be read or a request has
 * no usage, the averages of the measured cases stand in, and the estimate counts say how often.
 */
export function computeStats(
  events,
  { days, priceInputPerM, priceCachedPerM, priceCacheWritePerM, priceOutputPerM, sessionEvents, now = Date.now() },
) {
  const prices = { priceInputPerM, priceCachedPerM, priceCacheWritePerM, priceOutputPerM };
  const since = now - days * 86400000;
  const evs = events.filter((e) => (e.at ?? 0) >= since);
  const seen = evs.filter((e) => e.kind === "result");
  const filtered = seen.filter((e) => e.action === "filtered");
  // Results only cleaned of page clutter save tokens too, and can be reopened like a cut.
  const decluttered = seen.filter((e) => e.action === "decluttered");
  const cutLike = [...filtered, ...decluttered];
  const isCut = (e) => e.action === "filtered" || e.action === "decluttered";
  const shadow = seen.filter((e) => e.action === "shadow");
  const judgedRuns = [...filtered, ...shadow, ...decluttered.filter((e) => e.jev)];
  const actions = {};
  for (const e of seen) actions[e.action] = (actions[e.action] ?? 0) + 1;
  const declutterApplied = seen.filter((e) => e.declutter?.applied);
  const declutterShadow = seen.filter((e) => e.declutter && !e.declutter.applied);
  const declutterSaved = (list) => list.reduce((a, e) => a + Math.max(0, e.declutter.tokensBefore - e.declutter.tokensAfter), 0);

  const allTokens = seen.reduce((a, e) => a + (e.tokensBefore ?? 0), 0);
  const savedOnce = cutLike.reduce((a, e) => a + Math.max(0, e.tokensBefore - e.tokensAfter), 0);
  const shadowWouldSave = shadow.reduce((a, e) => a + Math.max(0, e.tokensBefore - e.tokensAfter), 0);
  // Every Jev call costs, including runs that ended up passing the result through.
  const jevCost = seen.reduce((a, e) => a + (e.jev?.costUsd ?? 0), 0);
  const jevIn = judgedRuns.reduce((a, e) => a + (e.jev?.inputTokens ?? 0), 0);
  const jevOut = judgedRuns.reduce((a, e) => a + (e.jev?.outputTokens ?? 0), 0);
  const delays = judgedRuns.map((e) => e.ms ?? 0);

  // Follow-ups count only for cuts in this period, once per follow-up call.
  const filteredIds = new Set(cutLike.map((e) => e.callId));
  const followupsOf = new Map();
  const followupCallIds = new Set();
  for (const f of evs) {
    if (f.kind !== "followup" || !filteredIds.has(f.ofCallId) || followupCallIds.has(f.callId)) continue;
    followupCallIds.add(f.callId);
    if (!followupsOf.has(f.ofCallId)) followupsOf.set(f.ofCallId, []);
    followupsOf.get(f.ofCallId).push(f);
  }
  const resultOf = new Map();
  for (const e of seen) if (e.callId) resultOf.set(e.callId, e);

  const sessions = new Map();
  const sessionOf = (sid) => {
    if (!sessions.has(sid)) sessions.set(sid, (sessionEvents && sid ? sessionEvents(sid) : undefined) ?? null);
    return sessions.get(sid);
  };

  // Pass 1: what the sessions record.
  const cuts = cutLike.map((e) => {
    const s = sessionOf(e.sid);
    const later = s ? laterRequests(s, e.callId) : undefined;
    const reads = (followupsOf.get(e.callId) ?? []).map((f) => {
      const r = resultOf.get(f.callId);
      let tokens = r ? (isCut(r) ? r.tokensAfter : r.tokensBefore) : undefined;
      if (tokens === undefined && s) tokens = resultTokensInSession(s, f.callId);
      const after = s ? laterRequests(s, f.callId) : undefined;
      const req = s ? callingRequest(s, f.callId) : undefined;
      const requestUsd = req?.usage ? requestCostUsd(req.usage, prices) / Math.max(1, req.calls) : undefined;
      return { tokens, later: after?.requests, requestUsd };
    });
    return { e, later, reads };
  });
  const mean = (xs) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
  const avgLater = mean(cuts.filter((c) => c.later).map((c) => c.later.requests)) ?? 0;
  const avgRequestUsd =
    mean(cuts.flatMap((c) => c.reads.map((r) => r.requestUsd)).filter((x) => x !== undefined)) ?? requestCostUsd(FALLBACK_REQUEST, prices);

  // Pass 2: money per cut, filling gaps with the averages.
  let resentAvoided = 0;
  let laterKnown = 0;
  let laterTotal = 0;
  let laterEstimated = 0;
  let compactedAfter = 0;
  const reRead = {
    cuts: 0,
    calls: 0,
    tokens: 0,
    resentTokens: 0,
    requestsUsd: 0,
    tokensUsd: 0,
    costUsd: 0,
    requestsMeasured: 0,
    requestsEstimated: 0,
    laterEstimated: 0,
    savingOfReopenedUsd: 0,
  };
  const perCut = new Map();
  for (const c of cuts) {
    const saved = Math.max(0, c.e.tokensBefore - c.e.tokensAfter);
    let later0;
    if (c.later) {
      later0 = c.later.requests;
      laterKnown++;
      laterTotal += later0;
      if (c.later.compacted) compactedAfter++;
    } else {
      later0 = avgLater;
      if (saved > 0) laterEstimated++;
    }
    // A re-read request would not exist without the filter: it is charged in full below, so it earns no re-send saving.
    const resent = saved * Math.max(0, later0 - c.reads.length);
    resentAvoided += resent;
    const savingUsd = (saved * priceInputPerM + resent * priceCachedPerM) / 1e6;
    let reReadUsd = 0;
    if (c.reads.length > 0) {
      reRead.cuts++;
      reRead.savingOfReopenedUsd += savingUsd;
    }
    for (const r of c.reads) {
      reRead.calls++;
      const tokens = r.tokens ?? c.e.tokensBefore;
      let later1 = r.later;
      if (later1 === undefined) {
        later1 = later0;
        reRead.laterEstimated++;
      }
      let requestUsd = r.requestUsd;
      if (requestUsd === undefined) {
        requestUsd = avgRequestUsd;
        reRead.requestsEstimated++;
      } else reRead.requestsMeasured++;
      const tokensUsd = (tokens * priceInputPerM + tokens * later1 * priceCachedPerM) / 1e6;
      reRead.tokens += tokens;
      reRead.resentTokens += tokens * later1;
      reRead.requestsUsd += requestUsd;
      reRead.tokensUsd += tokensUsd;
      reReadUsd += requestUsd + tokensUsd;
    }
    const jevUsd = c.e.jev?.costUsd ?? 0;
    perCut.set(c.e.callId, { savingUsd, reReadUsd, jevUsd, netUsd: savingUsd - reReadUsd - jevUsd, reReads: c.reads.length });
  }
  reRead.costUsd = reRead.requestsUsd + reRead.tokensUsd;
  for (const k of ["requestsUsd", "tokensUsd", "costUsd", "savingOfReopenedUsd"]) reRead[k] = round(reRead[k], 4);
  reRead.resentTokens = Math.round(reRead.resentTokens);
  resentAvoided = Math.round(resentAvoided);

  const affectedSessions = new Set(cutLike.map((e) => e.sid));
  let compactions = 0;
  for (const sid of affectedSessions) {
    const s = sessionOf(sid);
    if (s) compactions += countCompactions(s);
  }
  const mainModelSaving = [...perCut.values()].reduce((a, c) => a + c.savingUsd, 0);

  // Per tool and per day: saving − re-read − Jev for every run of that tool or day, pass-throughs included.
  const byTool = {};
  const byDay = {};
  for (const e of seen) {
    const t = (byTool[e.tool] ??= { tool: e.tool, results: 0, tokens: 0, filtered: 0, decluttered: 0, saved: 0, followups: 0, reReadUsd: 0, netUsd: 0 });
    t.results++;
    t.tokens += e.tokensBefore ?? 0;
    if (e.declutter?.applied) t.decluttered++;
    const jevUsd = e.jev?.costUsd ?? 0;
    const d = new Date(e.at).toISOString().slice(0, 10);
    const day = (byDay[d] ??= { day: d, filtered: 0, saved: 0, jevCost: 0, reReadUsd: 0, netUsd: 0 });
    day.jevCost += jevUsd;
    const pc = isCut(e) ? perCut.get(e.callId) : undefined;
    t.netUsd += (pc ? pc.savingUsd - pc.reReadUsd : 0) - jevUsd;
    day.netUsd += (pc ? pc.savingUsd - pc.reReadUsd : 0) - jevUsd;
    if (isCut(e)) {
      const saved = Math.max(0, e.tokensBefore - e.tokensAfter);
      if (e.action === "filtered") t.filtered++;
      t.saved += saved;
      if (e.action === "filtered") day.filtered++;
      day.saved += saved;
      if (pc?.reReads) t.followups++;
      t.reReadUsd += pc?.reReadUsd ?? 0;
      day.reReadUsd += pc?.reReadUsd ?? 0;
    }
  }
  for (const t of Object.values(byTool)) (t.reReadUsd = round(t.reReadUsd, 4)), (t.netUsd = round(t.netUsd, 4));
  const days_ = Object.values(byDay).filter((d) => d.filtered > 0 || d.saved > 0 || d.jevCost > 0);
  for (const d of days_) (d.jevCost = round(d.jevCost, 5)), (d.reReadUsd = round(d.reReadUsd, 4)), (d.netUsd = round(d.netUsd, 4));

  const recent = seen
    .filter((e) => ["filtered", "decluttered", "shadow", "jev-error", "no-gain", "mostly-relevant", "nothing-relevant"].includes(e.action))
    .slice(-60)
    .reverse()
    .map((e) => {
      const pc = perCut.get(e.callId);
      return { ...e, followedUp: (pc?.reReads ?? 0) > 0, ...(pc ? { reReads: pc.reReads, savingUsd: round(pc.savingUsd, 5), reReadUsd: round(pc.reReadUsd, 5), netUsd: round(pc.netUsd, 5) } : {}) };
    });

  return {
    days,
    since,
    firstEventAt: events.reduce((m, e) => (typeof e.at === "number" && (m === undefined || e.at < m) ? e.at : m), undefined),
    eventsFile: EVENTS_FILE,
    results: seen.length,
    resultTokens: allTokens,
    actions,
    filtered: filtered.length,
    decluttered: decluttered.length,
    // Clutter removal on its own, whatever happened next (passed on, or cut further by Jev).
    declutter: {
      results: declutterApplied.length,
      savedTokens: declutterSaved(declutterApplied),
      linksDecoded: declutterApplied.reduce((a, e) => a + (e.declutter.linksDecoded ?? 0), 0),
      shadow: declutterShadow.length,
      shadowWouldSave: declutterSaved(declutterShadow),
    },
    shadow: shadow.length,
    tokensBeforeFiltered: filtered.reduce((a, e) => a + e.tokensBefore, 0),
    tokensAfterFiltered: filtered.reduce((a, e) => a + e.tokensAfter, 0),
    savedOnce,
    shadowWouldSave,
    savedShareOfAllToolOutput: allTokens > 0 ? round(savedOnce / allTokens, 4) : 0,
    resentAvoided,
    laterRequests: { known: laterKnown, estimated: laterEstimated, average: laterKnown > 0 ? round(laterTotal / laterKnown, 1) : 0, compactedAfter },
    mainModelSaving: round(mainModelSaving, 4),
    jev: { costUsd: round(jevCost, 5), inputTokens: jevIn, outputTokens: jevOut, runs: judgedRuns.length },
    reRead,
    netSaving: round(mainModelSaving - jevCost - reRead.costUsd, 4),
    delayMs: { average: delays.length ? round(delays.reduce((a, b) => a + b, 0) / delays.length) : 0, p50: percentile(delays, 50), p95: percentile(delays, 95), total: delays.reduce((a, b) => a + b, 0) },
    failures: seen.filter((e) => e.action === "jev-error" || e.passReason === "jev-error").length,
    followups: { cuts: followupsOf.size, calls: followupCallIds.size, rate: cutLike.length > 0 ? round(followupsOf.size / cutLike.length, 3) : 0 },
    sessions: { affected: affectedSessions.size, read: [...sessions.values()].filter(Boolean).length, compactions },
    byTool: Object.values(byTool).sort((a, b) => b.tokens - a.tokens),
    byDay: days_.sort((a, b) => a.day.localeCompare(b.day)),
    recent,
    toolsSeen: [...new Set(seen.map((e) => e.tool))].sort(),
  };
}
