import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWant,
  errorLineIndices,
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
} from "../lib/core.js";
import { computeStats, countCompactions, laterRequests } from "../lib/store.js";

const opts = {
  keepPercent: 30,
  relevanceThreshold: 0.5,
  keepHead: true,
  headChars: 230, // 3 lines of the test log
  keepTail: true,
  tailChars: 230,
  keepErrors: true,
  keepRelevant: true,
};

function log(n) {
  const lines = [];
  for (let i = 0; i < n; i++) lines.push(`step ${i}: processing item ${i} ok ${"x".repeat(40)}`);
  return lines;
}

test("estimateTokens uses 4 characters per token", () => {
  assert.equal(estimateTokens("a".repeat(8000)), 2000);
});

test("passages cover every line once, in order", () => {
  const lines = log(200);
  const ps = makePassages(lines, 600, 15);
  assert.equal(ps[0].start, 0);
  assert.equal(ps.at(-1).end, 199);
  for (let i = 1; i < ps.length; i++) assert.equal(ps[i].start, ps[i - 1].end + 1);
  assert.ok(ps.every((p) => p.end - p.start < 15));
});

test("error lines are found", () => {
  const lines = ["ok", "Error: boom", "fine", "  ✘ checkout test", "FAIL src/a.test.ts", "done"];
  assert.deepEqual(errorLineIndices(lines), [1, 3, 4]);
});

test("file prints and exclusions", () => {
  assert.ok(isFilePrint("cat src/a.ts"));
  assert.ok(isFilePrint("cd app && sed -n '1,200p' file.swift"));
  assert.ok(isFilePrint("git log | head -50"));
  assert.ok(!isFilePrint("npm test"));
  assert.ok(isFilePrint("git diff eeb3cced1^1 eeb3cced1"));
  assert.ok(isFilePrint("M=4dfe5839e; git diff $M^1 $M -- apps"));
  assert.ok(isFilePrint("git add -A; git status --short; git diff --cached -- a.ts"));
  assert.ok(isFilePrint("git -C /repo --no-pager show origin/dev:a.ts"));
  assert.ok(!isFilePrint("git grep -n diff src"));
  assert.ok(!isFilePrint("git log --oneline -20"));
  assert.ok(isExcluded("read", ["read"]));
  assert.ok(isExcluded("mcp__atlassian__getJiraIssue", ["mcp__atlassian__*"]));
  assert.ok(!isExcluded("bash", ["read", "mcp__*"]));
});

test("reads of saved full results are recognized", () => {
  const p = "/var/folders/yb/x/T/dsh-spill-DlsYyz/session-1ad7f0f7889c/579adf91e1ca-workflow-full.txt";
  assert.ok(readsSavedResult(JSON.stringify({ command: `python3 -c "open('${p}')"` })));
  assert.ok(readsSavedResult('{"file_path":"/tmp/full.txt"}', ["/tmp/full.txt"]));
  assert.ok(!readsSavedResult('{"command":"npm test"}', ["/tmp/full.txt"]));
});

test("head and tail are measured in characters", () => {
  const long = Array.from({ length: 40 }, (_, i) => `${i} ${"z".repeat(600)}`);
  const sel = selectLines(long, makePassages(long), new Map(), { ...opts, headChars: 400, tailChars: 800 });
  assert.equal(sel.reasons.head, 0); // a 600-character first line does not fit in 400
  assert.equal(sel.reasons.tail, 1);
  const short = log(100);
  const s2 = selectLines(short, makePassages(short), new Map(), { ...opts, keepErrors: false, headChars: 400, tailChars: 800 });
  const fit = (ls, max) => { let n = 0, size = 0; for (const l of ls) { if (size + l.length + 1 > max) break; size += l.length + 1; n++; } return n; };
  assert.equal(s2.reasons.head, fit(short, 400));
  assert.equal(s2.reasons.tail, fit([...short].reverse(), 800));
  assert.ok(s2.reasons.head >= 5 && s2.reasons.tail >= 10);
});

