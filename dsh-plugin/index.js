// Context filter for DeepSeek Harness, Host half.
// On tools/post-execute, a web_fetch result is first decluttered by rules (redirect links decoded, favicons
// and repeated links removed). Then a text result between `minTokens` and `maxTokens` is cut down to its
// head, tail, error lines and the passages Jev judges relevant to the agent's current step. The full result
// goes to DSH's spill store and a footer names its path. Any failure passes the original result through.
import z from "@deepseek-ai/schemastery";
import {
  buildWant,
  estimateTokens,
  footer,
  isExcluded,
  isFilePrint,
  makePassages,
  passThroughAction,
  readsSavedResult,
  renderKept,
  selectLines,
  splitLines,
} from "./lib/core.js";
import { declutter, declutterNote } from "./lib/declutter.js";
import { judgePassages } from "./lib/jev.js";
import { readSessionEventsFromDisk } from "./lib/sessions.js";
import { appendEvent, computeStats, EVENTS_FILE, readEvents, resetEvents } from "./lib/store.js";

export const name = "ctx-filter";
export const inject = [];

const bool = (d, desc) => z.boolean().default(d).description(desc).volatile();
const int = (d, min, desc) => z.number().step(1).min(min).default(d).description(desc).volatile();

export const Config = z.object({
  enabled: bool(true, "Filter tool results."),
  shadowMode: bool(false, "Judge and log what would be cut, but pass every result through unchanged."),
  declutter: bool(true, "Clean web pages of clutter first, at any size: decode search redirect links, drop favicons, empty and repeated links. Text is never removed."),
  declutterTools: z.array(z.string()).default(["web_fetch"]).description("Tools whose results are decluttered. An entry ending in * matches a prefix.").volatile(),
  declutterMinPercent: z.number().min(0).max(100).default(10).description("Use the cleaned result only when it is at least this much smaller, in percent.").volatile(),
  minTokens: int(2000, 0, "Results at or below this many tokens pass through untouched."),
  maxTokens: int(12500, 0, "Results above this many tokens are left to DSH's own spill cap."),
  keepPercent: z.number().min(1).max(100).default(90).description("Most of the result kept, in percent.").volatile(),
  passThroughRelevantPercent: z.number().min(1).max(100).default(45).description("When Jev judges at least this share of the passages relevant, the result is mostly signal and passes through whole (100: never).").volatile(),
  passThroughWhenNothingRelevant: bool(true, "When Jev judges no passage relevant, the want probably missed; pass the result through whole instead of keeping only head, tail and errors."),
  passThroughWhenRelevantDoesNotFit: bool(true, "When a passage Jev judges relevant does not fit in the budget, the cut would drop wanted content; pass the result through whole."),
  relevanceThreshold: z.number().min(0).max(1).default(0.5).description("A passage is relevant when Jev's probability is at least this.").volatile(),
  excludedTools: z.array(z.string()).default(["read", "skill", "plugin_manager", "grep", "glob"]).description("Tools whose results are never filtered. An entry ending in * matches a prefix.").volatile(),
  skipFilePrints: bool(true, "Do not filter bash commands that print files or diffs (cat, sed -n, head, tail, git diff, git show)."),
  skipSavedReads: bool(true, "Do not filter a call whose arguments name a saved full result (DSH's spill folder)."),
  wantToolCall: bool(true, "Want: the tool call and its arguments."),
  wantDescription: bool(true, "Want: the call's description field."),
  wantAgentText: bool(true, "Want: what the agent wrote and reasoned just before the call."),
  wantUserPrompt: bool(true, "Want: the user's latest request."),
  wantRecentConversation: bool(true, "Want: the recent conversation."),
  recentConversationTokens: int(2000, 0, "How much recent conversation goes into the want, in tokens."),
  keepHead: bool(true, "Always keep the first lines."),
  headChars: int(400, 0, "Head kept, in characters (whole lines up to this size)."),
  keepTail: bool(true, "Always keep the last lines."),
  tailChars: int(800, 0, "Tail kept, in characters (whole lines up to this size)."),
  keepErrors: bool(true, "Always keep error and failure lines."),
  keepRelevant: bool(true, "Keep the passages Jev judges relevant."),
  saveFullOutput: bool(true, "Save the full result to DSH's spill store."),
  addFooter: bool(true, "Add a footer saying what was kept and where the full result is."),
  logWant: bool(true, "Store the want in the statistics log."),
  model: z.string().default("typesafe-ai/jev-1.14.0").description("Gateway decision model.").volatile(),
  apiKeyEnv: z.string().default("AI_GATEWAY_API_KEY").description("Environment variable holding the gateway key.").volatile(),
  apiKeyCommand: z.string().default("").description("Command that prints the key when the variable is unset (empty: use ~/.ctx-filter/config.json).").volatile(),
  timeoutMs: int(8000, 500, "Time limit for Jev; past it the result passes through."),
  priceInputPerM: z.number().min(0).default(4).description("Main model price per million uncached input tokens, USD, for savings estimates.").volatile(),
  priceCachedPerM: z.number().min(0).default(0.2).description("Main model price per million cached input tokens, USD, for savings estimates.").volatile(),
  priceCacheWritePerM: z.number().min(0).default(5).description("Main model price per million cache-write tokens, USD, for the cost of re-read requests.").volatile(),
  priceOutputPerM: z.number().min(0).default(20).description("Main model price per million output tokens, USD, for the cost of re-read requests.").volatile(),
});

