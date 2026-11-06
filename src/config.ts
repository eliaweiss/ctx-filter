// User configuration: ~/.ctx-filter/config.json (or $CTX_FILTER_CONFIG), then env overrides.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

export const HOME_DIR = process.env.CTX_FILTER_HOME ?? join(homedir(), ".ctx-filter");

export function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

const JevConfig = z.object({
  /** Any Vercel AI Gateway decision model id, e.g. typesafe-ai/jev-1.14.0 or liquid/d1. */
  model: z.string().default("typesafe-ai/jev-1.14.0"),
  /** Env var that holds the gateway key. */
  apiKeyEnv: z.string().default("AI_GATEWAY_API_KEY"),
  /** Shell command that prints the key, used when the env var is unset (e.g. a macOS Keychain lookup). */
  apiKeyCommand: z.string().optional(),
  /** Parallel gateway requests. */
  concurrency: z.number().int().min(1).max(16).default(4),
  /** Estimated tokens per request (Jev's cap is 64k for state + all questions). */
  requestTokens: z.number().int().min(2000).max(64000).default(56000),
  /** Most output bytes sent to the model per filter call; the rest is pre-ranked away. */
  maxJudgeBytes: z.number().int().min(1024).default(256 * 1024),
  zeroDataRetention: z.boolean().default(true),
});

const D1Config = z.object({
  /** Python with mlx_vlm installed. */
  python: z.string().default("~/models/d1-bench/.venv/bin/python"),
  /** The MLX model folder. */
  modelPath: z.string().default("~/models/d1-2B-MLX-4bit"),
  /** Local d1 reads about 800 tokens/s on an M2, so it judges a pre-ranked share of the output. */
  maxJudgeBytes: z.number().int().min(1024).default(12 * 1024),
  /** Passages per socket round trip; the deadline is checked between round trips. */
  batchSize: z.number().int().min(1).max(64).default(4),
  /** The daemon exits after this many idle minutes. */
  idleMinutes: z.number().min(1).default(30),
  /** How long to wait for a cold daemon to load the model. */
  startTimeoutMs: z.number().int().min(1000).default(60000),
});

export const ConfigSchema = z.object({
  provider: z.enum(["jev", "d1", "none"]).default("jev"),
  jev: JevConfig.default(JevConfig.parse({})),
  d1: D1Config.default(D1Config.parse({})),
  /** A passage is kept when P(relevant) is at least this. */
  threshold: z.number().min(0).max(1).default(0.5),
  /** Output at or under this many bytes is returned whole, with no model call. */
  triggerBytes: z.number().int().min(0).default(4096),
  /** Most bytes of passages returned to the agent. */
  returnBytes: z.number().int().min(256).default(3000),
  /** Target passage size, cut on line ends. */
  chunkBytes: z.number().int().min(128).max(8192).default(600),
  /** Time budget for the model; past it the remaining passages are ranked by the cheap pre-rank only. */
  judgeTimeoutMs: z.number().int().min(500).default(25000),
  /** Stored outputs older than this are deleted. */
  retentionDays: z.number().min(0).default(7),
  /** Hard cap on captured command output. */
  maxCaptureBytes: z.number().int().default(64 * 1024 * 1024),
});

export type Config = z.infer<typeof ConfigSchema>;
export type Provider = Config["provider"];

export function configPath(): string {
  return process.env.CTX_FILTER_CONFIG ?? join(HOME_DIR, "config.json");
}

/** Load <home>/.env (KEY=VALUE lines) into process.env for keys not already set. Hosts that start
 * MCP servers with a scrubbed environment (DSH) still find AI_GATEWAY_API_KEY this way. */
export function loadDotEnv(env: NodeJS.ProcessEnv = process.env): void {
  const file = join(HOME_DIR, ".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || env[m[1]!]) continue;
    env[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  loadDotEnv(env);
  const file = configPath();
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`ctx-filter: cannot parse ${file}: ${(e as Error).message}`);
    }
  }
  const cfg = ConfigSchema.parse(raw);
  if (env.CTX_FILTER_PROVIDER) cfg.provider = z.enum(["jev", "d1", "none"]).parse(env.CTX_FILTER_PROVIDER);
  if (env.CTX_FILTER_JEV_MODEL) cfg.jev.model = env.CTX_FILTER_JEV_MODEL;
  if (env.CTX_FILTER_THRESHOLD) cfg.threshold = z.coerce.number().min(0).max(1).parse(env.CTX_FILTER_THRESHOLD);
  cfg.d1.python = expandHome(cfg.d1.python);
  cfg.d1.modelPath = expandHome(cfg.d1.modelPath);
  return cfg;
}