test("with long lines, relevant passages still fit next to head and tail", () => {
  const long = Array.from({ length: 45 }, (_, i) => `${i} ${"z".repeat(600)}`);
  const ps = makePassages(long);
  const probs = new Map(ps.map((p) => [p.index, p.start >= 10 && p.start < 20 ? 0.9 : 0.1]));
  const sel = selectLines(long, ps, probs, { ...opts, headChars: 400, tailChars: 800 });
  assert.ok(sel.relevantPassages > 0);
});

test("selection keeps head, tail, errors and relevant passages within budget", () => {
  const lines = log(300);
  lines[150] = "Error: connection refused at db.ts:42";
  const ps = makePassages(lines);
  const target = ps.find((p) => p.start <= 200 && p.end >= 200);
  const probs = new Map(ps.map((p) => [p.index, p === target ? 0.9 : 0.1]));
  const sel = selectLines(lines, ps, probs, opts);
  for (const i of [0, 1, 2, 297, 298, 299, 150]) assert.ok(sel.keep.has(i), `line ${i}`);
  for (let i = target.start; i <= target.end; i++) assert.ok(sel.keep.has(i));
  assert.equal(sel.relevantPassages, 1);
  const kept = [...sel.keep].reduce((a, i) => a + lines[i].length + 1, 0);
  assert.ok(kept <= sel.budgetChars);
  const out = renderKept(lines, sel.keep);
  assert.match(out, /lines 4–150 omitted|omitted/);
  assert.ok(out.length < lines.join("\n").length * 0.4);
});

test("toggles turn each rule off", () => {
  const lines = log(100);
  lines[50] = "fatal: not a git repository";
  const sel = selectLines(lines, makePassages(lines), new Map(), { ...opts, keepHead: false, keepTail: false, keepErrors: false });
  assert.equal(sel.keep.size, 0);
});

test("relevant passages that do not fit are counted as overflow", () => {
  const lines = log(200);
  const ps = makePassages(lines);
  const probs = new Map(ps.map((p) => [p.index, 0.9]));
  const sel = selectLines(lines, ps, probs, { ...opts, keepPercent: 10 });
  assert.ok(sel.overflow > 0);
  assert.ok(sel.relevantPassages > 0);
});

test("want includes the selected parts only", () => {
  const events = [
    { type: "user/message", data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "why does checkout fail?" }] } },
    {
      type: "assistant/message",
      data: {
        message: {
          content: [
            { type: "reasoning", text: "need the failing test" },
            { type: "text", text: "Let me run the checkout tests." },
            { type: "tool-call", id: "c1", name: "bash", arguments: "{}" },
          ],
        },
      },
    },
  ];
  const all = { wantToolCall: true, wantDescription: true, wantAgentText: true, wantUserPrompt: true, wantRecentConversation: true, recentConversationTokens: 500 };
  const w = buildWant({ toolName: "bash", args: '{"command":"npm test","description":"Run checkout tests"}', callId: "c1", events }, all);
  assert.deepEqual(w.parts, ["tool call", "description", "agent text", "user prompt", "recent conversation"]);
  assert.match(w.text, /npm test/);
  assert.match(w.text, /Run checkout tests/);
  assert.match(w.text, /need the failing test/);
  assert.match(w.text, /why does checkout fail/);
  const none = buildWant({ toolName: "bash", args: {}, callId: "c1", events }, { ...all, wantToolCall: false, wantDescription: false, wantAgentText: false, wantRecentConversation: false });
  assert.deepEqual(none.parts, ["user prompt"]);
});

test("footer names the path", () => {
  const f = footer({ linesBefore: 300, linesAfter: 40, tokensBefore: 4000, tokensAfter: 900, reasons: { head: 3, tail: 3, errors: 1, relevant: 20 }, relevantPassages: 2, locator: "/tmp/x.txt" });
  assert.match(f, /Kept 40 of 300 lines/);
  assert.match(f, /\/tmp\/x\.txt/);
});

