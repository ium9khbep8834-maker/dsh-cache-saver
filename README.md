# Cache Saver

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![dsh](https://img.shields.io/badge/DSH-0.2.x-5b6ee1)](#install)
[![build](https://img.shields.io/badge/build-none-success)](package.json)

**English** · [简体中文](README.zh-CN.md)

A host + client bundle for DeepSeek Harness. Every request re-sends the whole
prompt prefix — tool JSON Schemas included. This plugin shrinks the oversized
ones (dispatch untouched) and then **shows you where the re-sent context goes**,
in a settings page.

Measured on a real profile — a fresh session's first request:

| | tools | prompt tokens |
|---|---|---|
| plugin off | 269 | **270,767** |
| plugin on | 270 | **69,559** (−74.3 %) |

Same tools, same calls. Only the manual got smaller.

## Install

Close DeepSeek Harness first (it holds the `desktop` profile), then one command:

```bat
"<install dir>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:ium9khbep8834-maker/dsh-cache-saver
```

Or with npm — one command, then add `"@local/dsh-cache-saver"` to `dsh.profile.bundles`
in `~/.dsh/profiles/desktop/package.json` (npm cannot know about DSH bundles):

```bash
npm install github:ium9khbep8834-maker/dsh-cache-saver
```

Restart (or reload the page) once — the client half is imported at boot — then
open **Settings → Cache saver**. Other profiles: same command with
`--profile web` / `--profile dsh-tui` (plain `dsh`, no `.cmd`).

## What it does

### 1. Schema slimming — the same tools, a smaller manual

On a fresh agent the plugin copies each tool definition into that agent's scope
and replaces only `description` / `parameters`. `execute`, `output.render`,
timeout and safety flags are inherited, so dispatch is unchanged; DeepSeek
Harness does not validate arguments (the MCP server still does), so nothing is
rejected. Eight frequently used `rea` tools are on a `keepFull` allowlist.

Typical result with the default config: **158 tools, 740,692 → 121,190 chars
(−83.6 %)**, with the five monster schemas cut by 91–99 %
(`compare_web_captures`: 155,623 → 1,392). Add `mcp__github__` to
`shadowPrefixes` and it becomes 182 tools, 776,706 → 143,679.

### 2. Cost attribution — where the re-sent context actually goes

It records every tool result (chars → tokens, duplicates, errors) and every
billed step's `usage`, then derives the numbers that matter:

```
prompt       = input + cacheRead + cacheWrite
new content  = input + cacheWrite            ← paid at full price
equivalent   = 0.1 × cacheRead + new content ← comparable across requests
```

It also classifies the current context (user / assistant / tool call / tool
result / reasoning) by character share, so "history is the biggest line item" is
a measurement, not a guess.

### 3. A settings page

**Settings → Cache saver** shows cost per request, cache hit rate, new paid
content, tool-result volume, the schema savings table, per-session stats,
recommendations and a recent-events timeline. Data comes from
`GET /api/cache-saver/status` (same origin, read-only).

## Config

Put overrides in `~/.dsh/profiles/desktop/cordis.patch.yml` (the durable layer):

```yaml
- id: cache-saver
  name: '@local/dsh-cache-saver'
  config:
    shadowPrefixes: ['mcp__rea__', 'mcp__github__']
    maxSchemaChars: 800
```

| key | default | meaning |
|---|---|---|
| `shadowPrefixes` | `['mcp__rea__']` | tool-name prefixes to slim |
| `keepFull` | 8 core `rea` readers | never slimmed |
| `maxSchemaChars` | `800` | target size per schema |
| `maxDescriptionChars` | `260` | target size per description |
| `bigResultTokens` | `6000` | "big result" threshold |
| `maxStepSamples` | `60` | step samples kept per agent |
| `dryRun` | `false` | measure only, do not shadow |

Fine-tuning: `minChars 700`, `maxDepth 3`, `topDescriptionChars 140`,
`nestedDescriptionChars 60`, `descriptionDepth 1`, `maxBranches 4`.

## Why not just raise the cache hit rate?

Because hit rate and spending move in opposite directions here. A hit rate of
99 % means almost every token is a cheap cache read — but the *denominator* is
whatever you keep re-sending. Deleting 136 K stable characters lowers the
ceiling while genuinely cutting the bill. Track **equivalent tokens**, not the
ratio.

## Safety and limits

- Dispatch, arguments and results are untouched; only the model-facing schema
  copy shrinks.
- Rare deep parameters can be folded away — add that tool to `keepFull`, or set
  `dryRun: true` to turn the whole thing off.
- v0.3.1 still ships one payload measurement caveat: tool-result volume is
  attributed by `chars / 4`, while step costs use the provider's real `usage`.

## Development

```bash
npm test        # unit + client checks, no harness needed
npm run check   # syntax check
```

## License

MIT
