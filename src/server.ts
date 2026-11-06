#!/usr/bin/env node
// MCP server (stdio): run, filter, read_output, grep_output.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { processOutput } from "./api.ts";
import { splitLines } from "./chunk.ts";
import { loadConfig } from "./config.ts";
import { runCommand } from "./exec.ts";
import { loadOutput, saveOutput } from "./store.ts";

const READ_CAP = 16 * 1024;
const provider = z.enum(["jev", "d1", "none"]).optional().describe("Override the configured filter model for this call.");
const want = z
  .string()
  .min(3)
  .describe(
    "What you need from the output, as a specific request: e.g. 'which tests failed, with their error and file:line', 'the version of react that was installed', 'every 5xx request and its path'.",
  );

const server = new McpServer({ name: "ctx-filter", version: "0.1.0" });
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
const fail = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true });

server.registerTool(
  "run",
  {
    description:
      "Run a shell command and get back only the parts of its output that answer `want`. Use it instead of Bash for anything that may print more than ~50 lines: tests, builds, installs, logs, git log/diff, curl, CLI JSON. Output up to 4 KB comes back whole. Larger output is stored in full; a small decision model keeps the passages relevant to `want` (verbatim, with line numbers). The footer gives an id for filter/read_output/grep_output to get more.",
    inputSchema: {
      command: z.string().min(1).describe("Shell command, run with bash -c."),
      want,
      cwd: z.string().optional().describe("Working directory. Default: the server's cwd (the project)."),
      timeout_ms: z.number().int().min(1000).max(3_600_000).optional().describe("Default 600000."),
      provider,
    },
  },
  async (a) => {
    const cfg = loadConfig();
    const cwd = a.cwd ? resolve(a.cwd) : process.cwd();
    const r = await runCommand(a.command, { cwd, timeoutMs: a.timeout_ms ?? 600_000, maxBytes: cfg.maxCaptureBytes });
    const { reply } = await processOutput({
      text: r.text,
      want: a.want,
      cfg,
      provider: a.provider,
      source: "run",
      command: a.command,
      cwd,
      exitCode: r.exitCode,
      mcpTools: true,
    });
    return text(reply);
  },
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
  async (a) => {
    const cfg = loadConfig();
    if (!a.id === !a.path) return fail("Give exactly one of id or path.");
    if (a.id) {
      const { text: body, meta } = loadOutput(a.id);
      const { reply } = await processOutput({ text: body, want: a.want, cfg, provider: a.provider, source: meta?.source ?? "run", command: meta?.command, exitCode: meta?.exitCode, mcpTools: true, meta: meta ?? undefined });
      return text(reply);
    }
    const p = resolve(a.path!);
    if (!existsSync(p)) return fail(`No such file: ${p}`);
    const body = readFileSync(p, "utf8");
    const meta = Buffer.byteLength(body) > cfg.triggerBytes ? saveOutput(body, { source: "file", command: p }, cfg.retentionDays) : undefined;
    const { reply } = await processOutput({ text: body, want: a.want, cfg, provider: a.provider, source: "file", command: p, mcpTools: true, meta });
    return text(reply);
  },
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
  async (a) => {
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
    return text(out.join("\n") + tail);
  },
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
  async (a) => {
    let re: RegExp;
    try {
      re = new RegExp(a.pattern, "i");
    } catch (e) {
      return fail(`Bad pattern: ${(e as Error).message}`);
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
    return text(out.length ? `${out.join("\n")}\n[${matches} matches${matches >= max ? " (limit reached)" : ""}]` : "No match.");
  },
);

await server.connect(new StdioServerTransport());
