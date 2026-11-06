#!/usr/bin/env node
// Claude Code PostToolUse hook for Bash: a large output is stored whole and replaced by the passages
// the model judges relevant to the call's description (the agent's own words for what it wants).
// The hook never breaks the session: on any error it prints nothing and exits 0, so the original output stays.
import { existsSync, readFileSync, statSync } from "node:fs";
import { processOutput } from "./api.ts";
import { loadConfig } from "./config.ts";
import { logEvent, outcomeFields } from "./log.ts";
import { countLines } from "./store.ts";

interface HookInput {
  hook_event_name?: string;
  tool_name?: string;
  cwd?: string;
  tool_input?: { command?: string; description?: string };
  tool_response?: Record<string, unknown> & {
    stdout?: string;
    stderr?: string;
    persistedOutputPath?: string;
    persistedOutputSize?: number;
  };
}

const MAX_PERSISTED = 64 * 1024 * 1024;

function fullStdout(resp: NonNullable<HookInput["tool_response"]>): string {
  const head = typeof resp.stdout === "string" ? resp.stdout : "";
  const p = resp.persistedOutputPath;
  if (typeof p === "string" && p !== "" && existsSync(p)) {
    const st = statSync(p);
    if (st.isFile() && st.size <= MAX_PERSISTED) return readFileSync(p, "utf8");
  }
  return head;
}

async function main(): Promise<string> {
  const raw = readFileSync(0, "utf8");
  const ev = JSON.parse(raw) as HookInput;
  if (ev.hook_event_name !== "PostToolUse" || ev.tool_name !== "Bash" || !ev.tool_response) return "";
  const resp = ev.tool_response;
  const stdout = fullStdout(resp);
  const stderr = typeof resp.stderr === "string" ? resp.stderr : "";
  const text = stderr ? `${stdout}${stdout.endsWith("\n") || stdout === "" ? "" : "\n"}${stderr}` : stdout;
  const cfg = loadConfig();
  if (Buffer.byteLength(text) <= cfg.triggerBytes) return "";
  const command = ev.tool_input?.command ?? "";
  const want = ev.tool_input?.description?.trim() || command;
  const t0 = Date.now();
  const base = { client: "hook", tool: "hook:Bash" as const, cwd: ev.cwd, command, want, provider: cfg.provider, argChars: 0, rawChars: text.length, rawLines: countLines(text) };
  let res;
  try {
    res = await processOutput({ text, want, cfg, source: "hook", command, cwd: ev.cwd, mcpTools: process.env.CTX_FILTER_HOOK_MCP !== "0" });
  } catch (e) {
    logEvent({ ...base, ok: false, error: (e as Error).message.slice(0, 300), replyChars: text.length, totalMs: Date.now() - t0 });
    throw e;
  }
  const { reply, replaced } = res;
  logEvent({ ...base, ok: true, id: res.meta?.id, replyChars: replaced ? reply.length : text.length, totalMs: Date.now() - t0, ...outcomeFields(res.outcome) });
  if (!replaced) return "";
  const { persistedOutputPath: _p, persistedOutputSize: _s, ...host } = resp;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      updatedToolOutput: { interrupted: false, ...host, stdout: reply, stderr: "" },
    },
  });
}

main()
  .then((out) => {
    if (out) process.stdout.write(out);
    process.exit(0);
  })
  .catch((e) => {
    process.stderr.write(`ctx-filter hook: ${(e as Error).message}\n`);
    process.exit(0);
  });
