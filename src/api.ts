// One entry for every caller (MCP server, hook, CLI): store the full text, filter it, render the reply.
import type { Config, Provider } from "./config.ts";
import { filterText, render } from "./filter.ts";
import { logPath, saveOutput, type OutputMeta } from "./store.ts";

export interface ProcessArgs {
  text: string;
  want: string;
  cfg: Config;
  provider?: Provider;
  source: OutputMeta["source"];
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  mcpTools: boolean;
  /** Reuse an already stored output instead of storing a new copy. */
  meta?: OutputMeta;
}

export async function processOutput(a: ProcessArgs): Promise<{ reply: string; meta: OutputMeta | null; replaced: boolean }> {
  const small = Buffer.byteLength(a.text) <= a.cfg.triggerBytes;
  const meta = a.meta ?? (small ? null : saveOutput(a.text, { source: a.source, command: a.command, cwd: a.cwd, exitCode: a.exitCode }, a.cfg.retentionDays));
  const out = await filterText(a.text, a.want, a.cfg, { provider: a.provider, source: a.command });
  if (out.whole || meta === null) {
    return { reply: render(out, a.text, { id: "", path: "", want: a.want, bytes: 0, lines: 0, exitCode: a.exitCode, mcpTools: a.mcpTools }), meta, replaced: false };
  }
  const reply = render(out, a.text, {
    id: meta.id,
    path: logPath(meta.id),
    want: a.want,
    bytes: meta.bytes,
    lines: meta.lines,
    exitCode: a.exitCode,
    mcpTools: a.mcpTools,
  });
  return { reply, meta, replaced: true };
}
