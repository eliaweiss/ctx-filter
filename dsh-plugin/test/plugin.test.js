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
  for (const name of ["grep", "glob"]) assert.deepEqual(await post({ ...exec({}), name }, big, async () => ({ kind: "accept" })), { kind: "accept" });
  const fp = await post(exec({ command: "cat src/x.ts" }), big, async () => ({ kind: "accept" }));
  assert.deepEqual(fp, { kind: "accept" });
  const diff = await post(exec({ command: "git diff HEAD~1 HEAD" }), big, async () => ({ kind: "accept" }));
  assert.deepEqual(diff, { kind: "accept" });
});

test("a call that reads a saved full result passes through", async () => {
  const { ctx, listeners } = fakeCtx();
  apply(ctx, Config({ keepRelevant: false }));
  const post = listeners["tools/post-execute"][0];
  const big = { content: [{ type: "text", text: bigOutput() }] };
  // A path this plugin saved earlier, then DSH's spill folder in general.
  const first = await post(exec({ command: "npm test" }), big, async () => ({ kind: "accept" }));
  assert.ok(first.content);
  const again = await post({ ...exec({ command: `python3 read.py ${join(dir, "full.txt")}` }), callId: "c3" }, big, async () => ({ kind: "accept" }));
  assert.deepEqual(again, { kind: "accept" });
  const spill = await post({ ...exec({ command: "python3 -c \"open('/var/T/dsh-spill-Ab12/session-1/x-full.txt')\"" }), callId: "c4" }, big, async () => ({ kind: "accept" }));
  assert.deepEqual(spill, { kind: "accept" });
  const log = readFileSync(process.env.CTX_FILTER_DSH_EVENTS, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(log.some((e) => e.action === "saved-read" && e.callId === "c4"));
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

// web_fetch results: page clutter removed before anything else.
const ddgPage = readFileSync(new URL("./fixtures/web_fetch/ddg-gaps.md", import.meta.url), "utf8");
const article = readFileSync(new URL("./fixtures/web_fetch/readme-demucs.md", import.meta.url), "utf8");
const readLog = () => readFileSync(process.env.CTX_FILTER_DSH_EVENTS, "utf8").trim().split("\n").map((l) => JSON.parse(l));

function savingCtx() {
  const listeners = {};
  const saved = [];
  const ctx = {
    logger: { warn: () => {} },
    on: (name, fn) => ((listeners[name] ??= []).push(fn), () => {}),
    inject: () => {},
    get: (name) => (name === "spillStore" ? { saveText: async (r) => (saved.push(r), { locator: join(dir, `saved-${saved.length}.txt`) }) } : undefined),
  };
  return { ctx, listeners, saved };
}
const fetchExec = (callId, url = "https://html.duckduckgo.com/html/?q=GAPS") => ({
  name: "web_fetch",
  callId,
  arguments: JSON.stringify({ url }),
  agent: { session: { header: { id: "s1" }, events: [] } },
});
const accept = async () => ({ kind: "accept" });

test("a search page under the threshold is cleaned, noted and its original saved", async () => {
  const { ctx, listeners, saved } = savingCtx();
  apply(ctx, Config({ keepRelevant: false }));
  const d = await listeners["tools/post-execute"][0](fetchExec("w1"), { content: [{ type: "text", text: ddgPage }] }, accept);
  const out = d.content[0].text;
  assert.ok(out.length < ddgPage.length * 0.5);
  assert.doesNotMatch(out, /duckduckgo\.com\/l\//);
  assert.match(out, /\[context filter\] Page clutter removed .*no text was cut\. Original page: .*saved-1\.txt\.$/);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].content, ddgPage);
  const e = readLog().find((x) => x.callId === "w1");
  assert.equal(e.action, "decluttered");
  assert.equal(e.passReason, "small");
  assert.equal(e.tokensBefore, Math.ceil(ddgPage.length / 4));
  assert.equal(e.tokensAfter, Math.ceil(out.length / 4));
  assert.equal(e.declutter.applied, true);
  assert.ok(e.declutter.linksDecoded >= 10);
  // Opening the original page later counts as a reopen of this result.
  listeners["tools/result"][0]({ name: "read", callId: "w1r", arguments: JSON.stringify({ file_path: saved.length && join(dir, "saved-1.txt") }), agent: { session: { header: { id: "s1" } } } });
  assert.ok(readLog().some((x) => x.kind === "followup" && x.ofCallId === "w1"));
});

test("a page that would shrink less than declutterMinPercent, another tool, or declutter off: unchanged", async () => {
  const { ctx, listeners, saved } = savingCtx();
  apply(ctx, Config({ keepRelevant: false, minTokens: 100000 }));
  const post = listeners["tools/post-execute"][0];
  assert.deepEqual(await post(fetchExec("w2", "https://raw.githubusercontent.com/x/README.md"), { content: [{ type: "text", text: article }] }, accept), { kind: "accept" });
  assert.deepEqual(await post({ ...exec({ command: "curl x" }), callId: "w3" }, { content: [{ type: "text", text: ddgPage }] }, accept), { kind: "accept" });
  const off = savingCtx();
  apply(off.ctx, Config({ keepRelevant: false, declutter: false, minTokens: 100000 }));
  assert.deepEqual(await off.listeners["tools/post-execute"][0](fetchExec("w4"), { content: [{ type: "text", text: ddgPage }] }, accept), { kind: "accept" });
  assert.equal(saved.length + off.saved.length, 0);
  assert.equal(readLog().find((x) => x.callId === "w2").action, "small");
});

test("shadow mode logs what clutter removal would save and passes the page through", async () => {
  const { ctx, listeners, saved } = savingCtx();
  apply(ctx, Config({ keepRelevant: false, shadowMode: true }));
  const d = await listeners["tools/post-execute"][0](fetchExec("w5"), { content: [{ type: "text", text: ddgPage }] }, accept);
  assert.deepEqual(d, { kind: "accept" });
  assert.equal(saved.length, 0);
  const e = readLog().find((x) => x.callId === "w5");
  // The page stays as fetched, still over the threshold, so the cut is judged in shadow too.
  assert.equal(e.action, "shadow");
  assert.equal(e.declutter.applied, false);
  assert.ok(e.declutter.tokensAfter < e.declutter.tokensBefore);
});

test("a cleaned page still over the threshold is cut from the cleaned text", async () => {
  const { ctx, listeners, saved } = savingCtx();
  apply(ctx, Config({ keepRelevant: false, minTokens: 200 }));
  const d = await listeners["tools/post-execute"][0](fetchExec("w6"), { content: [{ type: "text", text: ddgPage }] }, accept);
  const out = d.content[0].text;
  assert.match(out, /\[context filter\] Kept/);
  assert.match(out, /Full result: .*saved-2\.txt\..*Page before clutter removal: .*saved-1\.txt\./);
  assert.equal(saved[0].content, ddgPage);
  assert.doesNotMatch(saved[1].content, /duckduckgo\.com\/l\//);
  const e = readLog().find((x) => x.callId === "w6");
  assert.equal(e.action, "filtered");
  assert.equal(e.tokensBefore, Math.ceil(ddgPage.length / 4));
  assert.equal(e.declutter.locator, join(dir, "saved-1.txt"));
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
