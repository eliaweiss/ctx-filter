// Run a shell command, stdout and stderr interleaved in arrival order.
//
// The call ends when the shell exits, not when every process holding the output pipe exits. So a command
// that starts a long-lived process in the background (Chrome with a debugging port, a dev server) returns
// as soon as the shell is done, and that process keeps running. Its later output is drained and dropped,
// so it never dies of a closed pipe. Only a shell still running at the timeout has its process group killed.
import { spawn } from "node:child_process";

export interface ExecResult {
  text: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  /** The shell exited while a background process still held its output open. */
  backgroundLeft: boolean;
  ms: number;
}

/** After the shell exits, wait this long for output still in the pipe. */
const EXIT_DRAIN_MS = 300;

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
    let done = false;
    let exitCode: number | null = null;
    const take = (d: Buffer) => {
      if (done) return; // drained and dropped: output of a process left running in the background
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
    const finish = (backgroundLeft: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (backgroundLeft) {
        // Keep draining so the background process never writes into a closed pipe; do not hold the event loop.
        // Child pipes are net.Socket at runtime; Readable's type does not show unref.
        (child.stdout as unknown as { unref?: () => void }).unref?.();
        (child.stderr as unknown as { unref?: () => void }).unref?.();
      }
      let text = Buffer.concat(parts).toString("utf8");
      if (timedOut) text += `\n[ctx-filter: killed after ${opts.timeoutMs} ms]`;
      if (truncated) text += `\n[ctx-filter: capture stopped at ${opts.maxBytes} bytes]`;
      if (backgroundLeft) text += `\n[ctx-filter: the shell exited; a background process is still running and its later output is not captured]`;
      resolve({ text, exitCode, timedOut, truncated, backgroundLeft, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, opts.timeoutMs);
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("exit", (code) => {
      exitCode = code;
      // The pipes normally close right after; if they do not, something in the background holds them.
      setTimeout(() => finish(true), EXIT_DRAIN_MS).unref();
    });
    child.on("close", (code) => {
      exitCode = code;
      finish(false);
    });
  });
}
