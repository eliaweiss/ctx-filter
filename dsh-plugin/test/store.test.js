// Statistics: re-read cost and net saving, reset, and reading session files from disk.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";
import { decodeZstdFrames, readSessionEventsFromDisk } from "../lib/sessions.js";
import { appendEvent, callingRequest, computeStats, requestCostUsd, resetEvents } from "../lib/store.js";

const prices = { priceInputPerM: 4, priceCachedPerM: 0.2, priceCacheWritePerM: 5, priceOutputPerM: 20 };
const usd = (n) => Math.round(n * 1e4) / 1e4;

// Session: cut c1 (reopened by r1), then cut c2 (never reopened).
const usage = { inputTokens: 2, cacheReadTokens: 100000, cacheWriteTokens: 4000, outputTokens: 500 };
const sev = [
  { type: "assistant/message", data: { message: { content: [{ type: "tool-call", id: "c1" }] }, usage: { ...usage } } },
  { type: "tool/result", data: { message: { toolCallId: "c1" } } },
  { type: "assistant/message", data: { message: { content: [{ type: "text", text: "need the rest" }, { type: "tool-call", id: "r1" }] }, usage } },
  { type: "tool/result", data: { message: { toolCallId: "r1", content: [{ type: "text", text: "x".repeat(16000) }] } } },
  { type: "assistant/message", data: { message: { content: [{ type: "tool-call", id: "c2" }] } } },
  { type: "tool/result", data: { message: { toolCallId: "c2" } } },
  { type: "assistant/message", data: { message: { content: [] } } },
  { type: "assistant/message", data: { message: { content: [] } } },
];

function events(now) {
  return [
    { at: now, kind: "result", action: "filtered", tool: "bash", callId: "c1", sid: "s", tokensBefore: 5000, tokensAfter: 1000, jev: { costUsd: 0.001 } },
    { at: now, kind: "result", action: "excluded", tool: "read", callId: "r1", sid: "s", tokensBefore: 4000 },
    { at: now, kind: "followup", tool: "read", callId: "r1", ofCallId: "c1", sid: "s" },
    { at: now, kind: "result", action: "filtered", tool: "bash", callId: "c2", sid: "s", tokensBefore: 3000, tokensAfter: 1000, jev: { costUsd: 0.001 } },
    { at: now, kind: "result", action: "mostly-relevant", tool: "bash", callId: "c3", sid: "s", tokensBefore: 3000, tokensAfter: 3000, jev: { costUsd: 0.0005 } },
  ];
}

test("request cost from recorded usage", () => {
  assert.equal(requestCostUsd(usage, prices), (2 * 4 + 100000 * 0.2 + 4000 * 5 + 500 * 20) / 1e6);
  assert.equal(requestCostUsd(undefined, prices), undefined);
  assert.deepEqual(callingRequest(sev, "r1"), { usage, calls: 1 });
});

test("re-read cost: the extra request plus the re-read tokens, net subtracts it", () => {
  const now = Date.now();
  const s = computeStats(events(now), { days: 30, ...prices, sessionEvents: () => sev, now });
  // c1: 4 later requests, one is the re-read request → 3 re-sends of the 4,000 kept out.
  const saving1 = (4000 * 4 + 4000 * 3 * 0.2) / 1e6;
  // c2: 2 later requests.
  const saving2 = (2000 * 4 + 2000 * 2 * 0.2) / 1e6;
  // r1: request measured; 4,000 tokens read, re-sent on the 3 requests after it.
  const request = requestCostUsd(usage, prices);
  const tokens = (4000 * 4 + 4000 * 3 * 0.2) / 1e6;
  assert.equal(s.reRead.cuts, 1);
  assert.equal(s.reRead.calls, 1);
  assert.equal(s.reRead.tokens, 4000);
  assert.equal(s.reRead.resentTokens, 12000);
  assert.equal(s.reRead.requestsMeasured, 1);
  assert.equal(s.reRead.requestsEstimated, 0);
  assert.equal(s.reRead.requestsUsd, usd(request));
  assert.equal(s.reRead.costUsd, usd(request + tokens));
  assert.equal(s.reRead.savingOfReopenedUsd, usd(saving1));
  assert.equal(s.mainModelSaving, usd(saving1 + saving2));
  assert.equal(s.netSaving, usd(saving1 + saving2 - 0.0025 - (request + tokens)));
  const r1 = s.recent.find((e) => e.callId === "c1");
  assert.equal(r1.followedUp, true);
  assert.ok(r1.netUsd < 0);
  assert.ok(s.recent.find((e) => e.callId === "c2").netUsd > 0);
  const bash = s.byTool.find((t) => t.tool === "bash");
  assert.equal(bash.followups, 1);
  assert.equal(bash.netUsd, usd(saving1 + saving2 - 0.0025 - (request + tokens)));
});

