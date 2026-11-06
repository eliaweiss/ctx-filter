import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "ctxf-stats-"));
process.env.CTX_FILTER_HOME = home;
const { compute, report, parseWhen, instructionSectionChars, tok } = await import("../src/stats.ts");
type CallEvent = import("../src/log.ts").CallEvent;

const base = { pid: 1, client: "dsh", ok: true, totalMs: 10 } as const;
const ev = (o: Partial<CallEvent>): CallEvent => ({ ...base, ts: "2026-11-06T16:00:00.000Z", tool: "run", argChars: 0, replyChars: 0, ...o }) as CallEvent;

const opts = { baselineCapTokens: 12_500, sessions: 1, toolSchemaChars: 4000, instructionChars: 1200 };

test("a filtered output saves raw minus reply minus the extra arguments", () => {
  const cmd = "npx playwright test";
  const e = ev({ id: "a1", command: cmd, argChars: cmd.length + 60 + 80, rawChars: 40_000, replyChars: 2_400, filterMs: 900, costUsd: 0.0002 });
  const c = compute([e], opts);
  assert.equal(c.rows[0]!.baselineTok, 10_000);
  assert.equal(c.rows[0]!.replyTok, 600);
  assert.equal(c.rows[0]!.argExtraTok, 20);
  assert.equal(c.grossSaved, 10_000 - 600 - 20);
  assert.equal(c.fixedTok, 1000 + 300);
  assert.equal(c.net, c.grossSaved - 1300);
});

test("the baseline is capped at the host's own limit", () => {
  const c = compute([ev({ id: "b", rawChars: 400_000, replyChars: 2_000 })], opts);
  assert.equal(c.rows[0]!.baselineTok, 12_500);
});

test("follow-ups are charged against the savings and counted per output", () => {
  const evs = [
    ev({ id: "a1", rawChars: 40_000, replyChars: 2_400 }),
    ev({ tool: "grep_output", parentId: "a1", argChars: 40, replyChars: 400 }),
    ev({ tool: "filter", parentId: "a1", id: "a1", argChars: 80, replyChars: 2_000, rawChars: 40_000 }),
  ];
  const c = compute(evs, opts);
  assert.equal(c.rows.length, 1);
  assert.equal(c.follow.length, 2);
  assert.equal(c.rows[0]!.followUps, 2);
  assert.equal(c.followCost, tok(440) + 30 + tok(2080) + 30);
});

test("report names cost, delay and failures", () => {
  const evs = [
    ev({ id: "a1", rawChars: 40_000, replyChars: 2_400, filterMs: 900, judgeMs: 800, execMs: 30_000, costUsd: 0.0002, modelRequests: 1, model: "jev:typesafe-ai/jev-1.14.0", kept: 4, passages: 60, judged: 60 }),
    ev({ id: "a2", rawChars: 9_000, replyChars: 1_000, filterMs: 300, fallback: true, judgeError: "no key" }),
    ev({ tool: "read_output", parentId: "a1", argChars: 50, replyChars: 900, ok: false, error: "no stored output" }),
  ];
  const r = report(evs, opts);
  assert.match(r, /NET CONTEXT SAVED/);
  assert.match(r, /total \$0\.000200/);
  assert.match(r, /model unavailable \(pre-rank used\): 1/);
  assert.match(r, /tool calls failed:\s+1/);
  assert.match(r, /filtered outputs needing a follow-up: 1 of 2/);
});

test("time windows", () => {
  const now = new Date("2026-11-06T16:30:00Z");
  assert.equal(parseWhen("30m", now).toISOString(), "2026-11-06T16:00:00.000Z");
  assert.equal(parseWhen("2026-11-06T10:00:00Z").toISOString(), "2026-11-06T10:00:00.000Z");
  const c = compute([ev({ ts: "2026-11-06T15:00:00Z", rawChars: 9000, replyChars: 100 }), ev({ ts: "2026-11-06T16:10:00Z", rawChars: 9000, replyChars: 100 })], { ...opts, since: parseWhen("30m", now) });
  assert.equal(c.rows.length, 1);
});

test("instruction section size is read from the ctx-filter heading to the next heading", () => {
  const f = join(home, "AGENTS.md");
  writeFileSync(f, "# A\nx\n# Large command output: ctx-filter\nline one\nline two\n# B\ny\n");
  assert.equal(instructionSectionChars(f), "# Large command output: ctx-filter\nline one\nline two".length);
});
