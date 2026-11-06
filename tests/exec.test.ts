import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { test } from "node:test";

const { runCommand } = await import("../src/exec.ts");

test("captures stdout and stderr and the exit code", async () => {
  const r = await runCommand("echo out; echo err >&2; exit 3", { timeoutMs: 5000, maxBytes: 1e6 });
  assert.equal(r.exitCode, 3);
  assert.match(r.text, /out/);
  assert.match(r.text, /err/);
  assert.equal(r.backgroundLeft, false);
});

test("a background process does not hold the call, and keeps running", async () => {
  const tag = `ctxf-bg-${process.pid}-${Date.now()}`;
  const t0 = Date.now();
  // The background loop keeps writing to the inherited pipe, like a browser logging to stderr.
  const r = await runCommand(`(while true; do echo ${tag}; sleep 0.2; done) & echo started`, { timeoutMs: 20_000, maxBytes: 1e6 });
  const took = Date.now() - t0;
  try {
    assert.ok(took < 3000, `returned after ${took} ms`);
    assert.match(r.text, /started/);
    assert.equal(r.backgroundLeft, true);
    assert.equal(r.timedOut, false);
    await new Promise((res) => setTimeout(res, 700));
    const alive = execSync(`pgrep -f "echo ${tag}" || true`, { encoding: "utf8" }).trim();
    assert.notEqual(alive, "", "the background process should still be running");
  } finally {
    execSync(`pkill -f "echo ${tag}" || true`);
  }
});

test("a shell still running at the timeout is killed", async () => {
  const r = await runCommand("echo begin; sleep 30", { timeoutMs: 800, maxBytes: 1e6 });
  assert.equal(r.timedOut, true);
  assert.match(r.text, /begin/);
  assert.match(r.text, /killed after 800 ms/);
});
