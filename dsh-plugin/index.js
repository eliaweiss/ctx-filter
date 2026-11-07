// Context filter for DeepSeek Harness, Host half.
// On tools/post-execute, a text result between `minTokens` and `maxTokens` is cut down to its head, tail,
// error lines and the passages Jev judges relevant to the agent's current step. The full result goes to
// DSH's spill store and a footer names its path. Any failure passes the original result through.
import z from "@deepseek-ai/schemastery";
import {
  buildWant,
  estimateTokens,
  footer,
  isExcluded,
  isFilePrint,
  makePassages,
  renderKept,
  selectLines,
  splitLines,
} from "./lib/core.js";
import { judgePassages } from "./lib/jev.js";
import { appendEvent, computeStats, EVENTS_FILE, readEvents } from "./lib/store.js";

export const name = "ctx-filter";
export const inject = [];

const bool = (d, desc) => z.boolean().default(d).description(desc).volatile();
const int = (d, min, desc) => z.number().step(1).min(min).default(d).description(desc).volatile();

export const Config = z.object({
  enabled: bool(true, "Filter tool results."),
  shadowMode: bool(false, "Judge and log what would be cut, but pass every result through unchanged."),
  minTokens: int(2000, 0, "Results at or below this many tokens pass through untouched."),
  maxTokens: int(12500, 0, "Results above this many tokens are left to DSH's own spill cap."),
  keepPercent: z.number().min(1).max(100).default(30).description("Most of the result kept, in percent.").volatile(),
  passThroughRelevantPercent: z.number().min(1).max(100).default(60).description("When Jev judges at least this share of the passages relevant, the result is mostly signal and passes through whole (100: never).").volatile(),
  passThroughWhenNothingRelevant: bool(true, "When Jev judges no passage relevant, the want probably missed; pass the result through whole instead of keeping only head, tail and errors."),
  relevanceThreshold: z.number().min(0).max(1).default(0.5).description("A passage is relevant when Jev's probability is at least this.").volatile(),
  excludedTools: z.array(z.string()).default(["read", "skill", "plugin_manager", "grep", "glob"]).description("Tools whose results are never filtered. An entry ending in * matches a prefix.").volatile(),
  skipFilePrints: bool(true, "Do not filter bash commands that print files (cat, sed -n, head, tail)."),
  wantToolCall: bool(true, "Want: the tool call and its arguments."),
  wantDescription: bool(true, "Want: the call's description field."),
  wantAgentText: bool(true, "Want: what the agent wrote and reasoned just before the call."),
  wantUserPrompt: bool(true, "Want: the user's latest request."),
  wantRecentConversation: bool(true, "Want: the recent conversation."),
  recentConversationTokens: int(2000, 0, "How much recent conversation goes into the want, in tokens."),
  keepHead: bool(true, "Always keep the first lines."),
  headLines: int(5, 0, "Head lines kept."),
  keepTail: bool(true, "Always keep the last lines."),
  tailLines: int(10, 0, "Tail lines kept."),
  keepErrors: bool(true, "Always keep error and failure lines."),
  keepRelevant: bool(true, "Keep the passages Jev judges relevant."),
  saveFullOutput: bool(true, "Save the full result to DSH's spill store."),
  addFooter: bool(true, "Add a footer saying what was kept and where the full result is."),
  logWant: bool(true, "Store the want in the statistics log."),
  model: z.string().default("typesafe-ai/jev-1.14.0").description("Gateway decision model.").volatile(),
  apiKeyEnv: z.string().default("AI_GATEWAY_API_KEY").description("Environment variable holding the gateway key.").volatile(),
  apiKeyCommand: z.string().default("").description("Command that prints the key when the variable is unset (empty: use ~/.ctx-filter/config.json).").volatile(),
  timeoutMs: int(8000, 500, "Time limit for Jev; past it the result passes through."),
  priceInputPerM: z.number().min(0).default(5).description("Main model price per million uncached input tokens, USD, for savings estimates.").volatile(),
  priceCachedPerM: z.number().min(0).default(0.5).description("Main model price per million cached input tokens, USD, for savings estimates.").volatile(),
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
    let args;
    try {
      args = typeof exec.arguments === "string" ? exec.arguments : JSON.stringify(exec.arguments ?? {});
    } catch {
      return;
    }
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
        for (const sid of sids) sessionMap.set(sid, await sessionEventsOf(svc, sid));
        const stats = computeStats(events, {
          days,
          priceInputPerM: cfg.priceInputPerM,
          priceCachedPerM: cfg.priceCachedPerM,
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
  const text = content.map((b) => b.text).join("\n");
  const tokensBefore = estimateTokens(text);
  const skip = (action) => {
    log({ ...base, action, tokensBefore });
    return decision;
  };
  if (tokensBefore <= cfg.minTokens) return skip("small");
  if (tokensBefore > cfg.maxTokens || SPILL_NOTICE.test(text)) return skip("over-cap");
  if (isExcluded(exec.name, cfg.excludedTools)) return skip("excluded");
  const args = parseArgs(exec.arguments);
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
      log({ ...base, action: "jev-error", tokensBefore, ms: Date.now() - t0, error: String(e?.message ?? e).slice(0, 300) });
      return decision; // fail open
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
  if (cfg.keepRelevant && probs.size > 0 && judgedRelevant === 0 && cfg.passThroughWhenNothingRelevant) {
    log({ ...detail, action: "nothing-relevant", tokensAfter: tokensBefore });
    return decision;
  }
  if (cfg.keepRelevant && probs.size > 0 && cfg.passThroughRelevantPercent < 100 && relevantShare * 100 >= cfg.passThroughRelevantPercent) {
    log({ ...detail, action: "mostly-relevant", tokensAfter: tokensBefore });
    return decision;
  }
  if (tokensKept > tokensBefore * 0.8) {
    log({ ...detail, action: "no-gain", tokensAfter: tokensBefore });
    return decision;
  }
  if (cfg.shadowMode) {
    log({ ...detail, action: "shadow", tokensAfter: tokensKept });
    return decision;
  }
  let locator;
  if (cfg.saveFullOutput && sid) {
    const store = ctx.get("spillStore");
    try {
      const ref = await store?.saveText({
        owner: { sessionId: sid },
        source: { toolName: exec.name, callId: exec.callId, label: "context-filter-original" },
        suggestedName: `${exec.name}-full.txt`,
        content: text,
      });
      locator = ref?.locator;
    } catch (e) {
      ctx.logger.warn(`ctx-filter: could not save the full result: ${String(e)}`);
    }
  }
  if (cfg.addFooter) {
    kept += footer({
      linesBefore: lines.length,
      linesAfter: sel.keep.size,
      tokensBefore,
      tokensAfter: tokensKept,
      reasons: sel.reasons,
      relevantPassages: sel.relevantPassages,
      locator,
    });
  }
  const tokensAfter = estimateTokens(kept);
  if (locator) locators.set(locator, { callId: exec.callId, sid });
  log({ ...detail, action: "filtered", tokensAfter, locator });
  return {
    kind: "accept",
    content: [{ type: "text", text: kept }],
    ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}),
  };
}
