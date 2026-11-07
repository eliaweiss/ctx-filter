// The post-execute path end to end, with a fake ctx and Jev reached through a stubbed decide().
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "cfx-"));
process.env.CTX_FILTER_DSH_EVENTS = join(dir, "events.jsonl");
const { apply, Config } = await import("../index.js");

function fakeCtx() {
  const listeners = {};
  const saved = [];
  const ctx = {
    logger: { warn: () => {} },
    on: (name, fn) => ((listeners[name] ??= []).push(fn), () => {}),
    inject: () => {},
    get: (name) => (name === "spillStore" ? { saveText: async (r) => (saved.push(r), { locator: join(dir, "full.txt") }) } : undefined),
  };
  return { ctx, listeners, saved };
}

function bigOutput() {
  const lines = [];
  for (let i = 0; i < 400; i++) lines.push(`ok ${i} ${"y".repeat(50)}`);
  lines[200] = "Error: payment declined at checkout.ts:88";
  return lines.join("\n");
}

const exec = (args) => ({
  name: "bash",
  callId: "c1",
  arguments: JSON.stringify(args),
  agent: { session: { header: { id: "s1" }, events: [] } },
});

test("small results and excluded tools pass through", async () => {
  const { ctx, listeners } = fakeCtx();
  apply(ctx, Config({ keepRelevant: false }));
  const post = listeners["tools/post-execute"][0];
  const small = { content: [{ type: "text", text: "hello" }] };
  const d = await post(exec({ command: "echo" }), small, async () => ({ kind: "accept" }));
  assert.deepEqual(d, { kind: "accept" });
  const big = { content: [{ type: "text", text: bigOutput() }] };
  const r = await post({ ...exec({}), name: "read" }, big, async () => ({ kind: "accept" }));
  assert.deepEqual(r, { kind: "accept" });
  const fp = await post(exec({ command: "cat src/x.ts" }), big, async () => ({ kind: "accept" }));
  assert.deepEqual(fp, { kind: "accept" });
});

test("a mid-size result is cut, saved and footed (rules only, no Jev)", async () => {
  const { ctx, listeners, saved } = fakeCtx();
  apply(ctx, Config({ keepRelevant: false }));
  const post = listeners["tools/post-execute"][0];
  const text = bigOutput();
  const d = await post(exec({ command: "npm test" }), { content: [{ type: "text", text }] }, async () => ({ kind: "accept" }));
  assert.equal(d.kind, "accept");
  const out = d.content[0].text;
  assert.ok(out.length < text.length * 0.4);
  assert.match(out, /payment declined/);
  assert.match(out, /\[context filter\] Kept/);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].content, text);
  const log = readFileSync(process.env.CTX_FILTER_DSH_EVENTS, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(log.some((e) => e.action === "filtered" && e.tokensAfter < e.tokensBefore));
});

test("shadow mode logs but passes through", async () => {
  const { ctx, listeners } = fakeCtx();
  apply(ctx, Config({ keepRelevant: false, shadowMode: true }));
  const post = listeners["tools/post-execute"][0];
  const d = await post(exec({ command: "npm test" }), { content: [{ type: "text", text: bigOutput() }] }, async () => ({ kind: "accept" }));
  assert.deepEqual(d, { kind: "accept" });
});

test("a Jev failure passes the result through", async () => {
  const { ctx, listeners } = fakeCtx();
  apply(ctx, Config({ apiKeyEnv: "CFX_NO_SUCH_KEY", apiKeyCommand: "true" }));
  const post = listeners["tools/post-execute"][0];
  const d = await post(exec({ command: "npm test" }), { content: [{ type: "text", text: bigOutput() }] }, async () => ({ kind: "accept" }));
  assert.deepEqual(d, { kind: "accept" });
});

test("a follow-up read of the saved path is logged", async () => {
  const { ctx, listeners } = fakeCtx();
  apply(ctx, Config({ keepRelevant: false }));
  await listeners["tools/post-execute"][0](exec({ command: "npm test" }), { content: [{ type: "text", text: bigOutput() }] }, async () => ({ kind: "accept" }));
  listeners["tools/result"][0]({ name: "read", callId: "c2", arguments: JSON.stringify({ file_path: join(dir, "full.txt") }), agent: { session: { header: { id: "s1" } } } });
  const log = readFileSync(process.env.CTX_FILTER_DSH_EVENTS, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(log.some((e) => e.kind === "followup" && e.ofCallId === "c1"));
});

test("want reads a live Session through snapshotEvents", async () => {
  const { sessionEvents } = await import("../index.js");
  const log = [
    { type: "user/message", data: { role: "user", source: { kind: "user" }, content: [{ type: "text", text: "why does checkout fail?" }] } },
    { type: "assistant/message", data: { message: { content: [{ type: "text", text: "Running the tests." }, { type: "tool-call", id: "c9" }] } } },
  ];
  const session = { header: { id: "s" }, get seq() { return log.length; }, snapshotEvents: (a = 0, b = log.length) => log.slice(a, b) };
  assert.equal(sessionEvents(session).length, 2);
  const { buildWant } = await import("../lib/core.js");
  const w = buildWant({ toolName: "bash", args: {}, callId: "c9", events: sessionEvents(session) }, { wantToolCall: true, wantDescription: true, wantAgentText: true, wantUserPrompt: true, wantRecentConversation: true, recentConversationTokens: 200 });
  assert.deepEqual(w.parts, ["tool call", "agent text", "user prompt", "recent conversation"]);
});
