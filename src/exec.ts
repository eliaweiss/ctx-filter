// Run a shell command, stdout and stderr interleaved in arrival order, killing the whole group on timeout.
import { spawn } from "node:child_process";

export interface ExecResult {
  text: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  ms: number;
}

export function runCommand(command: string, opts: { cwd?: string; timeoutMs: number; maxBytes: number }): Promise<ExecResult> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/bash", ["-c", command], {
      cwd: opts.cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const parts: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    const take = (d: Buffer) => {
      if (bytes >= opts.maxBytes) {
        truncated = true;
        return;
      }
      const room = opts.maxBytes - bytes;
      const piece = d.length > room ? d.subarray(0, room) : d;
      if (piece.length < d.length) truncated = true;
      parts.push(piece);
      bytes += piece.length;
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, opts.timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let text = Buffer.concat(parts).toString("utf8");
      if (timedOut) text += `\n[ctx-filter: killed after ${opts.timeoutMs} ms]`;
      if (truncated) text += `\n[ctx-filter: capture stopped at ${opts.maxBytes} bytes]`;
      resolve({ text, exitCode: code, timedOut, truncated, ms: Date.now() - t0 });
    });
  });
}
