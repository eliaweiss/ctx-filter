// Context filter, browser half: a Settings section (settings, statistics, recent results) and the same page
// on the Plugins page. Settings read and write the Host entry `ctx-filter` through configForms; statistics come
// from the Host route /ctx-filter/api/stats.
window.__ModuleLoader__.load({
  id: "dsh-ctx-filter",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useEffect, useState, useCallback } = React;
    const ENTRY = "ctx-filter";
    const NS = "ctxFilter";
    const PKG = "dsh-ctx-filter";

    const en = {
      nav: "Context filter",
      title: "Context filter",
      subtitle:
        "Cuts mid-size tool results down to what the agent needs for its current step, using Jev. Results above DSH's own cap and below the threshold are untouched.",
      summary: "Jev-based filtering of mid-size tool results, with statistics.",
      tabSettings: "Settings",
      tabStats: "Statistics",
      tabRecent: "Recent results",
      unavailable: "The context filter's Host plugin is not loaded, so its settings cannot be shown.",
      readOnly: "This deployment stores settings read-only.",
      saveFailed: "The Host did not accept that value.",
      loading: "Loading…",
    };

    const CSS = `
.cfx-root{color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px;padding-bottom:24px}
.cfx-head h2{font-size:16px;line-height:24px;font-weight:600;margin:0}
.cfx-sub{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-top:4px}
.cfx-tabs{display:flex;gap:4px;margin:16px 0 4px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.cfx-tab{background:none;border:0;border-bottom:2px solid transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;padding:8px 10px}
.cfx-tab[aria-selected=true]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary)}
.cfx-group{margin-top:20px}
.cfx-gtitle{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);text-transform:none;font-weight:600;margin-bottom:2px}
.cfx-row{border-bottom:.5px solid var(--dsw-alias-border-l2);display:flex;align-items:center;justify-content:space-between;gap:24px;padding:12px 0}
.cfx-rtitle{font-size:14px;line-height:20px}
.cfx-rdesc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin-top:2px}
.cfx-switch{position:relative;flex:none;width:36px;height:20px;border-radius:10px;border:0;cursor:pointer;background:var(--dsw-alias-border-l4);transition:background .15s}
.cfx-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.cfx-switch:disabled{opacity:.5;cursor:default}
.cfx-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s}
.cfx-switch[aria-checked=true]::after{transform:translateX(16px)}
.cfx-input{flex:none;width:120px;font:inherit;font-size:13px;padding:4px 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.cfx-input.wide{width:280px}
.cfx-input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}
.cfx-tools{display:flex;flex-wrap:wrap;gap:6px 14px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.cfx-tools label{display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer}
.cfx-note{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;margin:8px 0}
.cfx-error{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:8px 0}
.cfx-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px;margin-top:14px}
.cfx-tile{background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:10px 12px}
.cfx-tlabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px}
.cfx-tvalue{font-size:18px;line-height:26px;font-weight:600;margin-top:2px}
.cfx-tsub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px}
.cfx-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
.cfx-table th{color:var(--dsw-alias-label-tertiary);font-weight:600;text-align:left;padding:6px 8px 6px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.cfx-table td{padding:6px 8px 6px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);vertical-align:top}
.cfx-num{text-align:right;font-variant-numeric:tabular-nums}
.cfx-select{font:inherit;font-size:13px;padding:3px 6px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.cfx-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px}
.cfx-btn{font:inherit;font-size:12px;padding:3px 10px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l3);background:none;color:var(--dsw-alias-label-primary);cursor:pointer}
.cfx-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.cfx-want{white-space:pre-wrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-radius:6px;padding:8px;margin-top:6px;max-height:240px;overflow:auto}
.cfx-tag{display:inline-block;font-size:11px;line-height:16px;padding:0 6px;border-radius:8px;background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-secondary);margin-left:6px}
.cfx-tag.warn{color:var(--dsw-alias-state-error-primary)}
`;

    const fmt = (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "–");
    const usd = (n, d = 4) => (typeof n === "number" ? `$${n.toFixed(d)}` : "–");
    const pct = (n) => (typeof n === "number" ? `${(n * 100).toFixed(1)}%` : "–");

    function Switch({ checked, disabled, label, onChange }) {
      return h("button", {
        type: "button",
        role: "switch",
        "aria-checked": checked ? "true" : "false",
        "aria-label": label,
        className: "cfx-switch",
        disabled,
        onClick: () => onChange(!checked),
      });
    }

    function NumberInput({ value, disabled, label, min, max, step, onCommit, wide }) {
      const [draft, setDraft] = useState(String(value ?? ""));
      useEffect(() => setDraft(String(value ?? "")), [value]);
      const n = Number(draft);
      const valid = draft.trim() !== "" && Number.isFinite(n) && (min === undefined || n >= min) && (max === undefined || n <= max) && (step !== 1 || Number.isInteger(n));
      const commit = () => {
        if (valid && n !== value) onCommit(n);
        else if (!valid) setDraft(String(value ?? ""));
      };
      return h("input", {
        className: "cfx-input" + (wide ? " wide" : ""),
        type: "number",
        "aria-label": label,
        "aria-invalid": valid ? "false" : "true",
        value: draft,
        min,
        max,
        step: step ?? "any",
        disabled,
        onChange: (e) => setDraft(e.target.value),
        onBlur: commit,
        onKeyDown: (e) => {
          if (e.key === "Enter") commit();
        },
      });
    }

    function TextInput({ value, disabled, label, onCommit, placeholder }) {
      const [draft, setDraft] = useState(value ?? "");
      useEffect(() => setDraft(value ?? ""), [value]);
      const commit = () => {
        if (draft !== (value ?? "")) onCommit(draft);
      };
      return h("input", {
        className: "cfx-input wide",
        type: "text",
        "aria-label": label,
        value: draft,
        placeholder,
        disabled,
        onChange: (e) => setDraft(e.target.value),
        onBlur: commit,
        onKeyDown: (e) => {
          if (e.key === "Enter") commit();
        },
      });
    }

    function Row({ title, desc, children }) {
      return h("div", { className: "cfx-row" }, h("div", null, h("div", { className: "cfx-rtitle" }, title), desc ? h("div", { className: "cfx-rdesc" }, desc) : null), children);
    }

    function Group({ title, children }) {
      return h("div", { className: "cfx-group" }, h("div", { className: "cfx-gtitle" }, title), children);
    }

    const DEFAULT_TOOLS = ["bash", "grep", "glob", "web_fetch", "read", "skill", "plugin_manager", "job_output", "mcp__atlassian__*", "mcp__slack__*", "mcp__playwright-work__*", "mcp__playwright-personal__*"];

    function useStats(days) {
      const [state, setState] = useState({ loading: true });
      const load = useCallback(() => {
        setState((s) => ({ ...s, loading: true }));
        fetch(`/ctx-filter/api/stats?days=${days}`, { credentials: "same-origin", cache: "no-store" })
          .then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t || r.statusText)))))
          .then((data) => setState({ loading: false, data }))
          .catch((error) => setState({ loading: false, error: String(error.message ?? error) }));
      }, [days]);
      useEffect(load, [load]);
      return [state, load];
    }

    function SettingsTab({ form, set, t, toolsSeen }) {
      const [err, setErr] = useState(false);
      if (form.status === "unavailable") return h("div", { className: "cfx-note" }, t("unavailable"));
      if (form.status !== "ready" || !form.value) return h("div", { className: "cfx-note" }, t("loading"));
      const v = form.value;
      const off = !form.writable;
      const put = (field, value) => {
        setErr(false);
        Promise.resolve(set(field, value)).then((ok) => {
          if (ok === false) setErr(true);
        });
      };
      const sw = (field, title, desc) =>
        h(Row, { key: field, title, desc }, h(Switch, { checked: v[field] === true, disabled: off, label: title, onChange: (x) => put(field, x) }));
      const num = (field, title, desc, o = {}) =>
        h(Row, { key: field, title, desc }, h(NumberInput, { value: v[field], disabled: off, label: title, onCommit: (x) => put(field, x), ...o }));
      const txt = (field, title, desc, o = {}) => h(Row, { key: field, title, desc }, h(TextInput, { value: v[field], disabled: off, label: title, onCommit: (x) => put(field, x), ...o }));
      const excluded = Array.isArray(v.excludedTools) ? v.excludedTools : [];
      const tools = [...new Set([...DEFAULT_TOOLS, ...(toolsSeen ?? []), ...excluded])].sort();
      const toggleTool = (tool, filter) => put("excludedTools", filter ? excluded.filter((x) => x !== tool) : [...excluded, tool]);
      return h(
        "div",
        null,
        off ? h("div", { className: "cfx-note" }, t("readOnly")) : null,
        err ? h("div", { className: "cfx-error" }, t("saveFailed")) : null,
        h(
          Group,
          { title: "General" },
          sw("enabled", "Filter tool results", "Off: every result passes through unchanged."),
          sw("shadowMode", "Shadow mode", "Judge and log what would be cut, but pass every result through unchanged. Use it to measure before trusting the cut."),
          num("minTokens", "Filter results above (tokens)", "Results at or below this size pass through untouched. Default 2,000.", { min: 0, step: 1 }),
          num("maxTokens", "Leave to DSH above (tokens)", "Above this size DSH's own head/tail cap handles the result. Default 12,500.", { min: 0, step: 1 }),
          num("keepPercent", "Keep at most (% of the result)", "Budget for everything kept: head, tail, error lines and relevant passages.", { min: 1, max: 100 }),
          num("relevanceThreshold", "Relevance threshold", "A passage counts as relevant when Jev's probability is at least this (0–1).", { min: 0, max: 1 }),
        ),
        h(
          Group,
          { title: "Tools to filter" },
          h("div", { className: "cfx-note" }, "Checked tools are filtered. An entry ending in * matches every tool with that prefix, such as all tools of one MCP server."),
          h(
            "div",
            { className: "cfx-tools" },
            tools.map((tool) =>
              h(
                "label",
                { key: tool },
                h("input", { type: "checkbox", checked: !excluded.includes(tool), disabled: off, onChange: (e) => toggleTool(tool, e.target.checked) }),
                tool,
              ),
            ),
          ),
          sw("skipFilePrints", "Skip bash commands that print files", "cat, sed -n, head, tail and similar: the agent usually wants those files whole."),
          h(AddTool, { disabled: off, onAdd: (tool) => !excluded.includes(tool) && put("excludedTools", [...excluded, tool]) }),
        ),
        h(
          Group,
          { title: "Want: what Jev is told the agent needs" },
          sw("wantToolCall", "Tool call", "The tool name and its arguments."),
          sw("wantDescription", "Call description", "The description field the agent writes for the call."),
          sw("wantAgentText", "Agent's text before the call", "What the agent wrote and reasoned in the step that made the call."),
          sw("wantUserPrompt", "User's latest request", "The last message you sent."),
          sw("wantRecentConversation", "Recent conversation", "The latest user and agent messages, without tool results."),
          num("recentConversationTokens", "Recent conversation size (tokens)", "How much of the recent conversation is included.", { min: 0, step: 1 }),
        ),
        h(
          Group,
          { title: "What to keep" },
          sw("keepHead", "Head", "The first lines of the result."),
          num("headLines", "Head lines", null, { min: 0, step: 1 }),
          sw("keepTail", "Tail", "The last lines: exit codes, summaries."),
          num("tailLines", "Tail lines", null, { min: 0, step: 1 }),
          sw("keepErrors", "Error lines", "Lines that look like errors or failures, up to half the budget."),
          sw("keepRelevant", "Relevant passages", "Passages Jev judges relevant to the want. Off: no Jev call, only the rules above."),
        ),
        h(
          Group,
          { title: "Output" },
          sw("saveFullOutput", "Save the full result", "Stored in DSH's spill folder so the agent can read what was cut."),
          sw("addFooter", "Footer", "Tells the agent what was kept and where the full result is."),
          sw("logWant", "Log the want", "Stores the want with each event, shown under Recent results."),
        ),
        h(
          Group,
          { title: "Jev and pricing" },
          txt("model", "Model", "Vercel AI Gateway decision model."),
          txt("apiKeyEnv", "API key variable", "Environment variable with the gateway key."),
          txt("apiKeyCommand", "API key command", "Runs when the variable is unset. Empty: the command in ~/.ctx-filter/config.json.", { placeholder: "security find-generic-password …" }),
          num("timeoutMs", "Jev time limit (ms)", "Past it, the result passes through unchanged.", { min: 500, step: 1 }),
          num("priceInputPerM", "Main model: uncached input, $ per million tokens", "Used only for the savings estimate. Default: Opus 4.5.", { min: 0 }),
          num("priceCachedPerM", "Main model: cached input, $ per million tokens", "Used only for the savings estimate.", { min: 0 }),
        ),
      );
    }

    function AddTool({ disabled, onAdd }) {
      const [draft, setDraft] = useState("");
      return h(
        Row,
        { title: "Exclude another tool", desc: "A tool name, or a prefix ending in *." },
        h(
          "div",
          { style: { display: "flex", gap: 6 } },
          h("input", { className: "cfx-input", value: draft, disabled, placeholder: "mcp__github__*", onChange: (e) => setDraft(e.target.value) }),
          h("button", { className: "cfx-btn", type: "button", disabled: disabled || !draft.trim(), onClick: () => (onAdd(draft.trim()), setDraft("")) }, "Exclude"),
        ),
      );
    }

    function Tile({ label, value, sub }) {
      return h("div", { className: "cfx-tile" }, h("div", { className: "cfx-tlabel" }, label), h("div", { className: "cfx-tvalue" }, value), sub ? h("div", { className: "cfx-tsub" }, sub) : null);
    }

    function StatsTab({ stats, days, setDays, reload }) {
      const bar = h(
        "div",
        { className: "cfx-bar" },
        h(
          "label",
          { className: "cfx-note", style: { display: "flex", gap: 8, alignItems: "center", margin: 0 } },
          "Period",
          h(
            "select",
            { className: "cfx-select", value: days, onChange: (e) => setDays(Number(e.target.value)) },
            [1, 7, 30, 90, 365].map((d) => h("option", { key: d, value: d }, d === 1 ? "Last day" : `Last ${d} days`)),
          ),
        ),
        h("button", { className: "cfx-btn", type: "button", onClick: reload }, "Refresh"),
      );
      if (stats.error) return h("div", null, bar, h("div", { className: "cfx-error" }, stats.error));
      const s = stats.data;
      if (!s) return h("div", null, bar, h("div", { className: "cfx-note" }, "Loading…"));
      const a = s.actions ?? {};
      return h(
        "div",
        null,
        bar,
        h(
          "div",
          { className: "cfx-tiles" },
          h(Tile, { label: "Results filtered", value: fmt(s.filtered), sub: `of ${fmt(s.results)} tool results seen` }),
          h(Tile, { label: "Tokens kept out (once)", value: fmt(s.savedOnce), sub: `${fmt(s.tokensBeforeFiltered)} → ${fmt(s.tokensAfterFiltered)} · ${pct(s.savedShareOfAllToolOutput)} of all tool output` }),
          h(Tile, { label: "Re-sent tokens avoided", value: fmt(s.resentAvoided), sub: `avg ${s.laterRequests.average} later requests per result (${fmt(s.laterRequests.known)} known)` }),
          h(Tile, { label: "Est. main model saving", value: usd(s.mainModelSaving, 3), sub: "at the prices set under Settings" }),
          h(Tile, { label: "Jev cost", value: usd(s.jev.costUsd, 4), sub: `${fmt(s.jev.runs)} runs · ${fmt(s.jev.inputTokens)} in / ${fmt(s.jev.outputTokens)} out tokens` }),
          h(Tile, { label: "Net saving", value: usd(s.netSaving, 3), sub: "main model saving minus Jev cost" }),
          h(Tile, { label: "Delay added", value: `${fmt(s.delayMs.average)} ms`, sub: `p50 ${fmt(s.delayMs.p50)} · p95 ${fmt(s.delayMs.p95)} · total ${(s.delayMs.total / 1000).toFixed(1)} s` }),
          h(Tile, { label: "Follow-ups (likely misses)", value: fmt(s.followups.calls), sub: `${pct(s.followups.rate)} of filtered results: the agent opened the full result` }),
          h(Tile, { label: "Jev failures", value: fmt(s.failures), sub: "result passed through unchanged" }),
          h(Tile, { label: "Sessions affected", value: fmt(s.sessions.affected), sub: `${fmt(s.sessions.compactions)} compactions in them · ${fmt(s.laterRequests.compactedAfter)} results later compacted` }),
          s.shadow ? h(Tile, { label: "Shadow mode", value: fmt(s.shadow), sub: `would have kept out ${fmt(s.shadowWouldSave)} tokens` }) : null,
        ),
        h(
          Group,
          { title: "Why results were not filtered" },
          h(
            "div",
            { className: "cfx-note" },
            [
              ["small", "at or below the threshold"],
              ["over-cap", "above DSH's cap"],
              ["excluded", "excluded tool"],
              ["file-print", "bash file print"],
              ["no-gain", "cut would save under 20%"],
              ["non-text", "images or other blocks"],
              ["jev-error", "Jev failed"],
              ["no-session", "no session"],
            ]
              .filter(([k]) => a[k])
              .map(([k, label]) => `${label}: ${fmt(a[k])}`)
              .join(" · ") || "Nothing yet.",
          ),
        ),
        h(
          Group,
          { title: "By tool" },
          h(
            "table",
            { className: "cfx-table" },
            h("thead", null, h("tr", null, ["Tool", "Results", "Tokens seen", "Filtered", "Tokens kept out", "Follow-ups"].map((c, i) => h("th", { key: c, className: i ? "cfx-num" : undefined }, c)))),
            h(
              "tbody",
              null,
              (s.byTool ?? []).slice(0, 25).map((r) =>
                h("tr", { key: r.tool }, h("td", null, r.tool), h("td", { className: "cfx-num" }, fmt(r.results)), h("td", { className: "cfx-num" }, fmt(r.tokens)), h("td", { className: "cfx-num" }, fmt(r.filtered)), h("td", { className: "cfx-num" }, fmt(r.saved)), h("td", { className: "cfx-num" }, fmt(r.followups))),
              ),
            ),
          ),
        ),
        (s.byDay ?? []).length
          ? h(
              Group,
              { title: "By day" },
              h(
                "table",
                { className: "cfx-table" },
                h("thead", null, h("tr", null, ["Day", "Filtered", "Tokens kept out", "Jev cost"].map((c, i) => h("th", { key: c, className: i ? "cfx-num" : undefined }, c)))),
                h("tbody", null, s.byDay.map((r) => h("tr", { key: r.day }, h("td", null, r.day), h("td", { className: "cfx-num" }, fmt(r.filtered)), h("td", { className: "cfx-num" }, fmt(r.saved)), h("td", { className: "cfx-num" }, usd(r.jevCost, 4))))),
              ),
            )
          : null,
        h("div", { className: "cfx-note", style: { marginTop: 16 } }, `Raw event log, one JSON line per tool result: ${s.eventsFile}`),
      );
    }

    function RecentTab({ stats }) {
      const s = stats.data;
      if (stats.error) return h("div", { className: "cfx-error" }, stats.error);
      if (!s) return h("div", { className: "cfx-note" }, "Loading…");
      if (!s.recent.length) return h("div", { className: "cfx-note" }, "No filtered results in this period yet.");
      return h(
        "table",
        { className: "cfx-table" },
        h("thead", null, h("tr", null, ["When", "Tool", "Tokens", "Lines", "Kept", "ms", "Jev $"].map((c, i) => h("th", { key: c, className: i > 1 ? "cfx-num" : undefined }, c)))),
        h(
          "tbody",
          null,
          s.recent.map((e, i) =>
            h(
              "tr",
              { key: (e.callId ?? "") + i },
              h("td", null, new Date(e.at).toLocaleString()),
              h(
                "td",
                null,
                e.tool,
                e.action !== "filtered" ? h("span", { className: "cfx-tag" + (e.action === "jev-error" ? " warn" : "") }, e.action) : null,
                e.followedUp ? h("span", { className: "cfx-tag warn" }, "follow-up") : null,
                e.want || e.error
                  ? h("details", null, h("summary", { className: "cfx-note", style: { cursor: "pointer", margin: "4px 0 0" } }, e.error ? "Error" : `Want (${(e.wantParts ?? []).join(", ")})`), h("div", { className: "cfx-want" }, e.error ?? e.want))
                  : null,
              ),
              h("td", { className: "cfx-num" }, `${fmt(e.tokensBefore)} → ${fmt(e.tokensAfter)}`),
              h("td", { className: "cfx-num" }, e.linesBefore ? `${fmt(e.linesBefore)} → ${fmt(e.linesAfter)}` : "–"),
              h("td", { className: "cfx-num" }, e.reasons ? `h${e.reasons.head} t${e.reasons.tail} e${e.reasons.errors} r${e.relevantPassages ?? 0}` : "–"),
              h("td", { className: "cfx-num" }, fmt(e.ms)),
              h("td", { className: "cfx-num" }, e.jev ? usd(e.jev.costUsd, 5) : "–"),
            ),
          ),
        ),
      );
    }

    function Page({ t, useForm, set }) {
      const form = useForm((x) => x);
      const [tab, setTab] = useState("settings");
      const [days, setDays] = useState(30);
      const [stats, reload] = useStats(days);
      const tabs = [
        ["settings", t("tabSettings")],
        ["stats", t("tabStats")],
        ["recent", t("tabRecent")],
      ];
      return h(
        "div",
        { className: "cfx-root" },
        h("style", null, CSS),
        h("div", { className: "cfx-head" }, h("h2", null, t("title")), h("div", { className: "cfx-sub" }, t("subtitle"))),
        h(
          "div",
          { className: "cfx-tabs", role: "tablist" },
          tabs.map(([id, label]) => h("button", { key: id, type: "button", role: "tab", className: "cfx-tab", "aria-selected": tab === id ? "true" : "false", onClick: () => (setTab(id), id !== "settings" && reload()) }, label)),
        ),
        tab === "settings" ? h(SettingsTab, { form, set, t, toolsSeen: stats.data?.toolsSeen }) : null,
        tab === "stats" ? h(StatsTab, { stats, days, setDays, reload }) : null,
        tab === "recent" ? h(RecentTab, { stats }) : null,
      );
    }

    function BundlePage(props) {
      if (props.view === "summary") return props.t("summary");
      return h(Page, props);
    }

    function Icon({ size = 16 }) {
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true },
        h("path", { d: "M2 3h12l-4.5 5.2V13l-3 1.2V8.2z", stroke: "currentColor", strokeWidth: 1.3, strokeLinejoin: "round" }),
      );
    }

    return {
      inject: ["slots", "locale", "configForms"],
      apply(ctx) {
        const dict = { en, zh: en, ja: en, es: en, fr: en, de: en, ru: en, pt: en };
        ctx.effect(() => ctx.locale.register(NS, dict), "ctx-filter: dictionaries");
        const t = ctx.locale.bind(NS);
        const form = ctx.configForms.get(ENTRY);
        const face = () => ({ hooks: { form }, set: (field, value) => form.set(field, value) });
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register({ name: "settings.section", id: "ctx-filter", order: 70, label: () => t("nav"), locale: NS, inject: face }, Page),
        );
        ctx.slots.inject("settings.section.icon", () => ctx.slots.register({ name: "settings.section.icon", id: "ctx-filter", locale: NS }, Icon));
        ctx.slots.inject("plugins.bundle.config", () =>
          ctx.slots.register({ name: "plugins.bundle.config", key: PKG, locale: NS, inject: face }, BundlePage),
        );
      },
    };
  },
});
