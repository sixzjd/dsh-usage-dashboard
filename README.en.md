# dsh-usage-dashboard

A local usage-analytics plugin for DeepSeek Harness: **Settings → Usage Statistics** shows token consumption, request count, cache hit rate and a daily trend.

All data comes from your local session logs. No network, no upload, no API key.

> The panel body is currently Chinese-only; the settings nav label follows your browser language. The full design notes live in [README.md](README.md).

## Why

DSH already reports per-turn token usage, but nothing aggregates across sessions. External tools like cc-switch do, at the cost of a separate desktop app that parses log files and guesses their format.

This plugin runs entirely inside DSH. The host exposes a public `sessionQuery` service that owns decompression, ordering and interrupted-turn balancing, so the plugin consumes structured events instead of parsing files — and it does not break when the log layout changes.

## Flow

```
durable session log
      │  ctx.sessionQuery.listSessions() / readSession()
      ▼
  event stream (decoded, ordered)
      │  assistant/message.usage  ▸ supersedes assistant/chunk for the same turn
      │  request/header / request/context  ▸ model and provider identity
      ▼
  fold into one row per (session, turn, step)
      │  bucket by local calendar day
      ▼
  daily / per-model aggregates + price-table costing
      │  GET /api/dsh-usage-dashboard/summary
      ▼
  native settings section (settings.section slot)
```

One call counts once: the final `assistant/message` usage **replaces** the streaming `assistant/chunk` for the same `turn:step` rather than adding to it, and an all-zero replay never overwrites a recorded real number.

## Deleted sessions still count

The data source, `sessionQuery`, can only list session logs that **still exist on disk**. Counting straight from it means deleting a conversation silently subtracts every token it ever spent — nothing errors, the totals just quietly shrink.

So the plugin also stores per-call usage from each scan (`storages/dsh_usage_dashboard_history.json`). Retained rows rank BELOW the live log: history loads first and the disk logs fold afterwards, so a session that still exists is always measured from its own log, while a deleted one keeps counting from the archive.

For sessions deleted **before** this feature shipped, the plugin runs a one-time backfill from the host's session projection cache (`session_projcache`) `tokenUsage` totals.

> **Known limitation**: `tokenUsage` carries one whole-session total with no per-day or per-model split. A backfilled row is anchored at the session's creation time, so the **total is accurate** but its position on the daily chart is approximate.

## Metric definitions

Token buckets follow the host's documented **DISJOINT** semantics (`@deepseek-ai/dsh-llm`): `inputTokens` is uncached input only; cached input is reported separately.

| Metric | Formula |
|---|---|
| Tokens consumed | `input + output + cacheWrite + cacheRead` |
| Requests | calls carrying usage, deduplicated by `session:turn:step` |
| Cache hit rate | `cacheRead ÷ (input + cacheWrite + cacheRead)` |

> **Note**: OpenAI-style protocols do not report `cacheWriteTokens`, so that term is always 0 and the hit rate stays correct (the denominator omits it too). This is a missing upstream field, not a counting gap.

## Features

| Area | Content |
|---|---|
| Three summary cards | Tokens consumed / Requests / Cache hit rate; click to expand that metric's breakdown |
| Trend | Bar chart, switchable between Tokens and Requests; values appear on hover or keyboard focus only. Daily by default; **Today** (or a custom range whose start and end are the same day) switches it to **hourly** |
| Filters | Provider, model, range (Today / 7 / 30 / 90 days / All time / custom start–end), opening on the last 30 days |
| Request log | Per-call time, provider, model, tokens, cost |
| Providers / Models | Grouped totals and shares |
| Pricing | Editable price table, USD per million tokens across four buckets |

The X axis is filled with **every calendar day** in range, so idle days render as zero rather than being skipped — otherwise "two idle weeks then one burst" would read as "steady low usage with a spike". The hourly view works the same way: all 24 slots are present, so a quiet 3 a.m. keeps its place.

**All time** starts at the oldest record actually on disk, not at a fixed day count; with no records at all it degrades to Today but stays daily, so an empty history is never drawn as 24 hourly bars.

The header stamps **when the numbers were captured** (`· 数据更新于 15:27:45`). A single response is always internally consistent — a provider's request count equals the sum of its models' — so two tables disagreeing can only mean usage grew between two fetches. The panel does not auto-refresh: numbers change when you change a filter or press refresh, and the stamp says which fetch you are looking at.

## Install

```bash
dsh plugin --profile web add @sixzjd/dsh-usage-dashboard
```

Once installed, **Settings → Plugins** checks for and installs updates directly — no CLI needed. For the development build from GitHub:

```bash
dsh plugin --profile web add github:sixzjd/dsh-usage-dashboard
```

Refresh the page after installing. The entry mounts into the settings page's `settings.section` slot.

## Built-in prices

DeepSeek's official peak/off-peak table ships as in-package constants, sourced from the official announcement:

| Model | Off-peak in / out / cacheRead | Peak in / out / cacheRead |
|---|---|---|
| `deepseek-v4-flash` | 0.15 / 0.6 / 0.003 | 0.44 / 1.32 / 0.014 |
| `deepseek-v4-pro` | 0.66 / 1.98 / 0.022 | 1.32 / 3.96 / 0.044 |

USD per million tokens. Peak hours are UTC `01:00–04:00` and `06:00–10:00` on Monday–Friday, excluding Chinese statutory holidays.

**Models with no public price are reported as unpriced and never receive a guessed rate.** You can add prices manually under Pricing.