const KEYS = Object.keys(Config.dict);
const SPILL_NOTICE = /Full formatted result stored at:|\[output truncated; full output:|\[context filter/;

function snapshot(config) {
  const out = {};
  for (const k of KEYS) {
    const v = config?.[k];
    out[k] = v && typeof v.get === "function" ? v.get() : v;
  }
  return out;
}

/**
 * Recent committed events of a live Session. `snapshotEvents(from, to)` is DSH's synchronous read (marked
 * deprecated upstream in favour of projections, still supported); older shapes expose `log` or `events`.
 */
export function sessionEvents(session, window = 600) {
  if (!session) return [];
  try {
    if (typeof session.snapshotEvents === "function") {
      const end = typeof session.seq === "number" ? session.seq : undefined;
      return end === undefined ? session.snapshotEvents() : session.snapshotEvents(Math.max(0, end - window), end);
    }
  } catch {
    // fall through
  }
  const all = Array.isArray(session.log) ? session.log : Array.isArray(session.events) ? session.events : [];
  return window === Infinity ? all : all.slice(-window);
}

function argsText(raw) {
  try {
    return typeof raw === "string" ? raw : JSON.stringify(raw ?? {});
  } catch {
    return "";
  }
}

function parseArgs(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function apply(ctx, config) {
  const locators = new Map(); // spill locator -> { callId, sid }
  for (const e of readEvents(Date.now() - 30 * 86400000)) if (e.locator) locators.set(e.locator, { callId: e.callId, sid: e.sid });

  const log = (event) => {
    try {
      appendEvent({ at: Date.now(), ...event });
    } catch (e) {
      ctx.logger.warn(`ctx-filter: cannot write ${EVENTS_FILE}: ${String(e)}`);
    }
  };

  ctx.on(
    "tools/post-execute",
    async (exec, result, next) => {
      const decision = await next();
      try {
        return await filterDecision(ctx, snapshot(config), exec, result, decision, log, locators);
      } catch (e) {
        ctx.logger.warn(`ctx-filter: ${exec.name}: ${String(e)}; result passed through`);
        return decision;
      }
    },
    { prepend: true },
  );

  // A later call that reads a saved full result means the cut dropped something the agent wanted.
  ctx.on("tools/result", (exec) => {
    if (locators.size === 0) return;
    const args = argsText(exec.arguments);
    if (!args) return;
    for (const [loc, of] of locators) {
      if (args.includes(loc)) {
        log({ kind: "followup", sid: exec.agent?.session?.header?.id, tool: exec.name, callId: exec.callId, ofCallId: of.callId, locator: loc });
        break;
      }
    }
  });

  ctx.inject(["webServer"], (sub) => {
    const ws = sub.webServer;
    const handler = async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://localhost");
        const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days")) || 30));
        const cfg = snapshot(config);
        const events = readEvents(Date.now() - days * 86400000);
        const sids = new Set(events.filter((e) => e.action === "filtered" && e.sid).map((e) => e.sid));
        const sessionMap = new Map();
        const svc = ctx.get("sessions");
        for (const sid of sids) sessionMap.set(sid, (await sessionEventsOf(svc, sid)) ?? readSessionEventsFromDisk(sid));
        const stats = computeStats(events, {
          days,
          priceInputPerM: cfg.priceInputPerM,
          priceCachedPerM: cfg.priceCachedPerM,
          priceCacheWritePerM: cfg.priceCacheWritePerM,
          priceOutputPerM: cfg.priceOutputPerM,
          sessionEvents: (sid) => sessionMap.get(sid),
        });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(stats));
      } catch (e) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(String(e?.stack ?? e));
      }
    };
    sub.effect(() => ws.register({ kind: "exact", path: "/ctx-filter/api/stats", handler }));

    // Reset: POST with the x-ctx-filter header (a custom header, so another site cannot send it without a
    // preflight). The log is moved aside, not deleted; saved full results stay tracked for follow-ups.
    const reset = (req, res) => {
      if (req.method !== "POST" || req.headers["x-ctx-filter"] !== "reset") {
        res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
        res.end("POST with header x-ctx-filter: reset");
        return;
      }
      try {
        const archive = resetEvents();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: true, archive: archive ?? null }));
      } catch (e) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(String(e?.stack ?? e));
      }
    };
    sub.effect(() => ws.register({ kind: "exact", path: "/ctx-filter/api/stats/reset", handler: reset }));
  });
}

