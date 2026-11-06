#!/usr/bin/env node
// MCP server (stdio): run, filter, read_output, grep_output. Every call is logged to <home>/events.jsonl.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { processOutput } from "./api.ts";
import { splitLines } from "./chunk.ts";
import { loadConfig } from "./config.ts";
import { runCommand } from "./exec.ts";
import { logEvent, outcomeFields, type CallEvent, type ToolName } from "./log.ts";
import { countLines, loadOutput, saveOutput } from "./store.ts";

const READ_CAP = 16 * 1024;
const provider = z.enum(["jev", "d1", "none"]).optional().describe("Override the configured filter model for this call.");
const want = z
  .string()
  .min(3)
  .describe(
    "What you need from the output, as a specific request: e.g. 'which tests failed, with their error and file:line', 'the version of react that was installed', 'every 5xx request and its path'.",
  );

const server = new McpServer({ name: "ctx-filter", version: "0.2.0" });
type Reply = { content: { type: "text"; text: string }[]; isError?: boolean };
type Logged = Omit<CallEvent, "ts" | "pid" | "client" | "tool" | "ok" | "argChars" | "replyChars" | "totalMs">;

const clientName = () => server.server.getClientVersion()?.name ?? "unknown";

/** Run a handler, log one event for it (also on failure), return the reply. */
async function logged(tool: ToolName, args: unknown, fn: (ev: Logged) => Promise<string>): Promise<Reply> {
  const t0 = Date.now();
  const ev: Logged = {};
  const argChars = JSON.stringify(args).length;
  try {
    const text = await fn(ev);
    logEvent({ client: clientName(), tool, ok: true, argChars, replyChars: text.length, totalMs: Date.now() - t0, ...ev });
    return { content: [{ type: "text", text }] };
  } catch (e) {
    const msg = (e as Error).message;
    const text = `ctx-filter ${tool} failed: ${msg}`;
    logEvent({ client: clientName(), tool, ok: false, error: msg.slice(0, 300), argChars, replyChars: text.length, totalMs: Date.now() - t0, ...ev });
    return { content: [{ type: "text", text }], isError: true };
  }
}

server.registerTool(
  "run",
  {
    description:
      "Run a shell command and get back only the parts of its output that answer `want`. Use it instead of Bash for anything that may print more than ~50 lines: tests, builds, installs, logs, git log/diff, curl, CLI JSON. Output up to 4 KB comes back whole. Larger output is stored in full; a small decision model keeps the passages relevant to `want` (verbatim, with line numbers). The footer gives an id for filter/read_output/grep_output to get more.",
    inputSchema: {
      command: z.string().min(1).describe("Shell command, run with bash -c."),
      want,
      cwd: z
        .string()
        .optional()
        .describe("Working directory. Always pass your current working directory: the server may have been started elsewhere."),
      timeout_ms: z.number().int().min(1000).max(3_600_000).optional().describe("Default 600000."),
      provider,
    },
  },
  (a) =>
    logged("run", a, async (ev) => {
      const cfg = loadConfig();
      const cwd = a.cwd ? resolve(a.cwd) : process.cwd();
      Object.assign(ev, { cwd, command: a.command, want: a.want, provider: a.provider ?? cfg.provider });
      const r = await runCommand(a.command, { cwd, timeoutMs: a.timeout_ms ?? 600_000, maxBytes: cfg.maxCaptureBytes });
      Object.assign(ev, { execMs: r.ms, exitCode: r.exitCode, rawChars: r.text.length, rawLines: countLines(r.text) });
      const res = await processOutput({ text: r.text, want: a.want, cfg, provider: a.provider, source: "run", command: a.command, cwd, exitCode: r.exitCode, mcpTools: true });
      Object.assign(ev, { id: res.meta?.id, ...outcomeFields(res.outcome) });
      return res.reply;
    }),
);