test("later requests stop at compaction", () => {
  const ev = [
    { type: "tool/result", data: { message: { toolCallId: "c1" } } },
    { type: "assistant/message" },
    { type: "assistant/message" },
    { type: "compaction/prune" },
    { type: "assistant/message" },
  ];
  assert.deepEqual(laterRequests(ev, "c1"), { requests: 2, compacted: true });
  assert.equal(countCompactions([...ev, { type: "x" }, { type: "compaction/summary" }, { type: "compaction/applied" }]), 2);
});

test("stats aggregate savings, cost, follow-ups", () => {
  const now = Date.now();
  const events = [
    { at: now, kind: "result", action: "small", tool: "bash", tokensBefore: 100, sid: "s" },
    { at: now, kind: "result", action: "filtered", tool: "bash", callId: "c1", sid: "s", tokensBefore: 4000, tokensAfter: 1000, ms: 900, jev: { costUsd: 0.0004, inputTokens: 9000, outputTokens: 50 } },
    { at: now, kind: "result", action: "jev-error", tool: "grep", tokensBefore: 3000, sid: "s" },
    { at: now, kind: "followup", ofCallId: "c1", sid: "s" },
  ];
  const sev = [{ type: "tool/result", data: { message: { toolCallId: "c1" } } }, { type: "assistant/message" }, { type: "assistant/message" }];
  const s = computeStats(events, { days: 30, priceInputPerM: 5, priceCachedPerM: 0.5, sessionEvents: () => sev, now });
  assert.equal(s.filtered, 1);
  assert.equal(s.savedOnce, 3000);
  // 2 later requests, one of them the re-read request itself, which would not exist without the filter.
  assert.equal(s.resentAvoided, 3000);
  assert.equal(s.mainModelSaving, Math.round(((3000 * 5 + 3000 * 0.5) / 1e6) * 1e4) / 1e4);
  assert.equal(s.failures, 1);
  assert.equal(s.followups.calls, 1);
  assert.equal(s.followups.cuts, 1);
  assert.equal(s.recent.find((e) => e.action === "filtered").followedUp, true);
  assert.equal(s.jev.costUsd, 0.0004);
  assert.equal(s.byTool.find((r) => r.tool === "bash").followups, 1);
});

test("pass-through decisions with the default settings", async () => {
  const { Config } = await import("../index.js");
  const c = Config({});
  const cfg = Object.fromEntries(Object.keys(Config.dict).map((k) => [k, c[k]?.get ? c[k].get() : c[k]]));
  assert.equal(cfg.keepPercent, 90);
  assert.equal(cfg.passThroughRelevantPercent, 45);
  assert.equal(cfg.passThroughWhenRelevantDoesNotFit, true);
  assert.equal(cfg.skipSavedReads, true);
  assert.equal(cfg.priceInputPerM, 4);
  assert.equal(cfg.priceCachedPerM, 0.2);
  const r = (o) => passThroughAction({ judged: 20, judgedRelevant: 4, overflow: 0, tokensKept: 1000, tokensBefore: 4000, ...o }, cfg);
  assert.equal(r({}), null); // 20% relevant, all fits: cut
  assert.equal(r({ judgedRelevant: 0 }), "nothing-relevant");
  assert.equal(r({ judgedRelevant: 9 }), "mostly-relevant"); // 45%
  assert.equal(r({ overflow: 1 }), "relevant-overflow");
  assert.equal(passThroughAction({ judged: 20, judgedRelevant: 4, overflow: 1, tokensKept: 1000, tokensBefore: 4000 }, { ...cfg, passThroughWhenRelevantDoesNotFit: false }), null);
  assert.equal(r({ tokensKept: 3500 }), "no-gain");
});

test("splitLines drops one trailing newline", () => {
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
});
