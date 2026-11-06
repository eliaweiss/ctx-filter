#!/usr/bin/env node
// ctx-filter run   --want "..." [--provider jev|d1|none] -- <command...>
// ctx-filter file  <path> --want "..." [--provider ...]
// ctx-filter d1-start        start the local d1 daemon now (it also starts on first use)
// ctx-filter config          print the effective config
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { processOutput } from "./api.ts";
import { configPath, loadConfig, type Provider } from "./config.ts";
import { runCommand } from "./exec.ts";
import { ensureDaemon } from "./judge/d1.ts";
import { saveOutput } from "./store.ts";

const usage = `usage:
  ctx-filter run  --want "<what you need>" [--provider jev|d1|none] -- <command...>
  ctx-filter file <path> --want "<what you need>" [--provider jev|d1|none]
  ctx-filter d1-start
  ctx-filter config`;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf("--");
  const head = sep === -1 ? argv : argv.slice(0, sep);
  const rest = sep === -1 ? [] : argv.slice(sep + 1);
  const { values, positionals } = parseArgs({
    args: head,
    allowPositionals: true,
    options: { want: { type: "string" }, provider: { type: "string" } },
  });
  const cmd = positionals[0];
  const cfg = loadConfig();
  const provider = values.provider as Provider | undefined;
  if (cmd === "config") {
    console.log(`# ${configPath()}\n${JSON.stringify(cfg, null, 2)}`);
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