server.registerTool(
  "filter",
  {
    description:
      "Filter a stored output (by id) or a large file (by path) for a new `want`. Use it to ask a second question about output you already have, or to read a large log/data file without loading it whole.",
    inputSchema: {
      id: z.string().optional().describe("Output id from a previous run/filter footer."),
      path: z.string().optional().describe("A file to filter instead of a stored output."),
      want,
      provider,
    },
  },
  (a) =>
    logged("filter", a, async (ev) => {
      const cfg = loadConfig();
      Object.assign(ev, { want: a.want, provider: a.provider ?? cfg.provider });
      if (!a.id === !a.path) throw new Error("give exactly one of id or path");
      if (a.id) {
        ev.parentId = a.id;
        const { text: body, meta } = loadOutput(a.id);
        Object.assign(ev, { command: meta?.command, rawChars: body.length, rawLines: countLines(body) });
        const res = await processOutput({ text: body, want: a.want, cfg, provider: a.provider, source: meta?.source ?? "run", command: meta?.command, exitCode: meta?.exitCode, mcpTools: true, meta: meta ?? undefined });
        Object.assign(ev, { id: a.id, ...outcomeFields(res.outcome) });
        return res.reply;
      }
      const p = resolve(a.path!);
      ev.command = p;
      if (!existsSync(p)) throw new Error(`no such file: ${p}`);
      const body = readFileSync(p, "utf8");
      Object.assign(ev, { rawChars: body.length, rawLines: countLines(body) });
      const meta = Buffer.byteLength(body) > cfg.triggerBytes ? saveOutput(body, { source: "file", command: p }, cfg.retentionDays) : undefined;
      const res = await processOutput({ text: body, want: a.want, cfg, provider: a.provider, source: "file", command: p, mcpTools: true, meta });
      Object.assign(ev, { id: meta?.id, ...outcomeFields(res.outcome) });
      return res.reply;
    }),
);

server.registerTool(
  "read_output",
  {
    description: "Read a line range of a stored output, verbatim (at most 16 KB per call).",
    inputSchema: {
      id: z.string(),
      from_line: z.number().int().min(1),
      to_line: z.number().int().min(1),
    },
  },
  (a) =>
    logged("read_output", a, async (ev) => {
      ev.parentId = a.id;
      const lines = splitLines(loadOutput(a.id).text);
      const out: string[] = [];
      let used = 0;
      let last = a.from_line - 1;
      for (let n = a.from_line; n <= Math.min(a.to_line, lines.length); n++) {
        const l = `${n}: ${lines[n - 1]}`;
        if (used + l.length + 1 > READ_CAP) break;
        out.push(l);
        used += l.length + 1;
        last = n;
      }
      const tail = last < Math.min(a.to_line, lines.length) ? `\n[stopped at line ${last} (16 KB); ${lines.length} lines total]` : `\n[${lines.length} lines total]`;
      return out.join("\n") + tail;
    }),
);

server.registerTool(
  "grep_output",
  {
    description: "Search a stored output with a regular expression (case-insensitive). Returns matching lines with line numbers and optional context.",
    inputSchema: {
      id: z.string(),
      pattern: z.string().min(1),
      context: z.number().int().min(0).max(10).optional().describe("Lines of context around each match. Default 0."),
      max_matches: z.number().int().min(1).max(500).optional().describe("Default 50."),
    },
  },
  (a) =>
    logged("grep_output", a, async (ev) => {
      ev.parentId = a.id;
      let re: RegExp;
      try {
        re = new RegExp(a.pattern, "i");
      } catch (e) {
        throw new Error(`bad pattern: ${(e as Error).message}`);
      }
      const lines = splitLines(loadOutput(a.id).text);
      const ctx = a.context ?? 0;
      const max = a.max_matches ?? 50;
      const show = new Set<number>();
      let matches = 0;
      for (let i = 0; i < lines.length && matches < max; i++) {
        if (!re.test(lines[i]!)) continue;
        matches++;
        for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j++) show.add(j);
      }
      const out: string[] = [];
      let used = 0;
      let prev = -2;
      for (const i of [...show].sort((x, y) => x - y)) {
        const l = `${i !== prev + 1 && out.length > 0 ? "--\n" : ""}${i + 1}: ${lines[i]}`;
        if (used + l.length > READ_CAP) {
          out.push("[stopped at 16 KB]");
          break;
        }
        out.push(l);
        used += l.length + 1;
        prev = i;
      }
      return out.length ? `${out.join("\n")}\n[${matches} matches${matches >= max ? " (limit reached)" : ""}]` : "No match.";
    }),
);

await server.connect(new StdioServerTransport());
