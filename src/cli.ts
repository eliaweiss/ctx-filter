#!/usr/bin/env node
// ctx-filter run   --want "..." [--provider jev|d1|none] -- <command...>
// ctx-filter file  <path> --want "..." [--provider ...]
// ctx-filter stats [--since 30m|13:10|ISO] [--until ...] [--client dsh] [--timeline] ...
// ctx-filter d1-start        start the local d1 daemon now (it also starts on first use)
// ctx-filter config          print the effective config
// CLI run/file calls are not logged, so manual tests do not mix into session stats.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { processOutput } from "./api.ts";
import { configPath, loadConfig, type Provider } from "./config.ts";
import { runCommand } from "./exec.ts";
import { ensureDaemon } from "./judge/d1.ts";
import { EVENTS_FILE, readEvents } from "./log.ts";
import { compute, instructionFileFor, instructionSectionChars, parseWhen, report, timeline } from "./stats.ts";
import { saveOutput } from "./store.ts";

const usage = `usage:
  ctx-filter run  --want "<what you need>" [--provider jev|d1|none] -- <command...>
  ctx-filter file <path> --want "<what you need>" [--provider jev|d1|none]
  ctx-filter stats [--since 30m|2h|13:10|ISO] [--until ...] [--client dsh] [--sessions 1]
                   [--cap 12500] [--price <usd per M input tokens>] [--timeline] [--json]
  ctx-filter d1-start
  ctx-filter config`;

/** Characters of the tool definitions the host shows the model: spawn the server and list its tools. */
async function toolSchemaChars(): Promise<number> {
  const here = dirname(fileURLToPath(import.meta.url));
  const serverJs = join(here, "server.js");
  const serverTs = join(here, "server.ts");
  const useTs = import.meta.url.endsWith(".ts");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: useTs ? ["--experimental-strip-types", "--no-warnings", serverTs] : [serverJs],
    stderr: "ignore",
  });
  const client = new Client({ name: "ctx-filter-stats", version: "0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    return tools.reduce((a, t) => a + JSON.stringify({ name: `mcp__ctx-filter__${t.name}`, description: t.description, input_schema: t.inputSchema }).length, 0);
  } finally {
    await client.close();
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  const head = sep === -1 ? argv : argv.slice(0, sep);
  const rest = sep === -1 ? [] : argv.slice(sep + 1);
  const { values, positionals } = parseArgs({
    args: head,
    allowPositionals: true,
    options: {
      want: { type: "string" },
      provider: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      client: { type: "string" },
      sessions: { type: "string" },
      cap: { type: "string" },
      price: { type: "string" },
      timeline: { type: "boolean" },
      json: { type: "boolean" },
    },
  });
  const cmd = positionals[0];
  const cfg = loadConfig();
  const provider = values.provider as Provider | undefined;
  if (cmd === "config") {
    console.log(`# ${configPath()}\n${JSON.stringify(cfg, null, 2)}`);
    return 0;
  }
  if (cmd === "stats") {
    const events = readEvents();
    const client = values.client;
    const opts = {
      since: values.since ? parseWhen(values.since) : undefined,
      until: values.until ? parseWhen(values.until) : undefined,
      client,
      baselineCapTokens: values.cap ? Number(values.cap) : 12_500,
      sessions: values.sessions ? Number(values.sessions) : 1,
      toolSchemaChars: await toolSchemaChars(),
      instructionChars: instructionSectionChars(instructionFileFor(client ?? events.at(-1)?.client)),
      pricePerMTok: values.price ? Number(values.price) : undefined,
    };
    if (values.json) {
      const c = compute(events, opts);
      const { evs: _e, primary: _p, follow: _f, rows, filtered: _x, ...totals } = c;
      console.log(JSON.stringify({ options: { ...opts, since: opts.since?.toISOString(), until: opts.until?.toISOString() }, totals, rows: rows.map((r) => ({ ts: r.ev.ts, tool: r.ev.tool, id: r.ev.id, baselineTok: r.baselineTok, replyTok: r.replyTok, savedTok: r.savedTok, followUps: r.followUps })) }, null, 1));
      return 0;
    }
    console.log(report(events, opts));
    if (values.timeline) console.log("\nTIMELINE\n" + timeline(events, opts));
    console.log(`\n(events: ${EVENTS_FILE})`);
    return 0;
  }
  if (cmd === "d1-start") {
    const t = Date.now();
    await ensureDaemon(cfg.d1);
    console.log(`d1 daemon ready (${Date.now() - t} ms)`);
    return 0;
  }
  if ((cmd === "run" || cmd === "file") && !values.want) {
    console.error("--want is required\n" + usage);
    return 2;
  }
  if (cmd === "run") {
    const command = rest.join(" ");
    if (!command) {
      console.error(usage);
      return 2;
    }
    const r = await runCommand(command, { cwd: process.cwd(), timeoutMs: 600_000, maxBytes: cfg.maxCaptureBytes });
    const { reply } = await processOutput({ text: r.text, want: values.want!, cfg, provider, source: "run", command, cwd: process.cwd(), exitCode: r.exitCode, mcpTools: false });
    console.log(reply);
    return 0;
  }
  if (cmd === "file") {
    const p = resolve(positionals[1] ?? "");
    const body = readFileSync(p, "utf8");
    const meta = Buffer.byteLength(body) > cfg.triggerBytes ? saveOutput(body, { source: "file", command: p }, cfg.retentionDays) : undefined;
    const { reply } = await processOutput({ text: body, want: values.want!, cfg, provider, source: "file", command: p, mcpTools: false, meta });
    console.log(reply);
    return 0;
  }
  console.error(usage);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`ctx-filter: ${(e as Error).message}`);
    process.exit(1);
  },
);
