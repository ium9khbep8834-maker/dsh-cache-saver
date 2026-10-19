# Cache Saver

Cut the token cost of a large tool set, keep more of every request inside the
prompt cache, and **measure** where the re-sent context actually goes.

## The problem

Every request re-sends the whole prompt prefix: the tool schemas, the system
sections, and the entire message history. On this machine the tool schemas alone
were **275 tools / ~722 000 chars of `parameters` JSON (≈180 K tokens)** on the
first request — 82 % of it from one MCP server (`rea`, 207 tools). A handful of
tools were enormous on their own:

| tool | schema chars |
|---|---|
| `mcp__rea__compare_web_captures` | ~155 600 |
| `mcp__rea__compare_application_versions` | ~28 900 |
| `mcp__rea__inspect_analysis_view` | ~27 500 |
| `mcp__rea__evaluate_reconstruction_coverage` | ~24 600 |
| `mcp__rea__project_managed_application_graph` | ~21 200 |

Two facts make this worth attacking:

1. **Prompt-cache hit rate is inversely related to saving.** A hit rate near 100 %
   means almost every input token was a *cache read* — nothing was removed. You
   save money by making the prefix **smaller**, not by making it hit more often.
2. **Anything that enters the context is re-billed on every later request** —
   usually at the cache-read price (~0.1× input) rather than the full price, but
   it accumulates over every step. Large tool results and long assistant output
   are therefore as important as schemas.

## What this plugin does

### 1. Schema slimming (per agent, dispatch unchanged)

For every agent it registers a **scoped** copy of the selected tools whose
`parameters` is compact but still callable:

- top-level parameter **names and primitive types survive**, so the model still
  knows which argument to pass;
- deep nesting collapses to `{ "type": "object", "additionalProperties": true }`
  with a short description;
- `examples`, `default`, `$comment`, `title`, `$id`, `$schema` and similar
  annotation-only keywords are dropped;
- prose is clamped, `oneOf`/`anyOf` fan-out beyond `maxBranches` is truncated
  with an explicit note;
- the whole schema is re-measured and re-collapsed until it fits
  `maxSchemaChars` (or the tool is added to `keepFull`).

Scoped tools shadow globals (documented `tools.register` behaviour), while
`execute`, `output`, `presentCall`, `presentResult` and `timeoutMs` are copied
from the original definition, so **dispatch is unchanged**. Registrations are
owned by the agent's own context and the plugin's own `ctx.effect`, so they
disappear with the agent or on unload.

Measured on the live profile: **158 shadowed tools, 740 692 → 121 190 chars
(−83.6 %, ≈ −154 900 tokens per request)**. One step of this very session then
billed `input 133 164 tokens` with `99.5 % cache hit` — the surviving prefix is
cached, the money goes into the ~1 400 full-price tokens that changed.

### 2. Context-cost measurement (observe only)

Cost is measured from the provider's own `usage` numbers, not from a character
heuristic: a char/4 estimate of this profile's history reads ~3× the billed
tokens (it also counts content a compaction fold already replaced), so it would
overstate every card on the page.

- `tools/result` — for every tool outcome: content chars, approximate tokens,
  duplicate identical calls, errors, and per-tool totals (never the payload).
- `session/event` + `assistant/message` — for every billed model call:
  `usage.inputTokens`, `usage.cacheReadTokens`, `usage.cacheWriteTokens`,
  `usage.outputTokens`, plus the durable history's per-bucket composition
  (user / assistant / tool result / tool-call args / reasoning / other) as a
  percentage mix, and two derived numbers:

  - `new_tokens = input_tokens − cache_read_tokens` (what is paid at full price)
  - `cost ≈ 0.1 × cache_read_tokens + new_tokens` (one step priced at the cache-hit rate)

  The page also shows the billed cache hit rate (`cache_read / input`) so the
  two goals — a high hit rate and a small bill — are visible side by side.

### 3. A settings page (client half)

The bundle ships `client.js`, which contributes one page to the settings panel:

- Slot `settings.section`, id `cache-saver`, order `45` (between 插件 / 市场 and 哔哩).
- Data `GET /api/cache-saver/status` — read-only route on the host `webServer`,
  same origin, no credentials, `cache-control: no-store`.
- Content: saved chars / ≈tokens, session equivalent-token cost, latest billed
  input and its cache hit rate, new (full-price) content, tool-result volume and
  over-budget count, steps observed, the durable history's composition as bars,
  the top-25 tool results by tokens, the top-15 schema reductions, one row per
  agent, live config chips, the event timeline, and **actionable findings**.

Findings are generated, not hard-coded, e.g.:

