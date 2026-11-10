// Read a DSH session's committed events from its file on disk, for sessions the live Session service no
// longer holds. DSH appends one zstd frame per write to `session.v4.jsonl.zstd`; Node's one-shot decoder
// stops after the first frame, so the file is split at frame magics and each frame decoded on its own.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import zlib from "node:zlib";

export const SESSIONS_DIR = process.env.CTX_FILTER_DSH_SESSIONS ?? join(homedir(), ".dsh", "sessions");
const FILES = ["session.v4.jsonl.zstd", "session.v4.jsonl"];
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Decode every zstd frame in `buf`. A magic that occurs inside compressed data fails to decode and is merged into the next piece; an incomplete last frame (a write in progress) is dropped. */
export function decodeZstdFrames(buf) {
  if (typeof zlib.zstdDecompressSync !== "function") throw new Error("zstd is not available in this Node");
  const starts = [];
  for (let i = buf.indexOf(MAGIC); i >= 0; i = buf.indexOf(MAGIC, i + 1)) starts.push(i);
  if (starts.length === 0) return "";
  const out = [];
  let from = starts[0];
  for (let k = 1; k <= starts.length; k++) {
    const end = k < starts.length ? starts[k] : buf.length;
    try {
      out.push(zlib.zstdDecompressSync(buf.subarray(from, end)));
      from = end;
    } catch {
      // keep `from`: this piece continues past the next magic
    }
  }
  return Buffer.concat(out).toString("utf8");
}

export function parseJsonl(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // torn line
    }
  }
  return out;
}

export function findSessionFile(sid, root = SESSIONS_DIR) {
  if (!sid || /[/\\]|\.\./.test(sid) || !existsSync(root)) return undefined;
  for (const ws of readdirSync(root)) {
    for (const name of FILES) {
      const p = join(root, ws, sid, name);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const cache = new Map(); // path -> { mtimeMs, size, events }

/** Events of a session read from disk, or undefined when the file is missing or unreadable. */
export function readSessionEventsFromDisk(sid, root = SESSIONS_DIR) {
  try {
    const p = findSessionFile(sid, root);
    if (!p) return undefined;
    const st = statSync(p);
    const hit = cache.get(p);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.events;
    const buf = readFileSync(p);
    const text = p.endsWith(".zstd") ? decodeZstdFrames(buf) : buf.toString("utf8");
    const events = parseJsonl(text);
    cache.set(p, { mtimeMs: st.mtimeMs, size: st.size, events });
    return events.length > 0 ? events : undefined;
  } catch {
    return undefined;
  }
}
