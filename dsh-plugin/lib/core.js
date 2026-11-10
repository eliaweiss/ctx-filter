// Pure parts of the context filter: token estimate, passages, want, selection, rendering.
// No DSH or network dependency, so everything here is unit-tested directly.

/** DSH's own estimate: about 4 characters per token. */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

export function splitLines(text) {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * Line-aligned passages of about `targetChars` characters, preferring to cut on blank lines.
 * Each passage: { index, start, end } with 0-based inclusive line indices, plus its text.
 */
export function makePassages(lines, targetChars = 600, maxLines = 15) {
  const passages = [];
  let start = 0;
  let size = 0;
  const flush = (end) => {
    if (end < start) return;
    passages.push({ index: passages.length, start, end, text: lines.slice(start, end + 1).join("\n") });
    start = end + 1;
    size = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const len = (lines[i] ?? "").length + 1;
    const count = i - start;
    if (count > 0 && (size + len > targetChars || count >= maxLines)) flush(i - 1);
    size += len;
    // A blank line after a reasonably sized block is a natural boundary.
    if ((lines[i] ?? "").trim() === "" && size >= targetChars / 2) flush(i);
  }
  flush(lines.length - 1);
  return passages;
}

// Words count only outside paths and identifiers: `errors.js` or `on-error/` is not an error line.
export const ERROR_WORDS =
  /(?<![\w./-])(error|errors|failed|failure|fatal|exception|traceback|panic|assert(ion)?(error)?|denied|refused|timed? ?out|not found|cannot|can't|unable to|segfault|non-zero|exit code [1-9])(?![\w/-]|\.\w)|✘|✗|\bFAIL(ED)?\b|ERR!|^\s*E\s{2,}/i;
const ERROR_TYPES = /\b[A-Z]\w*(Error|Exception)\b/;
export const ERROR_LINE = { test: (s) => ERROR_WORDS.test(s) || ERROR_TYPES.test(s) };

export function errorLineIndices(lines, max = 40) {
  const out = [];
  for (let i = 0; i < lines.length && out.length < max; i++) if (ERROR_LINE.test(lines[i] ?? "")) out.push(i);
  return out;
}

/** Commands that print files the agent asked to read whole (usually right before editing them). */
export const FILE_PRINT =
  /(^|[;&|]\s*|\bcd\s+\S+\s*&&\s*)(cat|nl|head|tail|less|bat|sed\s+-n|awk\s+'NR)\b|\|\s*(head|tail)\b|\bsed\s+-n\s+['"]?\d/;

/** `git diff` and `git show`, with any global options (`-C dir`, `-c k=v`, `--no-pager`): a diff is read whole. */
export const GIT_DIFF = /\bgit(?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?))*\s+(?:diff|show)\b/;

export function isFilePrint(command) {
  return typeof command === "string" && (FILE_PRINT.test(command) || GIT_DIFF.test(command));
}

/** DSH's spill folder, where full results (DSH's own and this plugin's) are stored. */
export const SPILL_PATH = /[\\/]dsh-spill-[^\\/\s"']+[\\/]/;

/**
 * True when the call's arguments name a saved full result: the agent is reading what was cut, or what
 * DSH's cap spilled, so cutting again would only send it back for the same file.
 */
export function readsSavedResult(argsText, locators) {
  if (typeof argsText !== "string" || argsText === "") return false;
  if (SPILL_PATH.test(argsText)) return true;
  for (const loc of locators ?? []) if (loc && argsText.includes(loc)) return true;
  return false;
}

/** A tool name matches an exclusion entry exactly, or by prefix when the entry ends with `*`. */
export function isExcluded(toolName, excluded) {
  for (const e of excluded ?? []) {
    if (!e) continue;
    if (e.endsWith("*") ? toolName.startsWith(e.slice(0, -1)) : toolName === e) return true;
  }
  return false;
}

function textOf(content) {
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

function clip(s, max, fromEnd = false) {
  if (s.length <= max) return s;
  return fromEnd ? "…" + s.slice(s.length - max) : s.slice(0, max) + "…";
}

function parseArgs(raw) {
  if (raw && typeof raw === "object") return raw;
  if (typeof raw !== "string") return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

/**
 * Build the want: what the agent needs from this tool result, from the session state.
 * Returns { text, parts } where parts names the sections that were included.
 */
export function buildWant({ toolName, args, callId, events }, opts) {
  const a = parseArgs(args);
  const sections = [];
  const parts = [];
  if (opts.wantToolCall) {
    const { description: _d, ...rest } = a;
    sections.push(`Tool call: ${toolName} ${clip(JSON.stringify(rest), 700)}`);
    parts.push("tool call");
  }
  if (opts.wantDescription && typeof a.description === "string" && a.description.trim()) {
    sections.push(`Call description: ${clip(a.description.trim(), 300)}`);
    parts.push("description");
  }
  const evs = Array.isArray(events) ? events : [];
  if (opts.wantAgentText) {
    let callMsg;
    for (let i = evs.length - 1; i >= 0 && !callMsg; i--) {
      const e = evs[i];
      if (e?.type !== "assistant/message") continue;
      const content = e.data?.message?.content;
      if (Array.isArray(content) && content.some((b) => b?.type === "tool-call" && b.id === callId)) callMsg = content;
    }
    if (callMsg) {
      const said = callMsg.filter((b) => b?.type === "text").map((b) => b.text).join("\n").trim();
      const thought = callMsg.filter((b) => b?.type === "reasoning").map((b) => b.text).join("\n").trim();
      if (said) sections.push(`Agent, just before this call: ${clip(said, 1200, true)}`);
      if (thought) sections.push(`Agent's reasoning for this step: ${clip(thought, 1200, true)}`);
      if (said || thought) parts.push("agent text");
    }
  }
  let lastUser;
  if (opts.wantUserPrompt || opts.wantRecentConversation) {
    for (let i = evs.length - 1; i >= 0 && lastUser === undefined; i--) {
      const e = evs[i];
      if (e?.type === "user/message" && e.data?.role === "user" && e.data?.source?.kind === "user") lastUser = i;
    }
  }
  if (opts.wantUserPrompt && lastUser !== undefined) {
    const t = textOf(evs[lastUser].data.content).trim();
    if (t) {
      sections.push(`User's latest request: ${clip(t, 1500)}`);
      parts.push("user prompt");
    }
  }
  if (opts.wantRecentConversation) {
    const budget = Math.max(0, (opts.recentConversationTokens ?? 2000) * 4);
    const pieces = [];
    let used = 0;
    for (let i = evs.length - 1; i >= 0 && used < budget; i--) {
      const e = evs[i];
      let line = "";
      if (e?.type === "assistant/message") {
        const t = (e.data?.message?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("\n").trim();
        if (t) line = `agent: ${t}`;
      } else if (e?.type === "user/message" && e.data?.role === "user" && e.data?.source?.kind === "user") {
        const t = textOf(e.data.content).trim();
        if (t) line = `user: ${t}`;
      }
      if (!line) continue;
      line = clip(line, budget - used, true);
      pieces.push(line);
      used += line.length;
    }
    if (pieces.length > 0) {
      sections.push(`Recent conversation (oldest first):\n${pieces.reverse().join("\n")}`);
      parts.push("recent conversation");
    }
  }
  return { text: sections.join("\n\n"), parts };
}

/**
 * Decide which lines to keep.
 * probs: Map<passageIndex, P(relevant)> (empty when relevance is off).
 * Returns { keep: Set<lineIndex>, reasons: {head, tail, errors, relevant}, relevantPassages, overflow }.
 */
export function selectLines(lines, passages, probs, opts) {
  const keep = new Set();
  const reasons = { head: 0, tail: 0, errors: 0, relevant: 0 };
  const totalChars = lines.reduce((a, l) => a + l.length + 1, 0);
  const budgetChars = Math.max(200, Math.floor((totalChars * opts.keepPercent) / 100));
  let used = 0;
  const add = (i) => {
    if (keep.has(i) || i < 0 || i >= lines.length) return false;
    keep.add(i);
    used += (lines[i] ?? "").length + 1;
    return true;
  };
  // Head and tail are measured in characters: with long lines (diffs, JSON) a line count would use up
  // the whole budget before any relevant passage gets in. A line that would pass the limit ends the run.
  const lineCost = (i) => (lines[i] ?? "").length + 1;
  if (opts.keepHead) {
    let size = 0;
    for (let i = 0; i < lines.length && size + lineCost(i) <= (opts.headChars ?? 0); i++) {
      size += lineCost(i);
      if (add(i)) reasons.head++;
    }
  }
  if (opts.keepTail) {
    let size = 0;
    for (let i = lines.length - 1; i >= 0 && size + lineCost(i) <= (opts.tailChars ?? 0); i--) {
      size += lineCost(i);
      if (add(i)) reasons.tail++;
    }
  }
  if (opts.keepErrors) {
    // Error lines may use at most half the budget, so relevant passages still get room.
    for (const i of errorLineIndices(lines)) {
      if (used >= budgetChars / 2) break;
      if (add(i)) reasons.errors++;
    }
  }
  let relevantPassages = 0;
  let overflow = 0;
  if (opts.keepRelevant && probs && probs.size > 0) {
    const ranked = [...probs.entries()]
      .filter(([, p]) => p >= opts.relevanceThreshold)
      .sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    for (const [idx] of ranked) {
      const p = passages[idx];
      if (!p) continue;
      let cost = 0;
      for (let i = p.start; i <= p.end; i++) if (!keep.has(i)) cost += (lines[i] ?? "").length + 1;
      if (used + cost > budgetChars) {
        overflow++;
        continue;
      }
      let added = 0;
      for (let i = p.start; i <= p.end; i++) if (add(i)) added++;
      reasons.relevant += added;
      relevantPassages++;
    }
  }
  return { keep, reasons, relevantPassages, overflow, budgetChars };
}

/**
 * Why a judged result should pass through whole instead of being cut, or null to cut it.
 * judged: passages Jev judged; judgedRelevant: of those, at or above the threshold; overflow: relevant
 * passages that did not fit the budget (from selectLines).
 */
export function passThroughAction({ judged, judgedRelevant, overflow, tokensKept, tokensBefore }, opts) {
  if (opts.keepRelevant && judged > 0) {
    if (judgedRelevant === 0 && opts.passThroughWhenNothingRelevant) return "nothing-relevant";
    if (opts.passThroughRelevantPercent < 100 && (judgedRelevant / judged) * 100 >= opts.passThroughRelevantPercent) return "mostly-relevant";
    if (opts.passThroughWhenRelevantDoesNotFit && overflow > 0) return "relevant-overflow";
  }
  if (tokensKept > tokensBefore * 0.8) return "no-gain";
  return null;
}

/** Kept lines in original order with markers for each omitted gap. */
export function renderKept(lines, keep) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (keep.has(i)) {
      out.push(lines[i]);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && !keep.has(j)) j++;
    const n = j - i;
    out.push(n === 1 ? `… [line ${i + 1} omitted]` : `… [lines ${i + 1}–${j} omitted, ${n} lines]`);
    i = j;
  }
  return out.join("\n");
}

export function footer({ linesBefore, linesAfter, tokensBefore, tokensAfter, reasons, relevantPassages, locator, originalLocator, shadow }) {
  const why = [];
  if (reasons.head) why.push("head");
  if (reasons.tail) why.push("tail");
  if (reasons.errors) why.push(`${reasons.errors} error lines`);
  if (relevantPassages) why.push(`${relevantPassages} passages judged relevant to the current step`);
  const where =
    (locator ? ` Full result: ${locator}. Use read with offset/limit, or grep this path, if you need an omitted part.` : "") +
    (originalLocator ? ` Page before clutter removal: ${originalLocator}.` : "");
  return `\n\n[context filter${shadow ? " (shadow)" : ""}] Kept ${linesAfter} of ${linesBefore} lines (~${tokensAfter.toLocaleString("en-US")} of ${tokensBefore.toLocaleString("en-US")} tokens): ${why.join(", ") || "nothing matched"}.${where}`;
}

/** Statistics: percentile of a numeric array. */
export function percentile(values, p) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
