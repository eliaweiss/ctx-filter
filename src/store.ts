// Full outputs on disk: <home>/outputs/<id>.log plus <id>.json metadata. Nothing is ever cut here.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./config.ts";

export interface OutputMeta {
  id: string;
  command?: string;
  cwd?: string;
  source: "run" | "hook" | "file";
  exitCode?: number | null;
  bytes: number;
  lines: number;
  createdAt: string;
}

export function outputsDir(): string {
  const dir = join(HOME_DIR, "outputs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function newId(): string {
  return Date.now().toString(36) + randomBytes(3).toString("hex");
}

export function logPath(id: string): string {
  if (!/^[a-z0-9]{6,40}$/.test(id)) throw new Error(`bad output id: ${id}`);
  return join(outputsDir(), `${id}.log`);
}

export function saveOutput(text: string, meta: Omit<OutputMeta, "id" | "bytes" | "lines" | "createdAt">, retentionDays: number): OutputMeta {
  const id = newId();
  const full: OutputMeta = {
    ...meta,
    id,
    bytes: Buffer.byteLength(text),
    lines: countLines(text),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(logPath(id), text);
  writeFileSync(join(outputsDir(), `${id}.json`), JSON.stringify(full, null, 1));
  prune(retentionDays);
  return full;
}

export function loadOutput(id: string): { text: string; meta: OutputMeta | null } {
  const path = logPath(id);
  if (!existsSync(path)) throw new Error(`no stored output with id ${id} (it may have expired)`);
  const metaPath = join(outputsDir(), `${id}.json`);
  const meta = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, "utf8")) as OutputMeta) : null;
  return { text: readFileSync(path, "utf8"), meta };
}

export function countLines(text: string): number {
  if (text === "") return 0;
  let n = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return text.endsWith("\n") ? n - 1 : n;
}

function prune(retentionDays: number): void {
  if (retentionDays <= 0) return;
  const cutoff = Date.now() - retentionDays * 86_400_000;
  const dir = outputsDir();
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
    } catch {
      // another process removed it
    }
  }
}
