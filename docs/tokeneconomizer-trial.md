# TokenEconomizer trial: context for the coding agent

The user installed a DSH port of Microsoft's TokenEconomizer on 2026-11-08 to see
whether it saves tokens. Read this when the user asks whether it saved anything,
whether it's worth keeping, or how it is set up. Everything here was set up and
checked in a DSH session on 2026-11-08.

**The user's expectation:** he doesn't expect a real difference. He only wants to
know whether there is a big drop. ctx-filter, his own plugin in this repo, went
in one day earlier and he accepts that its effect is mixed in. Don't propose
controlled A/B designs unless he asks. He was explicitly put off by that
complexity.

**How to answer him:** short and plain. Give the number, what it means, and a
keep/remove suggestion. No jargon (CI, bootstrap, arms) unless he asks.

## Timeline

| When (UTC) | What |
| --- | --- |
| 2026-11-07 13:40 | ctx-filter (`dsh-ctx-filter`, this repo) added to the DSH `desktop` profile. It also lowers prompt tokens, which confounds the comparison. |
| 2026-11-08 13:40 | `dsh-tokeneconomizer@0.1.0` installed into the `desktop` profile. Briefly configured as zooly2-only. |
| 2026-11-08 14:16:07 | Switched to **on for every project**, stock code. **This is the cutoff for before/after.** |
| 2026-11-16 | Planned first check (one week). |

## What is installed

- **Package:** `dsh-tokeneconomizer@0.1.0` from npm, unmodified (verified identical
  to the npm tarball). Code in
  `~/.dsh/profiles/desktop/node_modules/dsh-tokeneconomizer/`.
  - Repo: <https://github.com/lksa09871234/dsh-tokeneconomizer>
  - npm: <https://www.npmjs.com/package/dsh-tokeneconomizer>
- **Profile:** `desktop` (`~/.dsh/profiles/desktop/`), which the Web GUI uses. It is
  listed in `package.json` under `dsh.profile.bundles`.
- **Config:** an entry at the end of `~/.dsh/profiles/desktop/cordis.patch.yml`:

  ```yaml
  - id: tokeneconomizer
    name: dsh-tokeneconomizer
    config:
      microskills: envfacts
  ```

  Effective settings: `microskills=envfacts` (deterministic, no model calls),
  `toolprune=propose` (suggests only, hides nothing until applied),
  `loopguard=on`, `loopguardJudge=true`. Everything else is default.
- **No per-project overrides.** zooly2's `project.json` has `"config": {}`.
- **Plugin state:** `~/.dsh/tokeneconomizer/`
  - `plugin-load.json`: last load time and config. Check it to confirm the plugin
    is loaded.
  - `projects/<hash>/`: `project.json` (label, `cwdDisplay`), `microskills.json`,
    `toolprune.json`, `envelope.json`, `folded.json`, `ledger.jsonl` (one row per
    session, with `sessionId`, usage, and overhead fields), `diagnostics.jsonl`.
- **Writes nothing into project folders.** The project root is found by walking up
  to the nearest `.git`, so each worktree (`~/work/zooly2-*`) is its own project.

### Inspecting it

```sh
TE=~/.dsh/profiles/desktop/node_modules/dsh-tokeneconomizer/bin/te.js
node $TE --cwd <project> status [--json]   # facts learned, pruning evidence, loop-guard state, ledger totals
node $TE --cwd <project> toolprune          # suggested / applied tool list
node $TE --cwd <project> microskills        # learned facts
node $TE --cwd <project> usage              # recorded tokens + plugin overhead
node $TE --cwd <project> diagnostics        # plugin errors
```

The same commands exist in chat as `/tokeneconomizer <cmd>`. Note that the CLI
ignores the profile layer: `config show` prints package defaults
(`microskills = "off"`), not the profile's `envfacts`. `plugin-load.json` shows
the real loaded config.

### How it can affect tokens

| Mechanism | Effect | When it starts |
| --- | --- | --- |
| Micro-skills (`envfacts`) | Adds a small note to the system prompt: at most 4 facts / 600 chars, once per session. Slightly *more* prompt tokens. Saves only if it prevents wasted steps. | A fact needs confirmation in 3 sessions, the repo needs at least 4 sessions, and the hit rate must be at least 0.4. |
| Tool pruning | Removes unused tool definitions from every request. Probably the biggest possible saver. | Only after `toolprune apply`. In `propose` mode it saves **nothing**. A proposal needs a tool unused for 10 prompts over 2 or more sessions (or 5 sessions). It takes effect from the next session. |
| Loop guard | At most 1 redirect message per stuck turn. Never cancels. | After 5 normal turns in that project. |
| Judge (overhead) | A model call through the session's own route, so it costs tokens. Counted in the ledger as `spiral_judge_tokens` / `spiral_nudge_writer_tokens`. | Only on suspected loops, at most once per 2 minutes. |

When reporting, check whether tool pruning was ever applied
(`toolprune` → `applied`). If not, say so: the main saver was never active.

## Measuring: `~/work/te-compare/compare.mjs`

A read-only script that writes nothing except `--csv`.

```sh
node ~/work/te-compare/compare.mjs --model claude-opus-5-5          # all projects
node ~/work/te-compare/compare.mjs --model claude-opus-5-5 --project ~/work/zooly2
node ~/work/te-compare/compare.mjs --model claude-opus-5-5 --csv /tmp/te.csv   # one row per session
```

Defaults: `--project all`, `--cutoff 2026-11-08T14:16:07Z`, baseline = 30 days
before the cutoff (`--baseline-days`, `--baseline-from`), `--min-steps 2`, and
`--model auto` (the most common model after the cutoff). It needs the `zstd` CLI
(`/opt/homebrew/bin/zstd`). It takes about 5 s.

