// Line-aligned passages. A line longer than the target is split on its own, so no passage is unbounded.

export interface Chunk {
  index: number;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
  bytes: number;
}

export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function chunkText(text: string, targetBytes: number): Chunk[] {
  const lines = splitLines(text);
  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let bufBytes = 0;
  let start = 1;
  const flush = (end: number) => {
    if (buf.length === 0) return;
    const t = buf.join("\n");
    chunks.push({ index: chunks.length, startLine: start, endLine: end, text: t, bytes: Buffer.byteLength(t) });
    buf = [];
    bufBytes = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i] ?? "";
    const lb = Buffer.byteLength(line) + 1;
    if (lb > targetBytes) {
      flush(lineNo - 1);
      for (const piece of splitLongLine(line, targetBytes)) {
        chunks.push({ index: chunks.length, startLine: lineNo, endLine: lineNo, text: piece, bytes: Buffer.byteLength(piece) });
      }
      start = lineNo + 1;
      continue;
    }
    if (bufBytes + lb > targetBytes) {
      flush(lineNo - 1);
      start = lineNo;
    }
    if (buf.length === 0) start = lineNo;
    buf.push(line);
    bufBytes += lb;
  }
  flush(lines.length);
  return chunks;
}

/** Cut on a whole character, never inside a surrogate pair. */
function splitLongLine(line: string, maxBytes: number): string[] {
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (curBytes + b > maxBytes && cur !== "") {
      out.push(cur);
      cur = "";
      curBytes = 0;
    }
    cur += ch;
    curBytes += b;
  }
  if (cur !== "") out.push(cur);
  return out;
}
