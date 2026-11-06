// Local LiquidAI d1 (MLX) through a long-lived Python daemon on a unix socket, started on first use.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOME_DIR, type Config } from "../config.ts";
import type { Chunk } from "../chunk.ts";
import { RELEVANCE_FALSE, RELEVANCE_QUESTION, RELEVANCE_TRUE, type Judge, type JudgeInput, type JudgeResult } from "./types.ts";

const SOCKET = join(HOME_DIR, "d1.sock");
const LOG = join(HOME_DIR, "d1.log");
const SERVER_PY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "python", "d1_server.py");

// d1 takes instructions and criteria as plain strings (an object there means audio input).
const QUESTION = {
  rel: {
    type: "noul",
    instructions: RELEVANCE_QUESTION,
    criteria: { true: RELEVANCE_TRUE, false: RELEVANCE_FALSE },
  },
};

interface D1Reply {
  results?: Array<Record<string, { noul?: number }>>;
  error?: string;
}

function request(payload: unknown, timeoutMs: number): Promise<D1Reply> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(SOCKET);
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("d1 daemon timed out"));
    }, timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify(payload) + "\n"));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        clearTimeout(timer);
        sock.end();
        try {
          resolve(JSON.parse(buf.slice(0, nl)) as D1Reply);
        } catch (e) {
          reject(e as Error);
        }
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function canConnect(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(SOCKET);
    s.on("connect", () => {
      s.end();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });
}

let starting: Promise<void> | null = null;

export async function ensureDaemon(cfg: Config["d1"]): Promise<void> {
  if (await canConnect()) return;
  if (starting) return starting;
  starting = (async () => {
    if (!existsSync(cfg.python)) throw new Error(`d1 python not found: ${cfg.python}`);
    if (!existsSync(cfg.modelPath)) throw new Error(`d1 model not found: ${cfg.modelPath}`);
    mkdirSync(HOME_DIR, { recursive: true });
    const log = openSync(LOG, "a");
    const child = spawn(cfg.python, ["-I", SERVER_PY, SOCKET, cfg.modelPath, String(cfg.idleMinutes)], {
      detached: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
    const until = Date.now() + cfg.startTimeoutMs;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 250));
      if (await canConnect()) return;
      if (child.exitCode !== null && !(await canConnect())) throw new Error(`d1 daemon exited (${child.exitCode}); see ${LOG}`);
    }
    throw new Error(`d1 daemon did not start in ${cfg.startTimeoutMs} ms; see ${LOG}`);
  })().finally(() => {
    starting = null;
  });
  return starting;
}

export class D1Judge implements Judge {
  readonly name = "d1:local";
  private readonly cfg: Config["d1"];

  constructor(cfg: Config["d1"]) {
    this.cfg = cfg;
  }

  async judge(input: JudgeInput): Promise<JudgeResult> {
    await ensureDaemon(this.cfg);
    const probs = new Map<number, number>();
    const state = (p: Chunk) => ({ want: input.want, passage: p.text });
    for (let i = 0; i < input.passages.length; i += this.cfg.batchSize) {
      const left = input.deadline - Date.now();
      if (left <= 0) break;
      const batch = input.passages.slice(i, i + this.cfg.batchSize);
      // A batch already sent finishes even past the deadline; the wait is bounded by the batch size.
      const reply = await request({ requests: batch.map((p) => ({ state: state(p), questions: QUESTION })) }, Math.max(left, 15000));
      if (reply.error) throw new Error(`d1: ${reply.error}`);
      reply.results?.forEach((answers, j) => {
        const p = answers.rel?.noul;
        if (typeof p === "number") probs.set(batch[j]!.index, p);
      });
    }
    const missing = input.passages.length - probs.size;
    return { probs, note: missing > 0 ? `${missing} passages not judged (time budget reached)` : undefined };
  }
}
