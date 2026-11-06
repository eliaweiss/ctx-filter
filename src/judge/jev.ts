// Jev (or any decision model) through the Vercel AI Gateway, via the AI SDK's decide().
// One boolean question per passage; the passage rides in the question, `want` is the shared state.
import { execFileSync } from "node:child_process";
import { createGateway } from "@ai-sdk/gateway";
import { experimental_decide as decide, type Experimental_DecisionQuestion as Question } from "ai";
import type { Config } from "../config.ts";
import type { Chunk } from "../chunk.ts";
import { emptyUsage, RELEVANCE_FALSE, RELEVANCE_QUESTION, RELEVANCE_TRUE, type Judge, type JudgeInput, type JudgeResult } from "./types.ts";

/** Log text tokenizes worse than prose: 1 token per 3 bytes, plus the question text and criteria (~190 tokens,
 * measured against Jev's reported usage on a git log and a Playwright log). */
export function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 3) + 190;
}

/** Jev's answer when a request is over its token limit: 400 {"error_type":"max_tokens_exceeded"}. */
export function isTooLarge(e: unknown): boolean {
  return /max_tokens_exceeded|too (many|large)|context length|token limit/i.test(String((e as Error)?.message ?? e));
}

export function batchByTokens(passages: Chunk[], stateTokens: number, requestTokens: number): Chunk[][] {
  const batches: Chunk[][] = [];
  let cur: Chunk[] = [];
  let used = stateTokens;
  for (const p of passages) {
    const t = estimateTokens(p.bytes);
    if (cur.length > 0 && used + t > requestTokens) {
      batches.push(cur);
      cur = [];
      used = stateTokens;
    }
    cur.push(p);
    used += t;
  }
  if (cur.length > 0) batches.push(cur);
  return batches;
}

let commandKey: string | undefined;

/** The env var, else the output of apiKeyCommand (run once per process). */
export function resolveApiKey(cfg: Config["jev"]): string {
  const fromEnv = process.env[cfg.apiKeyEnv]?.trim();
  if (fromEnv) return fromEnv;
  if (cfg.apiKeyCommand) {
    commandKey ??= execFileSync("/bin/sh", ["-c", cfg.apiKeyCommand], { encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (commandKey) return commandKey;
    throw new Error(`jev.apiKeyCommand printed nothing`);
  }
  throw new Error(`${cfg.apiKeyEnv} is not set and no jev.apiKeyCommand is configured`);
}

export function question(p: Chunk): Question {
  return {
    type: "boolean",
    instructions: {
      question: RELEVANCE_QUESTION,
      passage: { lines: `${p.startLine}-${p.endLine}`, text: p.text },
    },
    criteria: { true: RELEVANCE_TRUE, false: RELEVANCE_FALSE },
  };
}

export class JevJudge implements Judge {
  readonly name: string;
  private readonly cfg: Config["jev"];

  constructor(cfg: Config["jev"]) {
    this.cfg = cfg;
    this.name = `jev:${cfg.model}`;
  }

  async judge(input: JudgeInput): Promise<JudgeResult> {
    const apiKey = resolveApiKey(this.cfg);
    const gateway = createGateway({ apiKey });
    const model = gateway.decisionModel(this.cfg.model);
    const state = { want: input.want, ...(input.source ? { source: input.source } : {}) };
    const stateTokens = estimateTokens(Buffer.byteLength(JSON.stringify(state)));
    const batches = batchByTokens(input.passages, stateTokens, this.cfg.requestTokens);
    const probs = new Map<number, number>();
    const errors: string[] = [];
    const usage = emptyUsage();
    const timeout = Math.max(1, input.deadline - Date.now());
    const signal = AbortSignal.timeout(timeout);
    // A work queue: a request Jev rejects as too large is split in half and both halves go back in,
    // down to one passage per request, so no passage is lost to the size limit.
    const queue = [...batches];
    let inFlight = 0;
    const worker = async () => {
      while (!signal.aborted) {
        const batch = queue.shift();
        if (!batch) {
          if (inFlight === 0) return;
          await new Promise((r) => setTimeout(r, 20)); // a running request may still split into new work
          continue;
        }
        inFlight++;
        try {
          const res = await decide({
            model,
            state,
            questions: Object.fromEntries(batch.map((p) => [`p${p.index}`, question(p)])),
            maxRetries: 1,
            abortSignal: signal,
            providerOptions: { gateway: { zeroDataRetention: this.cfg.zeroDataRetention } },
          });
          for (const p of batch) {
            const a = (res.answers as Record<string, { type: string; probability?: number }>)[`p${p.index}`];
            if (a?.type === "boolean" && typeof a.probability === "number") probs.set(p.index, a.probability);
          }
          usage.requests++;
          usage.inputTokens += res.usage?.inputTokens ?? 0;
          usage.outputTokens += res.usage?.outputTokens ?? 0;
          const cost = Number((res.providerMetadata?.gateway as { cost?: unknown } | undefined)?.cost);
          if (Number.isFinite(cost)) usage.costUsd += cost;
        } catch (e) {
          if (!signal.aborted && isTooLarge(e) && batch.length > 1) {
            const mid = Math.ceil(batch.length / 2);
            queue.unshift(batch.slice(0, mid), batch.slice(mid));
            usage.splits++;
          } else {
            errors.push(signal.aborted ? "time budget reached" : (e as Error).message);
          }
        } finally {
          inFlight--;
        }
      }
    };
    await Promise.all(Array.from({ length: this.cfg.concurrency }, worker));
    if (probs.size === 0 && errors.length > 0) throw new Error(errors[0]);
    const missing = input.passages.length - probs.size;
    return { probs, usage, note: missing > 0 ? `${missing} passages not judged (${errors[0] ?? "time budget reached"})` : undefined };
  }
}