test("without session data the re-read is estimated and counted as estimated", () => {
  const now = Date.now();
  const s = computeStats(events(now), { days: 30, ...prices, sessionEvents: () => undefined, now });
  assert.equal(s.reRead.calls, 1);
  assert.equal(s.reRead.requestsEstimated, 1);
  assert.equal(s.reRead.requestsMeasured, 0);
  assert.ok(s.reRead.requestsUsd > 0);
  assert.ok(s.netSaving < s.mainModelSaving);
});

test("cleaned web pages count as savings, reopens of the original page count against them", () => {
  const now = Date.now();
  const dc = (before, after, extra = {}) => ({ tokensBefore: before, tokensAfter: after, applied: true, linksDecoded: 30, ...extra });
  const evs = [
    { at: now, kind: "result", action: "decluttered", passReason: "small", tool: "web_fetch", callId: "w1", sid: "s", tokensBefore: 3000, tokensAfter: 1100, declutter: dc(3000, 1100, { locator: "/t/o1" }) },
    { at: now, kind: "result", action: "filtered", tool: "web_fetch", callId: "w2", sid: "s", tokensBefore: 6000, tokensAfter: 800, declutter: dc(6000, 2400), jev: { costUsd: 0.001 } },
    { at: now, kind: "result", action: "decluttered", passReason: "jev-error", tool: "web_fetch", callId: "w3", sid: "s", tokensBefore: 5000, tokensAfter: 2600, declutter: dc(5000, 2600) },
    { at: now, kind: "result", action: "small", tool: "web_fetch", callId: "w4", sid: "s", tokensBefore: 3000, declutter: { tokensBefore: 3000, tokensAfter: 1000, applied: false } },
    { at: now, kind: "followup", tool: "read", callId: "r1", ofCallId: "w1", sid: "s" },
  ];
  const s = computeStats(evs, { days: 30, ...prices, sessionEvents: () => undefined, now });
  assert.equal(s.filtered, 1);
  assert.equal(s.decluttered, 2);
  assert.equal(s.savedOnce, 1900 + 5200 + 2400);
  assert.deepEqual(s.declutter, { results: 3, savedTokens: 1900 + 3600 + 2400, linksDecoded: 90, shadow: 1, shadowWouldSave: 2000 });
  assert.equal(s.followups.cuts, 1);
  assert.equal(s.reRead.calls, 1);
  assert.equal(s.failures, 1);
  const wf = s.byTool.find((t) => t.tool === "web_fetch");
  assert.equal(wf.decluttered, 3);
  assert.equal(wf.filtered, 1);
  assert.equal(wf.saved, 1900 + 5200 + 2400);
  assert.ok(s.recent.some((e) => e.callId === "w1" && e.followedUp));
});

test("follow-ups of cuts outside the period are ignored", () => {
  const now = Date.now();
  const s = computeStats([{ at: now, kind: "followup", callId: "r9", ofCallId: "old" }], { days: 30, ...prices, now });
  assert.equal(s.followups.calls, 0);
  assert.equal(s.reRead.costUsd, 0);
});

test("reset moves the log aside and the next event starts a new one", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfx-reset-"));
  const file = join(dir, "events.jsonl");
  assert.equal(resetEvents(file), undefined);
  appendEvent({ at: 1, kind: "result" }, file);
  const at = new Date(2026, 10, 8, 8, 30, 5);
  const a1 = resetEvents(file, at);
  assert.equal(a1, join(dir, "events-archive-20261108-083005.jsonl"));
  assert.equal(existsSync(file), false);
  assert.match(readFileSync(a1, "utf8"), /"kind":"result"/);
  appendEvent({ at: 2, kind: "result" }, file);
  assert.equal(resetEvents(file, at), join(dir, "events-archive-20261108-083005-2.jsonl"));
  assert.equal(readdirSync(dir).length, 2);
});

test("session file on disk: every appended zstd frame is decoded", () => {
  const root = mkdtempSync(join(tmpdir(), "cfx-sess-"));
  mkdirSync(join(root, "--ws--", "sid-1"), { recursive: true });
  const lines = sev.map((e) => JSON.stringify(e) + "\n");
  const frames = lines.map((l) => zlib.zstdCompressSync(Buffer.from(l)));
  // A torn last frame (a write in progress) is dropped, not fatal.
  const torn = zlib.zstdCompressSync(Buffer.from('{"type":"x"}\n')).subarray(0, 6);
  writeFileSync(join(root, "--ws--", "sid-1", "session.v4.jsonl.zstd"), Buffer.concat([...frames, torn]));
  assert.equal(decodeZstdFrames(Buffer.concat(frames)).split("\n").filter(Boolean).length, sev.length);
  assert.deepEqual(readSessionEventsFromDisk("sid-1", root), sev);
  assert.equal(readSessionEventsFromDisk("nope", root), undefined);
  assert.equal(readSessionEventsFromDisk("../x", root), undefined);
});