async function sessionEventsOf(svc, sid) {
  if (!svc) return undefined;
  try {
    let s = typeof svc.get === "function" ? await svc.get(sid) : undefined;
    if (!s && typeof svc.list === "function") {
      const list = await svc.list();
      s = (list ?? []).find((x) => (x?.id ?? x?.header?.id) === sid);
    }
    const ev = sessionEvents(s, Infinity);
    return ev.length > 0 ? ev : undefined;
  } catch {
    return undefined;
  }
}

async function filterDecision(ctx, cfg, exec, result, decision, log, locators) {
  if (!cfg.enabled) return decision;
  if (decision?.kind !== "accept" || Object.hasOwn(decision, "value") || result?.isError) return decision;
  const content = decision.content ?? result.content;
  if (!Array.isArray(content) || content.length === 0) return decision;
  const sid = exec.agent?.session?.header?.id;
  const base = { kind: "result", sid, tool: exec.name, callId: exec.callId };
  if (content.some((b) => b?.type !== "text")) {
    log({ ...base, action: "non-text", tokensBefore: 0 });
    return decision;
  }
  const original = content.map((b) => b.text).join("\n");
  // tokensBefore is what the tool produced; tokensIn is what the rest of the pipeline works on.
  const tokensBefore = estimateTokens(original);
  const save = async (label, suggestedName, text) => {
    if (!cfg.saveFullOutput || !sid) return undefined;
    try {
      const ref = await ctx.get("spillStore")?.saveText({
        owner: { sessionId: sid },
        source: { toolName: exec.name, callId: exec.callId, label },
        suggestedName,
        content: text,
      });
      return ref?.locator;
    } catch (e) {
      ctx.logger.warn(`ctx-filter: could not save the full result: ${String(e)}`);
      return undefined;
    }
  };

  // Step 1: declutter by rules. In shadow mode the saving is only logged.
  let text = original;
  let cleaned = false;
  if (cfg.declutter && isExcluded(exec.name, cfg.declutterTools)) {
    const r = declutter(original);
    const after = estimateTokens(r.text);
    if (r.changed && after < tokensBefore && (tokensBefore - after) * 100 >= tokensBefore * cfg.declutterMinPercent) {
      base.declutter = { tokensBefore, tokensAfter: after, applied: !cfg.shadowMode, ...r.stats };
      if (!cfg.shadowMode) {
        text = r.text;
        cleaned = true;
        const loc = await save("context-filter-original-page", `${exec.name}-original.txt`, original);
        if (loc) {
          base.declutter.locator = loc;
          locators.set(loc, { callId: exec.callId, sid });
        }
      }
    }
  }
  const tokensIn = estimateTokens(text);
  // A result that is not cut goes on as it came, or cleaned with a one-line note.
  const passOn = (event) => {
    if (!cleaned) {
      log(event);
      return decision;
    }
    const out = text + (cfg.addFooter ? declutterNote(base.declutter) : "");
    log({ ...event, action: "decluttered", passReason: event.action, tokensAfter: estimateTokens(out) });
    return accepted(decision, out);
  };
  const skip = (action) => passOn({ ...base, action, tokensBefore });
  if (tokensIn <= cfg.minTokens) return skip("small");
  if (tokensIn > cfg.maxTokens || SPILL_NOTICE.test(text)) return skip("over-cap");
  if (isExcluded(exec.name, cfg.excludedTools)) return skip("excluded");
  const args = parseArgs(exec.arguments);
  if (cfg.skipSavedReads && readsSavedResult(argsText(exec.arguments), locators.keys())) return skip("saved-read");
  if (cfg.skipFilePrints && exec.name === "bash" && isFilePrint(args.command)) return skip("file-print");
  if (!exec.agent?.session) return skip("no-session");

  const t0 = Date.now();
  const lines = splitLines(text);
  const passages = makePassages(lines);
  const want = buildWant({ toolName: exec.name, args, callId: exec.callId, events: sessionEvents(exec.agent.session) }, cfg);
  let probs = new Map();
  let jev;
  if (cfg.keepRelevant) {
    try {
      const r = await judgePassages({ want: want.text, source: exec.name, passages, cfg, signal: exec.signal });
      probs = r.probs;
      jev = { ...r.usage, partial: r.partial, judged: r.probs.size, of: passages.length };
    } catch (e) {
      // Fail open: the result goes on whole (cleaned, when it was).
      return passOn({ ...base, action: "jev-error", tokensBefore, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 300) });
    }
  }
  const judgedRelevant = [...probs.values()].filter((p) => p >= cfg.relevanceThreshold).length;
  const relevantShare = probs.size > 0 ? judgedRelevant / probs.size : 0;
  const sel = selectLines(lines, passages, probs, cfg);
  let kept = renderKept(lines, sel.keep);
  const tokensKept = estimateTokens(kept);
  const ms = Date.now() - t0;
  const detail = {
    ...base,
    tokensBefore,
    linesBefore: lines.length,
    linesAfter: sel.keep.size,
    passages: passages.length,
    relevantPassages: sel.relevantPassages,
    overflow: sel.overflow,
    reasons: sel.reasons,
    ms,
    jev,
    judgedRelevant,
    relevantShare: Math.round(relevantShare * 1000) / 1000,
    maxProbability: probs.size > 0 ? Math.round(Math.max(...probs.values()) * 1000) / 1000 : undefined,
    want: cfg.logWant ? want.text : undefined,
    wantParts: want.parts,
  };
  const whole = passThroughAction({ judged: probs.size, judgedRelevant, overflow: sel.overflow, tokensKept, tokensBefore: tokensIn }, cfg);
  if (whole) return passOn({ ...detail, action: whole, tokensAfter: tokensBefore });
  if (cfg.shadowMode) {
    log({ ...detail, action: "shadow", tokensAfter: tokensKept });
    return decision;
  }
  // The saved full result is the text the cut was made from (cleaned, when it was), so line numbers match.
  const locator = await save("context-filter-original", `${exec.name}-full.txt`, text);
  if (cfg.addFooter) {
    kept += footer({
      linesBefore: lines.length,
      linesAfter: sel.keep.size,
      tokensBefore: tokensIn,
      tokensAfter: tokensKept,
      reasons: sel.reasons,
      relevantPassages: sel.relevantPassages,
      locator,
      originalLocator: base.declutter?.locator,
    });
  }
  const tokensAfter = estimateTokens(kept);
  if (locator) locators.set(locator, { callId: exec.callId, sid });
  log({ ...detail, action: "filtered", tokensAfter, locator });
  return accepted(decision, kept);
}

function accepted(decision, text) {
  return {
    kind: "accept",
    content: [{ type: "text", text }],
    ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}),
  };
}