## Development

```
client.js            browser half (the settings panel)
lib/index.js         host half entry
lib/plugin.js        scan, aggregation scheduling, persistence, HTTP routes
lib/aggregate.js     event fold and daily / per-model bucketing
lib/catalog.js       route-key -> display name, read from the upstream cache (fails closed)
lib/pricing.js       price table and peak-band resolution
locale/{en,zh}.json  plugin page display name (en.json must exist)
test/                node:test suite, no third-party dependencies
```

```bash
npm test     # runs offline, no dependencies
npm run check
```

## Model display names

Some providers expose models under opaque **route keys** rather than real model
names. Qoder does exactly this: the durable log records
`{provider:"qoder", model:"qfmodel"}`, while the model actually behind that
route is `Qwen3.8-Flash`. The route key is handed back to the upstream verbatim
and **cannot** be replaced at the source, so the real name only exists in that
plugin's own model-discovery cache.

The panel reads that cache and shows the real model name.

Only models whose logged modelId **is itself an alias** need this step. Most providers
return real model names (`openai/gpt-oss-120b`, `minimaxai/minimax-m3`,
`deepseek-v4-flash-free`, …); the alias table has no entry for them, the panel shows
those verbatim, and no other plugin is required. Someone without the qoder plugin will
never see `qfmodel`, because that route key cannot appear in their logs — resolving
fewer aliases changes nothing on screen.

Matching is **exact on the whole id** (case-insensitive); it does not match the trailing
segment after a namespace. The alias cache carries no provider field, so letting
`vendor/dmodel` hit Qoder's `dmodel` would label another vendor's model with a Qoder
name — a wrong label on screen is worse than no label.

**Display only.** Grouping, counting, filtering and pricing all keep using the
route id, so:

- labelling never moves a request between rows or changes any figure
- when two accounts' caches disagree about one route key, that key is **dropped**
  (a route id on screen beats a wrong model name)
- a missing, unreadable or reshaped cache falls back **silently** to the route
  id: the UI says nothing, and you simply see keys like `qfmodel`. To check
  whether resolution is working, read `catalog.aliasCount` in the
  `GET /api/dsh-usage-dashboard/summary` response — 0 means nothing resolved

## Seams used

| Seam | Purpose |
|---|---|
| `ctx.sessionQuery` | list sessions, read decoded event streams |
| `ctx.storage` (json backend, kv) | persist the price table under `$DSH_HOME/storages` |
| `ctx.webServer` | register `/api/dsh-usage-dashboard/*` |
| `ctx.timer` | periodic reconcile and live debouncing |
| `settings.section` slot | mount the settings section |
| `Modal` from `@deepseek-ai/dsh-client-ui-primitives` | metric detail dialog (falls back to a self-drawn overlay when absent) |

### One read outside those seams

This plugin does **not** read `$DSH_HOME/sessions` (every session arrives
through `ctx.sessionQuery`), but to resolve the model names above it does read
`dsh-qoder-connect`'s own discovery cache:

```
$DSH_HOME/profiles/*/.dsh-qoder-connect/state/*-catalog.json
```

That is **another plugin's private file, not a published contract** — the path,
the JSON shape and the per-account keying can all change with its releases. I
know this contradicts the earlier "public seams only" claim in this repository,
and this section is the corrected statement rather than a silent edit. The
tradeoff: without it the panel can only ever show meaningless route keys.

The read is therefore written to fail closed:

- only files named `*-catalog.json` matching `{version:1, entries:{…models:[…]}}`
  are accepted; `.qoder-probe.json` and `.qoder-host-heartbeat.json` (which
  carries a `pid`) in the same directory are excluded
- the cache is keyed by `pat:<hash>` and **only `{id, name}` is extracted**, so no
  account identifier can reach a response (a test pins this down)
- any failure falls back to the route key: no throw, no guessing, no effect on
  the statistics
- if upstream reshapes the file, the worst case is names reverting to route keys;
  the numbers stay correct

## Security boundaries

- Both routes require **loopback**: the socket peer and the `Host` header must both be loopback, and `Sec-Fetch-Site: cross-site` is rejected, which blocks DNS rebinding.
- The write route (saving prices) additionally requires a per-process token handed out by `GET /pricing`, which a cross-origin page cannot read.
- Responses contain usage numbers, model identifiers and session IDs (UUIDs). They do **not** contain prompts, reply bodies, session titles, workspace paths, or the account identifiers mentioned above.
- The only file read is the catalog noted above; it is never written, and no other file in that directory is touched.

## Known limitations

- **Cost is an estimate** from the built-in or manual price table, not a provider invoice. Cache read/write and reasoning follow whichever buckets the upstream reports.
- **Qoder routes bill in credits, not tokens** — its cache carries a per-model `billing.credits` multiplier such as `x0.5`. Applying a models.dev USD rate to such a route yields an "equivalent API price", **not what you actually paid**, so this plugin resolves names only and never auto-prices a route key.
- An interrupted upstream request may carry only `assistant/chunk` usage with no final `assistant/message`; the chunk usage is kept. If the upstream reports no usage event at all, tokens cannot be recovered precisely from reply content.
- Sessions lacking `request/header` / `request/context` show their model as `unknown`; the plugin never infers a model from a provider name.
- Model display names depend on `dsh-qoder-connect`'s private cache format (see above) and need following if it changes.
- The panel body is Chinese-only; only the settings nav label is localized.
- Every session the host lists is counted, not just registered workspaces.

## License

MIT
