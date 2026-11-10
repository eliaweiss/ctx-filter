# Context filter for DeepSeek Harness

A DSH plugin that cuts mid-size tool results down to what the agent needs for its current step.

DSH already caps a single tool result at 12,500 tokens with a blind head + tail cut. This plugin works
below that cap: a text result between **2,000** and **12,500** tokens (both configurable) is reduced to

- the first and last lines, measured in characters (default 400 and 800, whole lines only), so long
  lines in diffs or JSON do not use up the budget,
- lines that look like errors or failures,
- the passages Jev judges relevant to the agent's current step,

within a budget (default 90% of the result). When Jev judges at least 45% of the passages relevant
(configurable), the result is mostly signal and passes through whole. It also passes through whole when a
passage Jev judges relevant does not fit in the budget, since the cut would then drop content the agent wants. The full result is saved to DSH's spill folder and a footer
tells the agent what was kept and where the rest is. Any failure (Jev down, timeout, bad key) passes the
original result through unchanged.

Never filtered: results of `read`, `skill`, `plugin_manager`, `grep` and `glob` (configurable); bash
commands that print files or diffs (`cat`, `sed -n`, `head`, `tail`, `git diff`, `git show`); and any call
whose arguments name a file in DSH's spill folder, since the agent is then reading a full result that was
already cut or spilled.

## Web page cleanup

Before any of that, a `web_fetch` result is cleaned of page clutter by rules, at any size and without Jev:

- search redirect links are decoded to the real address (DuckDuckGo `/l/?uddg=`, Bing `/ck/a?…&u=a1…`),
- favicons, empty-alt images, empty links and `javascript:`/`#` link wrappers are dropped (footnote
  markers keep their brackets),
- a line whose links all repeat earlier ones loses the repeated address; its text stays,
- on DuckDuckGo and Bing pages, the bold on query terms and DuckDuckGo's region and date pickers go.

Text is never removed, code blocks and inline code are left exactly as they are, JSON bodies are not
touched, and a redirect that does not decode to an http(s) address is left as it was. The cleaned page is
used only when it is at least 10% smaller (configurable); otherwise the page passes on exactly as fetched.
The original page is saved to DSH's spill folder and a one-line note names it. A cleaned page still over the
threshold then goes through the Jev cut as usual, from the cleaned text.

On saved results this cuts DuckDuckGo and Bing result pages by 57–68%, and articles, READMEs and JSON by
0–4% (so those usually stay as fetched). The event log records it as `decluttered` (with the reason the
page was not cut further) or, when Jev cut it too, as `filtered` with a `declutter` field. Opening the
original page later counts as a reopen, like opening a cut result.

## How the "want" is built

Jev is not told a `want` written by the agent. The plugin builds it from the session, each part switchable:

1. the tool call and its arguments,
2. the call's `description`,
3. what the agent wrote and reasoned in the step that made the call,
4. the user's latest request,
5. the recent conversation (default 2,000 tokens, tool results excluded).

The composed want is stored with each event (switchable) and shown under **Recent results**.

## Settings and statistics

**Settings → Context filter** (also on the Plugins page, under this bundle):

- **Settings**: every option, saved immediately to the profile (`cordis.patch.yml`, entry `ctx-filter`).
- **Statistics** for the last 1/7/30/90/365 days: results filtered, tokens kept out, re-sent tokens avoided
  (tokens kept out × model requests that followed, until the next compaction), estimated main-model
  saving, exact Jev cost, re-read cost, net saving, delay added (avg, p50, p95), reopened cuts (the agent
  opened the saved full result: a likely miss), Jev failures, sessions affected and their compactions,
  reasons results were not filtered, and per-tool and per-day tables with re-read cost and net.
  **Reset statistics** moves the log aside to `events-archive-<date>-<time>.jsonl` next to it (nothing is
  deleted) and counting starts again.
- **Recent results**: the last 60 filtered, shadow, failed or no-gain results with their want and, for
  cuts, their own net (saving − re-read cost − Jev).

### Re-read cost and net saving

A cut the agent reopens costs more than it saved. Without the filter, neither of these happens:

- **The extra model request** that issued the re-read. It is priced from the usage DSH recorded on that
  request (uncached input, cache read, cache write, output, at the four prices under Settings). If the
  request made several tool calls, its cost is split evenly between them.
- **The re-read result**: paid once at the uncached price, then at the cached price on every later
  request until a compaction.

The cut's own saving no longer counts the re-read request, since that request would not exist.
**Net saving = main-model saving − Jev cost (every run, pass-throughs included) − re-read cost.**

Session events come from the live Session service. Failing that, they are read from the session file under
`~/.dsh/sessions` (DSH appends one zstd frame per write). When a session or a request's usage still
cannot be read, the average of the measured cases is used, and the tile says how many values were
estimated. Re-running the original command instead of reading the saved file is not detected, so the
re-read cost is a lower bound.

**Shadow mode** judges and logs what would be cut but passes everything through, so the cut can be
measured before it is trusted.

Raw data: `~/.ctx-filter/dsh/events.jsonl`, one JSON line per tool result (`kind: "result"`, with `action`
`filtered | shadow | small | over-cap | excluded | file-print | saved-read | no-gain | mostly-relevant | relevant-overflow | nothing-relevant | jev-error | non-text | no-session`)
and per follow-up (`kind: "followup"`). The same numbers are served as JSON at
`GET /ctx-filter/api/stats?days=30` on the DSH web server; `POST /ctx-filter/api/stats/reset` with header
`x-ctx-filter: reset` resets them.

## Jev

Model `typesafe-ai/jev-1.14.0` through the Vercel AI Gateway, zero data retention. The key comes from
`AI_GATEWAY_API_KEY`, else the configured command, else `jev.apiKeyCommand` in `~/.ctx-filter/config.json`
(the macOS Keychain lookup). Passages are about 600 characters and 15 lines; one request usually covers
a whole result.

## Development

```sh
pnpm install
npm test          # unit and pipeline tests, Jev stubbed
npm run check     # syntax
```

Installed with `plugin_manager install_bundle` from this directory (linked). Settings changes apply live.
**Code changes to the Host half (`index.js`, `lib/`) need a DSH restart**; DSH keeps the module it loaded.

## Known limits

- The want reads recent session events with `Session.snapshotEvents()`, which DSH marks deprecated for new
  code in favour of session projections. It works in 0.2.2-rc.1.
- The statistics route has no authentication of its own; DSH binds the web server to 127.0.0.1.
- Token counts are DSH's estimate, 4 characters per token.
- Error lines are matched by a regex; words inside paths and identifiers (`errors.js`) are ignored.
