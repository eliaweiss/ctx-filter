// Replay real mid-size tool results from past DSH sessions through the filter (live Jev), with the want
// built from each session's own history, and check whether what the agent used next survived the cut.
import { execFileSync } from "node:child_process";
import { readdirSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildWant, estimateTokens, isExcluded, isFilePrint, makePassages, renderKept, selectLines, splitLines } from "../lib/core.js";
import { judgePassages } from "../lib/jev.js";
import { Config } from "../index.js";

const cfg = (() => { const c = Config({}); const o = {}; for (const k of Object.keys(Config.dict)) o[k] = c[k]?.get ? c[k].get() : c[k]; return o; })();
const perTool = Number(process.argv[2] ?? 3);
const root = join(homedir(), ".dsh", "sessions");
const files = [];
for (const ws of readdirSync(root)) for (const s of readdirSync(join(root, ws))) {
  const f = join(root, ws, s, "session.v4.jsonl.zstd");
  if (existsSync(f) && !s.includes("e9ecf9bf")) files.push(f);
}
const cands = [];
for (const f of files) {
  let raw;
  try { raw = execFileSync("zstd", ["-dc", f], { maxBuffer: 1 << 30 }).toString(); } catch { continue; }
  const events = raw.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const calls = new Map();
  events.forEach((e, i) => {
    if (e.type === "tool/call") calls.set(e.data.callId, e.data);
    if (e.type !== "tool/result" || e.data?.sourceEventSeqs) return;
    const m = e.data.message; const c = calls.get(m?.toolCallId);
    if (!c || m.isError) return;
    const text = (m.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    if ((m.content ?? []).some((b) => b.type !== "text")) return;
    const tok = estimateTokens(text);
    if (tok <= cfg.minTokens || tok > cfg.maxTokens || /Full formatted result stored at/.test(text)) return;
    if (isExcluded(c.name, cfg.excludedTools)) return;
    let args = {}; try { args = JSON.parse(c.arguments); } catch {}
    if (c.name === "bash" && isFilePrint(args.command)) return;
    // the agent's next text after this result
    let next = "";
    for (let j = i + 1; j < events.length && !next; j++) if (events[j].type === "assistant/message") next = (events[j].data.message.content ?? []).filter((b) => b.type === "text" || b.type === "reasoning").map((b) => b.text).join("\n");
    cands.push({ file: f, tool: c.name.startsWith("mcp__") ? c.name.split("__").slice(0, 2).join("__") : c.name, name: c.name, args, callId: c.callId, text, tok, history: events.slice(Math.max(0, i - 600), i), next });
  });
}
// a deterministic spread: newest few per tool
const byTool = new Map();
for (const c of cands.reverse()) { const l = byTool.get(c.tool) ?? []; if (l.length < perTool) l.push(c); byTool.set(c.tool, l); }
const picked = [...byTool.values()].flat();
console.error(`${cands.length} eligible results; replaying ${picked.length}`);
const distinct = (s) => new Set((s.match(/[A-Za-z_][\w./:-]{5,}|\b\d[\d,.:]{2,}\b/g) ?? []).filter((w) => !/^(https?|the|this|that)/i.test(w)));
const rows = [];
for (const c of picked) {
  const lines = splitLines(c.text);
  const passages = makePassages(lines);
  const want = buildWant({ toolName: c.name, args: c.args, callId: c.callId, events: c.history }, cfg);
  let probs = new Map(), usage, err;
  const t0 = Date.now();
  try { const r = await judgePassages({ want: want.text, source: c.name, passages, cfg }); probs = r.probs; usage = r.usage; } catch (e) { err = String(e.message ?? e); }
  const ms = Date.now() - t0;
  const rel = [...probs.values()].filter((p) => p >= cfg.relevanceThreshold).length;
  const share = probs.size ? rel / probs.size : 0;
  const sel = selectLines(lines, passages, probs, cfg);
  const kept = renderKept(lines, sel.keep);
  const action = err ? "jev-error" : share * 100 >= cfg.passThroughRelevantPercent ? "mostly-relevant" : estimateTokens(kept) > c.tok * 0.8 ? "no-gain" : "filtered";
  const out = action === "filtered" ? kept : c.text;
  // details the agent used next that came from this output
  const used = [...distinct(c.next)].filter((w) => c.text.includes(w));
  const lost = used.filter((w) => !out.includes(w));
  rows.push({ tool: c.name, tokens: c.tok, action, keptTokens: estimateTokens(out), relevant: `${rel}/${probs.size}`, ms, cost: usage?.costUsd ?? 0, used: used.length, lost: lost.length, lostSample: lost.slice(0, 6), wantParts: want.parts, cmd: (c.args.command ?? c.args.url ?? c.args.pattern ?? JSON.stringify(c.args)).slice(0, 90), err });
}
writeFileSync("/tmp/cfx-replay.json", JSON.stringify(rows, null, 2));
for (const r of rows) console.log(`${r.action.padEnd(15)} ${r.tool.slice(0, 34).padEnd(34)} ${String(r.tokens).padStart(6)} → ${String(r.keptTokens).padStart(6)}  rel ${r.relevant.padStart(7)}  used ${r.used} lost ${r.lost} ${r.lost ? JSON.stringify(r.lostSample) : ""}  ${r.ms}ms $${r.cost.toFixed(5)}  | ${r.cmd}${r.err ? " ERR " + r.err : ""}`);