- `N tool result(s) exceeded bigResultTokens (largest M)` → lower
  `spill-policy.maxInlineTokens` or delegate noisy subagents;
- identical repeated calls → cache the answer instead of re-calling;
- average context per step → estimate the session's input cost;
- any remaining schema over `maxSchemaChars`.

Because the client half is loaded from the boot manifest, a page that was open
when the bundle was installed does not see it: **refresh once (`F5`)**.

The route can be checked without the GUI:

```bash
curl -s http://127.0.0.1:52811/api/cache-saver/status
```

## Config

Every key is optional; set them in the row's `config` in `cordis.patch.yml`.

| key | default | meaning |
|---|---|---|
| `shadowPrefixes` | `["mcp__rea__"]` | only tools with one of these prefixes are slimmed |
| `keepFull` | 8 core `mcp__rea__` read tools | exact tool names never slimmed |
| `minChars` | `700` | a schema already this small is only description-clamped |
| `maxSchemaChars` | `800` | target ceiling for a slimmed schema |
| `maxDepth` | `3` | deepest nesting kept; deeper objects become `additionalProperties` |
| `topDescriptionChars` | `140` | schema-root description limit |
| `nestedDescriptionChars` | `60` | one-level-down description limit |
| `descriptionDepth` | `1` | deeper descriptions are dropped |
| `maxDescriptionChars` | `260` | tool description clamp (`0` disables) |
| `maxBranches` | `4` | union branches kept per keyword |
| `bigResultTokens` | `6000` | results above this are counted as "large" |
| `maxStepSamples` | `60` | step snapshots kept per agent for the timeline |
| `dryRun` | `false` | measure without registering shadows |

Example:

```yaml
- insert:
    - id: cache-saver
      name: '@local/dsh-cache-saver'
      config:
        shadowPrefixes: ['mcp__rea__', 'mcp__some_other_server__']
        keepFull: ['mcp__rea__inspect_web_page', 'mcp__rea__analyze_function']
        maxSchemaChars: 1200
        bigResultTokens: 4000
```

## Verify

- Tool: **`cache_saver_status`** — shadowed tools, chars before/after, ≈tokens
  saved, tool-result volume, billed steps (input / cached / hit rate), equivalent
  cost, recommendations.
- Page: Settings → 缓存节省 (needs one refresh after install/upgrade). Cards:
  per-request saving, session equivalent cost, latest billed input, **cache hit
  rate**, **new full-price content**, results entering history, steps.
- Route: `curl -s http://127.0.0.1:52811/api/cache-saver/status`.

## Safety notes

- Over-slimming cannot break dispatch: DSH does not validate arguments against
  `parameters`, and a shadowed definition keeps the original `execute`. The only
  risk is that the model forgets a rarely used nested option — raise
  `maxSchemaChars` / `maxDepth`, or add the tool to `keepFull`.
- `dryRun: true` measures first.
- Observation hooks only read message content to count chars; **no payload,
  argument or result body is stored or logged** — only sizes, counts and names.
- Nothing is written to the session log and no other plugin's global tools are
  modified.

## Honest limits

- This plugin **lowers the input cost of every request**; it does not raise the
  cache-hit percentage (removing content mechanically lowers that percentage).
- If a provider does not apply prompt caching at all, the saving is even larger
  in money terms (the removed prefix would be billed at full price), but the
  percentage view stays meaningless.
- The remaining lever with the largest headroom is tool-result volume: an
  oversized result that once entered the history is re-sent on every later
  request. The page reports that volume so it can be fixed at the source (bound
  the result, delegate to a subagent, or cache the answer).

## Tests

```bash
node test/unit.mjs    # schema slimming, shadow registration, route, attribution, cost
node test/client.mjs  # client bundle: registration shape, page render, error/empty states
```

Both are dependency-free: they stub the Harness objects they touch and never
start a real host or browser.

## Troubleshooting

**The app refuses to start with `web boot: 1 entry did not activate` /
`import failed` and the renderer console shows
`client-modules: duplicate factory registration for "<old id>"`.**

The client module id inside `client.js` must equal the package name in
`package.json` (`@local/dsh-cache-saver`). The web boot imports the bundle by
its package specifier; a different id registers a factory the loader cannot
resolve, so it executes the bundle a second time. Fixed in 0.3.1, which also
wraps the registration so a genuine double execution is an idempotent no-op
instead of aborting the boot.

Recovery if a stale copy still fails: open the crash dialog, choose
`禁用第三方插件、备份 profile patch 并重启`, then re-enable the bundle from
Plugins settings (or `plugin_manager` `set_bundle` on `@local/dsh-cache-saver`).
