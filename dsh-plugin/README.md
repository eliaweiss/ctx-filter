# Context filter for DeepSeek Harness

A DSH plugin that cuts mid-size tool results down to what the agent needs for its current step.

DSH already caps a single tool result at 12,500 tokens with a blind head + tail cut. This plugin works
below that cap: a text result between **2,000** and **12,500** tokens (both configurable) is reduced to

- the first and last lines,
- lines that look like errors or failures,
- the passages Jev judges relevant to the agent's current step,

within a budget (default 30% of the result). The full result is saved to DSH's spill folder and a footer
tells the agent what was kept and where the rest is. Any failure (Jev down, timeout, bad key) passes the
original result through unchanged.

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
  saving, exact Jev cost, net saving, delay added (avg, p50, p95), follow-ups (the agent opened the saved
  full result: a likely miss), Jev failures, sessions affected and their compactions, reasons results
  were not filtered, and per-tool and per-day tables.
- **Recent results**: the last 60 filtered, shadow, failed or no-gain results with their want.

**Shadow mode** judges and logs what would be cut but passes everything through, so the cut can be
measured before it is trusted.

Raw data: `~/.ctx-filter/dsh/events.jsonl`, one JSON line per tool result (`kind: "result"`, with `action`
`filtered | shadow | small | over-cap | excluded | file-print | no-gain | jev-error | non-text | no-session`)
and per follow-up (`kind: "followup"`). The same numbers are served as JSON at
`GET /ctx-filter/api/stats?days=30` on the DSH web server.

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
