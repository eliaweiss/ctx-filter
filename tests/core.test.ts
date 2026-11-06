import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const home = mkdtempSync(join(tmpdir(), "ctxf-"));
process.env.CTX_FILTER_HOME = home;
process.env.CTX_FILTER_CONFIG = join(home, "none.json");

const { chunkText } = await import("../src/chunk.ts");
const { prerank } = await import("../src/prerank.ts");
const { filterText, render } = await import("../src/filter.ts");
const { ConfigSchema } = await import("../src/config.ts");
const { batchByTokens } = await import("../src/judge/jev.ts");
type Judge = import("../src/judge/types.ts").Judge;

function playwrightLog(): string {
  const lines: string[] = ["Running 120 tests using 4 workers", ""];
  for (let i = 1; i <= 120; i++) {
    if (i === 77) {
      lines.push(`  ✘  ${i} [chromium] › checkout.spec.ts:42:5 › checkout › pays with card (5.2s)`);
    } else lines.push(`  ✓  ${i} [chromium] › suite${i % 9}.spec.ts:${i}:3 › feature ${i} works as expected (0.${i % 9}s)`);
  }
  lines.push("", "  1) [chromium] › checkout.spec.ts:42:5 › checkout › pays with card", "", "    Error: Timed out 5000ms waiting for expect(locator).toBeVisible()", "    Locator: getByRole('button', { name: 'Pay' })", "");
  lines.push("  1 failed", "  119 passed (48.3s)");
  return lines.join("\n") + "\n";
}

const fakeJudge = (pick: (text: string) => number): Judge => ({
  name: "fake",
  async judge(input) {
    return { probs: new Map(input.passages.map((p) => [p.index, pick(p.text)])), usage: { requests: 1, inputTokens: 100, outputTokens: 1, costUsd: 0.0001 } };
  },
});

test("chunks are line-aligned, cover every line once, and respect the size", () => {
  const text = playwrightLog();
  const chunks = chunkText(text, 600);
  assert.equal(chunks[0]!.startLine, 1);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i]!.startLine, chunks[i - 1]!.endLine + 1);
  assert.ok(chunks.every((c) => c.bytes <= 600));
  assert.equal(chunks.map((c) => c.text).join("\n") + "\n", text);
});

test("a line longer than the target is split, not dropped", () => {
  const long = "x".repeat(2500);
  const chunks = chunkText(`a\n${long}\nb\n`, 1000);
  assert.equal(chunks.map((c) => c.text).join(""), `a${long}b`);
  assert.ok(chunks.every((c) => c.bytes <= 1000));
});

test("pre-rank puts the failure and the summary first", () => {
  const chunks = chunkText(playwrightLog(), 600);
  const order = prerank(chunks, "which tests failed and why");
  const top = order.slice(0, 3).map((i) => chunks[i]!.text).join("\n");
  assert.match(top, /Timed out|1 failed/);
});

test("small output comes back whole, no model call", async () => {
  const cfg = ConfigSchema.parse({});
  let called = false;
  const out = await filterText("hello\n", "anything", cfg, {
    judge: { name: "x", judge: async () => ((called = true), { probs: new Map(), usage: { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 } }) },
  });
  assert.equal(out.whole, true);
  assert.equal(called, false);
});

test("keeps only passages over the threshold, whole and in line order", async () => {
  const cfg = ConfigSchema.parse({ chunkBytes: 400 });
  const text = playwrightLog();
  const out = await filterText(text, "which tests failed and why", cfg, {
    judge: fakeJudge((t) => (/✘|Error:|failed/.test(t) ? 0.95 : 0.05)),
  });
  assert.equal(out.whole, false);
  assert.ok(out.kept.length >= 1);
  assert.ok(out.kept.every((k) => (k.p ?? 0) >= 0.5));
  const idx = out.kept.map((k) => k.chunk.index);
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
  const reply = render(out, text, { id: "abc123", path: "/tmp/x.log", want: "w", bytes: text.length, lines: 130, exitCode: 1, mcpTools: true });
  assert.match(reply, /Timed out 5000ms/);
  assert.match(reply, /── lines \d+-\d+ p=0\.95/);
  assert.match(reply, /\[ctx-filter\] exit 1/);
  assert.ok(!/feature 3 works/.test(reply.split("[ctx-filter]")[0]!));
});

test("nothing over the threshold: one best guess, flagged", async () => {
  const cfg = ConfigSchema.parse({});
  const text = playwrightLog();
  const out = await filterText(text, "the database password", cfg, { judge: fakeJudge((t) => (/Locator/.test(t) ? 0.3 : 0.01)) });
  assert.equal(out.belowThreshold, true);
  assert.equal(out.kept.length, 1);
  assert.match(out.kept[0]!.chunk.text, /Locator/);
});

test("judge failure falls back to the pre-rank and says so", async () => {
  const cfg = ConfigSchema.parse({});
  const out = await filterText(playwrightLog(), "which tests failed", cfg, {
    judge: { name: "broken", judge: async () => Promise.reject(new Error("no key")) },
  });
  assert.ok(out.kept.length > 0);
  assert.ok(out.notes.some((n) => n.includes("model unavailable (no key)")));
});

test("Jev batches stay under the request token budget", () => {
  const chunks = chunkText(playwrightLog().repeat(20), 1200);
  const batches = batchByTokens(chunks, 100, 8000);
  assert.ok(batches.length > 1);
  assert.equal(batches.flat().length, chunks.length);
  for (const b of batches) assert.ok(b.reduce((a, c) => a + Math.ceil(c.bytes / 3) + 120, 100) <= 8000 || b.length === 1);
});

test("hook: small Bash output passes through, large output is replaced in Bash's shape", () => {
  const env = { ...process.env, CTX_FILTER_PROVIDER: "none" };
  const run = (payload: unknown) =>
    spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(import.meta.dirname, "..", "src", "hook.ts")], {
      input: JSON.stringify(payload),
      env,
      encoding: "utf8",
    });
  const small = run({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "echo hi" }, tool_response: { stdout: "hi\n", stderr: "", interrupted: false } });
  assert.equal(small.status, 0);
  assert.equal(small.stdout, "");

  const persisted = join(home, "persisted.txt");
  writeFileSync(persisted, playwrightLog());
  const big = run({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "npx playwright test", description: "Run e2e tests; which failed and why" },
    tool_response: { stdout: "head only", stderr: "", interrupted: false, persistedOutputPath: persisted, persistedOutputSize: 9999 },
  });
  assert.equal(big.status, 0, big.stderr);
  const out = JSON.parse(big.stdout);
  const upd = out.hookSpecificOutput.updatedToolOutput;
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.equal(upd.stderr, "");
  assert.equal(upd.interrupted, false);
  assert.equal(upd.persistedOutputPath, undefined);
  assert.match(upd.stdout, /\[ctx-filter\]/);
  assert.match(upd.stdout, /full output: .*\.log/);
  const events = readFileSync(join(home, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const last = events.at(-1);
  assert.equal(last.tool, "hook:Bash");
  assert.equal(last.ok, true);
  assert.equal(last.rawChars, playwrightLog().length);
  assert.equal(last.replyChars, upd.stdout.length);
  assert.equal(last.want, "Run e2e tests; which failed and why");
});

test("hook: garbage input never fails the tool call", () => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", join(import.meta.dirname, "..", "src", "hook.ts")], { input: "not json", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