**What it does:**
- Reads `~/.dsh/sessions/<--path-with-dashes-->/<session>/session.v4.jsonl.zstd`.
  These files are many zstd frames appended together; `node:zlib` only decodes
  the first frame, which is why the script uses the CLI.
- Usage comes from `assistant/message` events: `data.usage.{inputTokens,
  cacheReadTokens, cacheWriteTokens, outputTokens}`. The model is
  `data.message.source.model`. User turns are counted from `turn/start`.
- Session headers have `parentSession` / `delegationDepth`. Subagent usage is
  rolled into the root session. Side chats (`subchat-*`, from dsh-side-chat-plus)
  are excluded.
- Plugin overhead is read from every `ledger.jsonl` and added to the "after"
  side.
- **Weighted tokens** = input×1 + cacheWrite×1.25 + cacheRead×0.1 + output×5,
  roughly a bill-proportional figure in input-token units (`--weights` to change).
- Reports the median [p25–p75] per side, the change in medians, and a bootstrap
  95% range of the ratio.

**Baseline** (computed 2026-11-08, sessions 2026-10-09 to 2026-11-08 14:16 UTC,
all projects, at least 2 steps):

| Model | Sessions | Weighted tokens / step | Prompt tokens / step | Steps / session | Cache hit |
| --- | --- | --- | --- | --- | --- |
| claude-opus-5-5 | 81 | 28.4k [22.2k–39.4k] | 156k | 51 | 95.8% |
| zai/glm-5.3-flashx | 82 | 17.2k [14.4k–20.1k] | 93k | 37.5 | 96.3% |
| deepseek/deepseek-v4.1-flash-1017 | 39 | 16.2k [13.4k–20.5k] | 90k | 40 | 95.8% |

The current default model is `claude-opus-5-5` (provider anthropic). Always
compare a single model; models differ about 2× in tokens per step.

**Known confounders** (mention them briefly, don't dwell):
- ctx-filter was active for only the last ~1 day of the baseline but for all of
  "after".
- The work differs from week to week: zooly2 Opus sessions in the last day
  before the cutoff ran at about 38.6k weighted tokens per step, against 27k over
  30 days.
- Use **weighted tokens / step** as the main number; per-session totals vary
  about 10× with the task. Also check that steps and turns per session didn't
  go up.
- With about 96% cache hits, most prompt tokens are already billed at about 10%,
  which limits any possible saving.

**Interpretation guide for the user:**

| Weighted tokens / step | Say |
| --- | --- |
| −15% or better, 95% range entirely below 0 | Real saving. Probably worth keeping (some of it may be ctx-filter). |
| Between about −15% and +5%, or the range crosses 0 | No clear effect. |
| Worse, or noticeably more steps per session | Not helping. Suggest removing. |

Fewer than 10 "after" sessions for the model: say it's too early.

Reference points: Microsoft reports −18 to −31% for its own plugin on
Claude Code, Codex and Copilot (SWE-Bench). The other DSH port measured −6.6%
prompt tokens per step in one test. The installed port claims no number.

## Background

**Microsoft TokenEconomizer** ("Experience-Driven Black-Box Cost Control for Coding
Agents", Microsoft Research + UC Berkeley):
<https://github.com/microsoft/TokenEconomizer>, paper
<https://arxiv.org/abs/2610.22732>, project page
<https://tokeneconomizer.github.io/>. Three mechanisms: micro-skills, tool
pruning, and failure-loop intervention. It supports Claude Code, Codex, Copilot
CLI and Pi (experimental: opencode, Cursor, Grok Build, Hermes, Antigravity). It
has **no DSH plugin**. Its Python core is in `tokeneconomizer/`.

**DSH ports** (both community-made, about a week old, almost no users):
- **lksa09871234/dsh-tokeneconomizer** (installed): a JavaScript rewrite with
  343 unit and 10 integration tests. Listed on
  [awesome-dsh-plugin](https://awesome-dsh-plugin.com/p/lksa09871234/dsh-tokeneconomizer/),
  [dshhub.co](https://www.dshhub.co/zh/plugin/lksa09871234/dsh-tokeneconomizer)
  and dsh-plugin.org. It adds a usage ledger. Its
  [MEASUREMENT.md](https://github.com/lksa09871234/dsh-tokeneconomizer/blob/main/docs/MEASUREMENT.md)
  claims no savings.
- **Mng12345/dsh-tokeneconomizer**: 0.2.0, GitHub only, 2 commits. It claims
  −6.6% prompt tokens per step from 24 paired runs.

### Pitfalls found in 0.1.0 (in case per-project setup comes up again)

The user first asked for zooly2-only, then decided he wants it everywhere. All
local patches were **reverted**. If per-project settings are ever needed:

1. `recordProject()` in `lib/dsh/project-runtime.js` rewrites `project.json`
   without its `config` key every time a project opens, so **per-project
   overrides (`config set`) are wiped**.
2. `apply()` in `lib/index.js` returns early when the profile has
   `enabled: false`, so a project override `enabled=true` can never turn it on.
3. `ProjectRuntime` caches overrides in memory, so a `te config set` from a
   terminal only takes effect after a DSH restart (the chat `/tokeneconomizer
   config set` updates memory).

To reload the plugin after a config or code change without restarting DSH, turn
the bundle off and on again: `plugin_manager set_bundle dsh-tokeneconomizer`
false, then true. It loads in the host process.

## Removing it

```sh
dsh plugin --profile desktop remove dsh-tokeneconomizer   # or plugin_manager remove_bundle
# then delete the `tokeneconomizer` entry at the end of ~/.dsh/profiles/desktop/cordis.patch.yml
rm -rf ~/.dsh/tokeneconomizer
```
