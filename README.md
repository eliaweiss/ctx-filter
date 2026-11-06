# ctx-filter

Run a command, say what you want from its output, and get back only the passages a small decision model judges relevant. The full output stays on disk.

- Output of 4 KB or less comes back whole, with no model call.
- Larger output is stored in `~/.ctx-filter/outputs/<id>.log`, split into line-aligned passages of about 600 B, and each passage gets one yes/no question: *does this contain what `want` asks for?*
- Passages with P(yes) ≥ 0.5 come back **verbatim, whole, with line numbers**, up to 3 KB. Nothing is summarized or rewritten.
- The footer gives the id, the file path, and the tools to get more.

Two models, chosen in the config:

| `provider` | Model | Where it runs | Speed (measured on this Mac) |
|---|---|---|---|
| `jev` (default) | `typesafe-ai/jev-1.14.0` (or any gateway decision model, e.g. `liquid/d1`) | Vercel AI Gateway | 31 KB log, all 62 passages: 0.8 s · 153 KB git log, 278 passages: 1.5 s |
| `d1` | LiquidAI d1-2B, MLX 4-bit | Local daemon, data never leaves the Mac | about 2 passages/s, so it judges the best-ranked 12 KB: ~10 s |
| `none` | no model | — | keyword pre-rank only |

When the output is larger than the model's budget (`maxJudgeBytes`), a cheap pre-rank picks which passages to send. The pre-rank uses words of `want`, error/failure lines, summary lines, and the head and tail of the output. If the model fails or runs out of time (`judgeTimeoutMs`, 25 s), the reply falls back to the pre-rank and says so in a `note:` line.

## Install

```bash
cd ~/work/ctx-filter && pnpm install && pnpm build
```

### Config: `~/.ctx-filter/config.json`

Every field is optional. These are the defaults:

```json
{
  "provider": "jev",
  "jev": { "model": "typesafe-ai/jev-1.14.0", "apiKeyEnv": "AI_GATEWAY_API_KEY", "concurrency": 4, "maxJudgeBytes": 262144 },
  "d1":  { "python": "~/models/d1-bench/.venv/bin/python", "modelPath": "~/models/d1-2B-MLX-4bit", "maxJudgeBytes": 12288, "idleMinutes": 30 },
  "threshold": 0.5,
  "triggerBytes": 4096,
  "returnBytes": 3000,
  "chunkBytes": 600,
  "judgeTimeoutMs": 25000,
  "retentionDays": 7
}
```

Env overrides: `CTX_FILTER_PROVIDER=jev|d1|none`, `CTX_FILTER_JEV_MODEL`, `CTX_FILTER_THRESHOLD`, `CTX_FILTER_CONFIG` (another config file). The MCP tools also take a per-call `provider`.

`jev` reads `AI_GATEWAY_API_KEY`. If it is unset, it runs `jev.apiKeyCommand` once per process and uses its output. This matters for hosts that start MCP servers with a scrubbed environment (DSH). For example, with the key in the macOS Keychain:

```json
{ "jev": { "apiKeyCommand": "/usr/bin/security find-generic-password -s 'Vercel AI Gateway' -a 'vercel-ai-gateway' -w" } }
```

Requests are sent with `zeroDataRetention: true`.

### DeepSeek Harness (DSH)

Add to the profile's `cordis.patch.yml` (e.g. `~/.dsh/profiles/desktop/cordis.patch.yml`):

```yaml
- insert:
    - id: mcp-ctx-filter
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: ctx-filter
        transport: stdio
        command: /opt/homebrew/bin/node
        args:
          - /Users/eliaweiss/work/ctx-filter/dist/server.js
        toolCallTimeoutMs: 900000
        failOnStartupError: false
        env:
          PATH: /opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
```

DSH has no Bash hook, so the instruction in `~/.dsh/AGENTS.md` (below) is what makes the model use `run`.

`d1` starts `python/d1_server.py` on first use. The daemon keeps the model loaded, listens on `~/.ctx-filter/d1.sock`, logs to `~/.ctx-filter/d1.log`, and exits after 30 idle minutes. To start it ahead of time: `node dist/cli.js d1-start`.

### MCP server (Claude Code)

```bash
claude mcp add ctx-filter --scope user -e AI_GATEWAY_API_KEY="$AI_GATEWAY_API_KEY" -- node ~/work/ctx-filter/dist/server.js
```

| Tool | Use |
|---|---|
| `run({command, want, cwd?, timeout_ms?, provider?})` | Run a command and get the relevant passages. |
| `filter({id \| path, want, provider?})` | Ask a new question about a stored output, or filter a large file. |
| `read_output({id, from_line, to_line})` | Read exact lines from a stored output (16 KB cap). |
| `grep_output({id, pattern, context?, max_matches?})` | Regex search a stored output. |

### Bash hook (optional, Claude Code)

The hook also filters the agent's normal `Bash` calls. Their `description` serves as the `want`. Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "Bash", "hooks": [ { "type": "command", "command": "node ~/work/ctx-filter/dist/hook.js", "timeout": 60 } ] }
    ]
  }
}
```

The hook never breaks a call: on any error it prints nothing, and the original output stays. Don't run it alongside context-mode's Bash replace; both would rewrite the same output.

### Tell the agent (CLAUDE.md / AGENTS.md)

```md
For commands that may print more than ~50 lines (tests, builds, installs, logs, git log/diff, curl, CLI JSON),
use the ctx-filter `run` tool and state precisely what you need in `want`.
If a reply says a passage did not fit or nothing was judged relevant, use `filter`, `grep_output` or `read_output` before concluding.
```

## CLI

```bash
node dist/cli.js run  --want "which tests failed, with error and file:line" -- npx playwright test
node dist/cli.js file app.log --want "every 5xx request and its path" --provider d1
node dist/cli.js config
```

## Logs and stats

Every MCP call and every hook replacement appends one line to `~/.ctx-filter/events.jsonl`. Each line records the host, tool, command, want, raw and returned sizes, passages judged and kept, command time, filter time, model time, model tokens, the exact gateway cost, and failure flags. CLI `run`/`file` calls are not logged, so manual tests stay out of session stats.

```bash
node dist/cli.js stats --since 13:10 --timeline     # or --since 30m, --until …, --client dsh-mcp-client
```

The report covers:

- **Context:** net estimated tokens saved (4 characters per token, as DSH estimates). The baseline is what the host would have shown without ctx-filter: the raw output, capped at the host's own limit (`--cap`, default 12,500 tokens, DSH's `spill-policy.maxInlineTokens`). From that it subtracts the replies, the extra arguments (`want`, `cwd`), every follow-up call (`filter` by id, `read_output`, `grep_output`), and the fixed cost of the tool definitions plus the ctx-filter instruction section (× `--sessions`).
- **Cost:** the exact gateway charge for each Jev call.
- **Delay:** the filter time added per output (p50/p95/max), the time spent waiting on the model, and the follow-up count. Each follow-up also costs an extra agent turn, which the report counts but cannot time.
- **Failures:** failed calls, model unavailable (the cheap pre-rank was used instead), model out of time, nothing judged relevant, relevant passages that didn't fit, and the share of filtered outputs that needed a follow-up (a rough miss rate).

After rebuilding, change `CTX_FILTER_BUILD` in the DSH patch entry so DSH restarts the server.

## Tests

```bash
pnpm test     # unit tests with a fake judge, plus the hook end to end
```
