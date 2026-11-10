/**
 * dsh-usage-dashboard — host half.
 *
 * Folds the durable session log into daily token / request / cache-hit / cost
 * figures and serves them to a native settings section.
 *
 * The data source is the host's public `sessionQuery` service, so nothing here
 * decodes session files or touches `$DSH_HOME/sessions`: the host already owns
 * decompression, ordering and interrupted-turn balancing.
 *
 * Unlike cc-switch-style dashboards, every session the host lists is counted,
 * including workspaces that were never registered. The question this panel
 * answers is "how much did I use today", and dropping an unregistered folder
 * would silently under-report the answer.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createAggregator } from './aggregate.js'
import { readBackfillRows } from './backfill.js'
import { createAliasResolver, loadModelAliases } from './catalog.js'
import { createHistoryStore } from './history.js'
import { DEFAULT_PRICES, addCosts, buildPriceIndex, emptyCost, normalizeModelId } from './pricing.js'

export const name = 'dsh-usage-dashboard'
export const inject = ['sessionQuery', 'storage', 'webServer', 'timer']

const KV_NAME = 'dsh_usage_dashboard_prices'
const KV_VERSION = 0
/**
 * Durable per-call usage history. Kept in its own unit so a history write
 * never rewrites the price table (and vice versa); both live in the same JSON
 * storage root, so one backend serves them.
 */
const HISTORY_KV_NAME = 'dsh_usage_dashboard_history'
const HISTORY_KV_VERSION = 0
const RECONCILE_INTERVAL_MS = 120000
const LIVE_DEBOUNCE_MS = 1500
/** Yield periodically so a long history cannot block the event loop. */
const BASELINE_CHUNK_MS = 8000
/**
 * Route-id -> display-name catalog refresh. The owning plugin rewrites it on
 * demand and it changes rarely, so this only needs to catch up after an
 * upgrade or an account switch; a faster poll would just re-read 27KB.
 */
const ALIAS_REFRESH_MS = 600000

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function localDay(atMs) {
  const d = new Date(atMs)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dayOffset(days) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - days)
  return localDay(d.getTime())
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

function csvParam(params, ...names) {
  const values = []
  for (const name of names) {
    const raw = params?.[name]
    if (typeof raw !== 'string') continue
    for (const value of raw.split(',')) {
      const normalized = value.trim()
      if (normalized !== '' && !values.includes(normalized)) values.push(normalized)
    }
  }
  return values
}

/**
 * Parse `start` / `end` (YYYY-MM-DD); default to the last 30 days.
 *
 * `days` also accepts two NAMES next to the day counts: `today` (a single
 * calendar day, which the chart then renders per hour) and `all`. `all` starts
 * at the oldest record the aggregator has seen, so the caller has to hand that
 * in — a missing `earliest` falls back to today rather than to 30 days, because
 * reporting a 30-day window under an "all time" label would be a lie.
 */
export function scopeFromParams(params = {}, options = {}) {
  const rawStart = typeof params.start === 'string' ? params.start.trim() : ''
  const rawEnd = typeof params.end === 'string' ? params.end.trim() : ''
  const end = DATE_PATTERN.test(rawEnd) ? rawEnd : localDay(Date.now())
  const named = typeof params.days === 'string' ? params.days.trim().toLowerCase() : ''
  let start = DATE_PATTERN.test(rawStart) ? rawStart : ''
  if (start === '') {
    if (named === 'today') {
      start = end
    } else if (named === 'all') {
      start = Number.isFinite(options.earliest) ? localDay(options.earliest) : end
    } else {
      const days = Number(params.days)
      start = dayOffset(Number.isFinite(days) && days > 0 ? Math.min(days, 3660) - 1 : 29)
    }
  }
  const dates = start > end ? { start: end, end: start } : { start, end }
  // Hourly only makes sense for a single calendar day. `all` over an empty
  // history also collapses to one day, but 24 hourly buckets under an "all
  // time" label would be nonsense — so the REQUEST decides, not the span.
  const granularity = dates.start === dates.end && named !== 'all' ? 'hour' : 'day'
  return {
    ...dates,
    granularity,
    providers: csvParam(params, 'provider', 'providers'),
    models: csvParam(params, 'model', 'models'),
  }
}

function sumCosts(costs) {
  const out = emptyCost()
  for (const cost of costs) if (isRecord(cost)) addCosts(out, cost)
  return out
}

function addTokenValues(target, tokens) {
  for (const bucket of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    target[bucket] += Number(tokens?.[bucket]) || 0
  }
}

function tokenValues() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function rowMatches(value, selected) {
  return selected.length === 0 || selected.includes(value ?? 'unknown')
}

/**
 * Attach display names to the rows a client renders.
 *
 * Deliberately a post-pass over an already-filtered result rather than a field
 * inside the fold:
 *
 *  - Grouping, totals and pricing key off the route id, so a label can never
 *    move a request between rows or change what is counted. Two accounts whose
 *    catalogs disagree about the same route id still aggregate together.
 *  - The catalog can be re-read on a timer without replaying every session.
 *  - filterSnapshot stays a pure function of (snapshot, scope), which is what
 *    its tests rely on.
 *
 * Rows keep `modelId` untouched and gain `displayName` only when a name is
 * known and differs from the id, so a client can fall back without checking.
 */
export function applyDisplayNames(result, resolveName) {
  if (typeof resolveName !== 'function') return result
  const label = (row) => {
    const name = resolveName(row.modelId)
    if (typeof name !== 'string' || name === '' || name === row.modelId) return row
    return { ...row, displayName: name }
  }
  return {
    ...result,
    requests: (result.requests ?? []).map(label),
    models: (result.models ?? []).map(label),
  }
}

export function filterSnapshot(snapshot, scope) {
  const { start, end } = scope
  const providers = Array.isArray(scope.providers) ? scope.providers : []
  const models = Array.isArray(scope.models) ? scope.models : []
  const requests = (Array.isArray(snapshot.requests) ? snapshot.requests : []).filter((request) => {
    return request.date !== 'unknown' && request.date >= start && request.date <= end
      && rowMatches(request.provider, providers) && rowMatches(request.modelId, models)
  })
  const days = new Map()
  // Hourly buckets are built only for a single-day scope, which is the one case
  // the chart plots in hours (今天, or a one-day custom range). The axis gets all
  // 24 slots even when nothing happened at 03:00, so a quiet hour keeps its
  // place instead of the bars silently closing the gap. A caller may pin the
  // granularity (scopeFromParams does, to keep 全部时间 daily); without it, a
  // one-day scope is the signal.
  const hourly = (scope.granularity ?? (start === end ? 'hour' : 'day')) === 'hour'
  const hours = hourly ? Array.from({ length: 24 }, (_, hour) => ({
    hour, date: start, calls: 0, tokens: tokenValues(), cost: emptyCost(),
  })) : null
  const modelGroups = new Map()
  const providerGroups = new Map()
  const tokens = tokenValues()
  const sessions = new Set()
  const turns = new Set()
  let earliest = null
  let latest = null

  for (const request of requests) {
    const requestTokens = request.tokens ?? tokenValues()
    const day = days.get(request.date) ?? {
      date: request.date, calls: 0, tokens: tokenValues(), cost: emptyCost(),
      sessions: new Set(), turns: new Set(),
    }
    day.calls += 1
    addTokenValues(day.tokens, requestTokens)
    addCosts(day.cost, request.cost ?? emptyCost())
    day.sessions.add(request.sessionId)
    const turn = String(request.id ?? '').split(':').slice(0, -1).join(':')
    day.turns.add(turn)
    days.set(request.date, day)

    if (hours !== null && Number.isFinite(request.time)) {
      const slot = hours[new Date(request.time).getHours()]
      slot.calls += 1
      addTokenValues(slot.tokens, requestTokens)
      addCosts(slot.cost, request.cost ?? emptyCost())
    }

    const providerKey = request.provider ?? 'unknown'
    const modelKey = `${providerKey}\u0000${request.modelId ?? 'unknown'}`
    const provider = providerGroups.get(providerKey) ?? {
      provider: request.provider ?? null, calls: 0, tokens: tokenValues(), cost: emptyCost(),
    }
    provider.calls += 1
    addTokenValues(provider.tokens, requestTokens)
    addCosts(provider.cost, request.cost ?? emptyCost())
    providerGroups.set(providerKey, provider)

    const model = modelGroups.get(modelKey) ?? {
      modelId: request.modelId ?? 'unknown', provider: request.provider ?? null,
      calls: 0, tokens: tokenValues(), cost: emptyCost(),
    }
    model.calls += 1
    addTokenValues(model.tokens, requestTokens)
    addCosts(model.cost, request.cost ?? emptyCost())
    modelGroups.set(modelKey, model)

    addTokenValues(tokens, requestTokens)
    sessions.add(request.sessionId)
    turns.add(turn)
    if (request.time !== null && request.time !== undefined) {
      if (earliest === null || request.time < earliest) earliest = request.time
      if (latest === null || request.time > latest) latest = request.time
    }
  }
  const real = tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead
  const cacheable = tokens.input + tokens.cacheWrite + tokens.cacheRead
  const dayList = [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map((day) => ({
    date: day.date,
    calls: day.calls,
    sessions: day.sessions.size,
    turns: day.turns.size,
    tokens: day.tokens,
    realTokens: day.tokens.input + day.tokens.output + day.tokens.cacheWrite + day.tokens.cacheRead,
    hitRate: (day.tokens.input + day.tokens.cacheWrite + day.tokens.cacheRead) > 0
      ? day.tokens.cacheRead / (day.tokens.input + day.tokens.cacheWrite + day.tokens.cacheRead) : null,
    cost: day.cost,
  }))
  // Same shape as a day bucket so the chart can plot either one, plus `label`
  // for the axis: the client never has to know how an hour is spelled.
  const hourList = hours === null ? null : hours.map((slot) => ({
    hour: slot.hour,
    date: slot.date,
    label: `${String(slot.hour).padStart(2, '0')}:00`,
    calls: slot.calls,
    tokens: slot.tokens,
    realTokens: slot.tokens.input + slot.tokens.output + slot.tokens.cacheWrite + slot.tokens.cacheRead,
    hitRate: (slot.tokens.input + slot.tokens.cacheWrite + slot.tokens.cacheRead) > 0
      ? slot.tokens.cacheRead / (slot.tokens.input + slot.tokens.cacheWrite + slot.tokens.cacheRead) : null,
    cost: slot.cost,
  }))
  const modelList = [...modelGroups.values()].map((model) => ({
    ...model,
    realTokens: model.tokens.input + model.tokens.output + model.tokens.cacheWrite + model.tokens.cacheRead,
    hitRate: (model.tokens.input + model.tokens.cacheWrite + model.tokens.cacheRead) > 0
      ? model.tokens.cacheRead / (model.tokens.input + model.tokens.cacheWrite + model.tokens.cacheRead) : null,
    priced: model.cost.unpriced === 0,
  })).sort((a, b) => b.realTokens - a.realTokens)
  const providerList = [...providerGroups.values()].map((provider) => ({
    ...provider,
    realTokens: provider.tokens.input + provider.tokens.output + provider.tokens.cacheWrite + provider.tokens.cacheRead,
    hitRate: (provider.tokens.input + provider.tokens.cacheWrite + provider.tokens.cacheRead) > 0
      ? provider.tokens.cacheRead / (provider.tokens.input + provider.tokens.cacheWrite + provider.tokens.cacheRead) : null,
  })).sort((a, b) => b.realTokens - a.realTokens)
  return {
    scope: { start, end, providers, models },
    totals: {
      calls: requests.length,
      turns: turns.size,
      sessions: sessions.size,
      tokens,
      realTokens: real,
      hitRate: cacheable > 0 ? tokens.cacheRead / cacheable : null,
      cost: sumCosts(requests.map((request) => request.cost ?? emptyCost())),
    },
    days: dayList,
    // `granularity` is what the chart switches on; `hours` is null unless the
    // scope is a single day.
    granularity: hourly ? 'hour' : 'day',
    hours: hourList,
    providers: providerList,
    models: modelList,
    requests,
    allTime: {
      // Read the UNFILTERED snapshot, not the scoped rows above. Deriving this
      // from `requests` made "all time" shrink with the selected range and with
      // the provider/model filters, so a 7-day window reported it as 7 days of
      // usage and the label contradicted its own name.
      calls: Number.isFinite(snapshot.calls) ? snapshot.calls : requests.length,
      realTokens: Number.isFinite(snapshot.realTokens) ? snapshot.realTokens : real,
      earliest: Number.isFinite(snapshot.earliest) ? snapshot.earliest : earliest,
      latest: Number.isFinite(snapshot.latest) ? snapshot.latest : latest,
      sessions: Number.isFinite(snapshot.sessions) ? snapshot.sessions : sessions.size,
    },
  }
}

// ---------------------------------------------------------------------------
// Loopback guard. These routes only ever expose this machine's own usage, but a
// DNS-rebound page must not be able to read them, so the socket peer AND the
// Host header both have to say loopback. Writes additionally need the capability
// token handed out by GET /pricing, which a cross-origin page cannot read.
// ---------------------------------------------------------------------------

function requestHeader(req, header) {
  const headers = isRecord(req) ? req.headers : null
  if (!isRecord(headers)) return undefined
  const value = headers[header]
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined
  return typeof value === 'string' ? value : undefined
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const value = address.trim().toLowerCase()
  if (value === '::1' || value === 'localhost') return true
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)) return true
  return /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value)
}

function isTrustedLocalRequest(req) {
  if (!isLoopbackAddress(req?.socket?.remoteAddress)) return false
  const host = requestHeader(req, 'host')
  if (typeof host !== 'string' || host === '') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!(hostUrl.hostname === 'localhost' || isLoopbackAddress(hostUrl.hostname))) return false
  if (requestHeader(req, 'sec-fetch-site') === 'cross-site') return false
  const origin = requestHeader(req, 'origin')
  // The desktop shell forwards requests with Origin stripped, so an absent
  // Origin is allowed; a present one must still be this same loopback origin.
  if (origin === undefined || origin === '') return true
  if (origin.startsWith('dsh-app://')) return true
  try {
    const originUrl = new URL(origin)
    return originUrl.protocol === 'http:' && originUrl.host === host
  } catch {
    return false
  }
}

function tokenEquals(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

async function readJsonBody(req, limit = 256 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) return { tooLarge: true }
    chunks.push(chunk)
  }
  try {
    return { body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { invalid: true }
  }
}

// ---------------------------------------------------------------------------
// Prices: the seed table plus user edits, keyed by model id.
// ---------------------------------------------------------------------------

function sanitizeRates(raw) {
  const out = {}
  for (const bucket of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    const n = Number(raw?.[bucket])
    if (!Number.isFinite(n) || n < 0) return null
    out[bucket] = String(n)
  }
  return out
}

/** Merge stored edits onto the seed table. Later rows win, so edits override. */
function mergePrices(stored) {
  const index = buildPriceIndex(DEFAULT_PRICES)
  if (!Array.isArray(stored)) return [...index.values()]
  for (const raw of stored) {
    if (!isRecord(raw) || typeof raw.modelId !== 'string') continue
    const id = raw.modelId.trim()
    const key = id.toLowerCase()
    const short = normalizeModelId(id)
    if (key === '') continue
    if (raw.removed === true) { index.delete(key); if (short !== '') index.delete(short); continue }
    const previous = index.get(key) ?? (short === '' ? undefined : index.get(short))
    const next = { ...(previous ?? {}), modelId: id }
    if (typeof raw.label === 'string' && raw.label !== '') next.label = raw.label
    const offPeak = sanitizeRates(raw.offPeak)
    if (offPeak !== null) next.offPeak = offPeak
    if (raw.peak === null) delete next.peak
    else { const peak = sanitizeRates(raw.peak); if (peak !== null) next.peak = peak }
    if (Array.isArray(raw.holidays)) {
      next.holidays = raw.holidays.filter((d) => typeof d === 'string' && DATE_PATTERN.test(d))
    }
    if (Number.isFinite(raw.effectiveFrom)) next.effectiveFrom = raw.effectiveFrom
    index.set(key, next)
    if (short !== '' && short !== key) index.set(short, next)
  }
  return [...index.values()]
}

/**
 * Collapse fold rows into one editable pricing candidate per price key.
 *
 * The key mirrors buildPriceIndex exactly — trimmed, lower-cased model id — so
 * a row can never address a slot the lookup would not read back. Rows that
 * differ only by provider therefore share one form row, and the totals shown
 * on it are the sum across every route that reached the model.
 */
export function pricingCandidates(models, resolver) {
  // Each stored row writes every slot lookupPrice would later read for it:
  // the full id, plus the trailing segment when that differs. Two fold rows
  // whose slot sets intersect drive the same index entry, so they must share
  // one form row however different their full ids look.
  const slotsOf = (modelId) => {
    const full = modelId.trim().toLowerCase()
    const short = normalizeModelId(modelId)
    return short === '' || short === full ? [full] : [full, short]
  }
  const groups = []
  const ownerOf = new Map()
  for (const model of Array.isArray(models) ? models : []) {
    const modelId = typeof model?.modelId === 'string' ? model.modelId : ''
    if (modelId.trim() === '') continue
    const slots = slotsOf(modelId)
    let group = null
    for (const slot of slots) {
      const found = ownerOf.get(slot)
      if (found !== undefined && group === null) group = found
      else if (found !== undefined && found !== group) group = mergeGroups(groups, group, found, ownerOf, slotsOf)
    }
    if (group === null) {
      const name = typeof resolver?.resolve === 'function' ? resolver.resolve(modelId) : null
      group = {
        modelId,
        displayName: typeof name === 'string' && name !== '' ? name : undefined,
        providers: [],
        calls: 0,
        realTokens: 0,
        priced: true,
        slots,
      }
      groups.push(group)
      for (const slot of slots) ownerOf.set(slot, group)
    }
    group.calls += Number(model.calls) || 0
    group.realTokens += Number(model.realTokens) || 0
    // Any route still missing a rate leaves the shared row unpriced: the price
    // is one index entry, so it is either set for every route or for none.
    if (model.priced === false) group.priced = false
    const provider = typeof model.provider === 'string' && model.provider !== '' ? model.provider : null
    if (provider !== null && !group.providers.includes(provider)) group.providers.push(provider)
  }
  return groups
    .map(({ slots, providers, ...rest }) => ({
      ...rest,
      // The row edits the full id; the short alias follows automatically
      // because mergePrices writes both from one entry.
      provider: providers.length === 1 ? providers[0] : (providers.length > 1 ? providers.join('+') : null),
    }))
    .sort((a, b) => b.realTokens - a.realTokens)
}

/** Join two groups that turned out to address the same index slot. */
function mergeGroups(groups, keep, drop, ownerOf, slotsOf) {
  keep.calls += drop.calls
  keep.realTokens += drop.realTokens
  if (!drop.priced) keep.priced = false
  for (const provider of drop.providers) if (!keep.providers.includes(provider)) keep.providers.push(provider)
  if (keep.displayName === undefined && drop.displayName !== undefined) keep.displayName = drop.displayName
  const merged = [...new Set([...keep.slots, ...drop.slots])]
  keep.slots = merged
  for (const slot of merged) ownerOf.set(slot, keep)
  const at = groups.indexOf(drop)
  if (at >= 0) groups.splice(at, 1)
  return keep
}


function publicPrice(entry) {
  return {
    modelId: entry.modelId,
    label: entry.label ?? null,
    offPeak: entry.offPeak ?? null,
    peak: entry.peak ?? null,
    holidays: Array.isArray(entry.holidays) ? entry.holidays : [],
    effectiveFrom: Number.isFinite(entry.effectiveFrom) ? entry.effectiveFrom : null,
  }
}

export function apply(ctx) {
  const storage = ctx.get('storage')
  const webServer = ctx.get('webServer')
  const sessionQuery = ctx.get('sessionQuery')

  const writeToken = randomBytes(32).toString('base64url')
  let prices = mergePrices(null)
  let aggregator = createAggregator({ prices })
  let kvUnit = null
  // Durable usage history: the only record that survives a deleted session.
  let historyKvUnit = null
  let history = createHistoryStore()
  let historyReady = false
  let historyDirty = false
  let backfillDone = false
  let backfill = null
  let revision = 0
  let cached = null
  let cachedRevision = -1
  // Display labels only: grouping, totals and pricing never consult this.
  const aliases = createAliasResolver(new Map())
  let aliasSources = []
  let aliasRefreshedAt = 0
  let scan = { started: false, done: false, total: 0, loaded: 0, failed: 0 }
  let baselineRunning = false
  let baselinePromise = null
  let disposed = false
  const livePending = new Set()
  let liveScheduled = false

  function bump() {
    revision += 1
    cached = null
    cachedRevision = -1
  }

  function snapshot() {
    if (cached !== null && cachedRevision === revision) return cached
    cached = aggregator.snapshot()
    cachedRevision = revision
    return cached
  }

  function payload(scope) {
    return {
      ok: true,
      revision,
      generatedAt: Date.now(),
      scan,
      // Provenance for the labels below. Without this a stale or missing
      // catalog is indistinguishable from a model that has no alias, and the
      // panel would quietly show route ids as if they were real names.
      catalog: {
        aliasCount: aliases.size(),
        sources: aliasSources.map((path) => path.split(/[\\/]/).pop()).filter(Boolean),
        refreshedAt: aliasRefreshedAt,
      },
      // Route ids are labelled after filtering, never inside the fold, so a
      // catalog that arrives late (or changes) only affects display.
      ...applyDisplayNames(filterSnapshot(snapshot(), scope), (modelId) => aliases.resolve(modelId)),
    }
  }

  async function refreshAliases() {
    try {
      const loaded = await loadModelAliases()
      aliases.replace(loaded.aliases)
      aliasSources = loaded.sources
      aliasRefreshedAt = Date.now()
    } catch (error) {
      // A missing or unreadable catalog is the normal state on a machine
      // without the Qoder plugin: keep the previous map and say nothing.
      console.warn('[dsh-usage-dashboard] model catalog unavailable:', error)
    }
  }

  // --- persistence ---------------------------------------------------------

  async function loadPrices() {
    try {
      const backend = storage?.backend?.get?.('json')
      if (backend?.kv === undefined) return
      kvUnit = await backend.kv.open({ name: KV_NAME, version: KV_VERSION, tables: [], hasGlobal: true })
      if (disposed) { await kvUnit.close().catch(() => {}); kvUnit = null; return }
      const snap = await kvUnit.loadAll()
      const stored = snap?.global?.prices
      if (Array.isArray(stored)) {
        prices = mergePrices(stored)
        aggregator = createAggregator({ prices })
        bump()
      }
    } catch (error) {
      console.error('[dsh-usage-dashboard] price storage unavailable:', error)
      kvUnit = null
    }
  }

  let writeChain = Promise.resolve()
  function persistPrices() {
    if (kvUnit === null || kvUnit === undefined) return writeChain
    const rows = prices.map(publicPrice)
    writeChain = writeChain
      .then(() => kvUnit.setGlobal({ prices: rows }))
      .catch((error) => console.error('[dsh-usage-dashboard] price persist failed:', error))
    return writeChain
  }

  // --- durable usage history ------------------------------------------------

  async function loadHistory() {
    try {
      const backend = storage?.backend?.get?.('json')
      if (backend?.kv === undefined) return
      historyKvUnit = await backend.kv.open({
        name: HISTORY_KV_NAME, version: HISTORY_KV_VERSION, tables: [], hasGlobal: true,
      })
      if (disposed) { await historyKvUnit.close().catch(() => {}); historyKvUnit = null; return }
      const snap = await historyKvUnit.loadAll()
      const stored = snap?.global?.history
      if (isRecord(stored)) history = createHistoryStore(stored)
      historyReady = true
    } catch (error) {
      console.error('[dsh-usage-dashboard] history storage unavailable:', error)
      historyKvUnit = null
      // Without durable history the panel still works, it just cannot outlive
      // a deletion. Keep folding live logs rather than refusing to start.
      historyReady = true
    }
  }

  let historyWriteChain = Promise.resolve()
  function persistHistory() {
    if (historyKvUnit === null || historyKvUnit === undefined) return historyWriteChain
    const body = history.toJSON()
    historyDirty = false
    historyWriteChain = historyWriteChain
      .then(() => historyKvUnit.setGlobal({ history: body }))
      .catch((error) => {
        historyDirty = true
        console.error('[dsh-usage-dashboard] history persist failed:', error)
      })
    return historyWriteChain
  }

  /**
   * Fold one finished scan into the durable history.
   *
   * Runs AFTER a complete baseline: absorbing a partial scan would leave the
   * store without rows for sessions this pass happened to skip, and the next
   * restart would then report less history than the previous one.
   */
  function absorbHistory(target = aggregator) {
    if (!historyReady) return
    const changed = history.absorb(target.snapshot().requests)
    if (changed > 0) historyDirty = true
    if (historyDirty) void persistHistory()
  }

  /**
   * Recover usage of sessions deleted before this feature existed.
   *
   * Runs once. `known` is what the scan could actually read, so every other
   * checkpoint belongs to a session that is already gone. After the first
   * success the durable store itself is authoritative about them and this
   * never needs to run again.
   *
   * Returns rows to fold; it does not touch `aggregator`, because the caller
   * owns the in-progress scan and folding them here would publish a view
   * missing the live logs.
   */
  async function backfillRows(known) {
    if (!historyReady || backfillDone) return []
    backfillDone = true
    const root = storage?.backend?.get?.('json')?.root
    if (typeof root !== 'string' || root === '') return []
    try {
      const { rows, failed } = await readBackfillRows(root, known)
      // What the store already holds is history, not a cache to be rebuilt:
      // a checkpoint total that was recovered once must not be recovered again
      // on the next start. Each session is admitted at most once, which is what
      // makes "read the saved data, never re-sum the past" true across starts.
      const recorded = history.sessionIds()
      const fresh = rows.filter((row) => !recorded.has(row.sessionId))
      backfill = { at: Date.now(), sessions: fresh.length, failed }
      if (fresh.length > 0) {
        console.info(`[dsh-usage-dashboard] recovered ${fresh.length} deleted session(s) from checkpoints`)
      }
      return fresh
    } catch (error) {
      // A backfill is an optimisation, never a startup requirement.
      console.error('[dsh-usage-dashboard] history backfill failed:', error)
      return []
    }
  }

  // --- scanning ------------------------------------------------------------

  async function listSessionIds() {
    const records = await sessionQuery.listSessions()
    const ids = []
    if (!Array.isArray(records)) return null
    for (const record of records) {
      const sid = record?.header?.id
      if (typeof sid === 'string') ids.push(sid)
    }
    return ids
  }

  async function loadOne(sid, target = aggregator) {
    const snap = await sessionQuery.readSession(sid)
    if (disposed) return
    if (!isRecord(snap) || !Array.isArray(snap.events)) {
      throw new Error(`sessionQuery.readSession(${sid}) returned malformed data`)
    }
    const events = snap.events
    target.loadSession(sid, events)
  }

  async function runBaseline() {
    // A second caller waits for the run in flight rather than returning early:
    // the pricing route answers only once the NEW price table has been folded,
    // otherwise it would report numbers from the table the user just replaced.
    if (baselineRunning && baselinePromise !== null) return baselinePromise
    if (disposed) return
    baselineRunning = true
    baselinePromise = (async () => {
      scan = { started: true, done: false, total: 0, loaded: 0, failed: 0 }
      bump()
      const nextAggregator = createAggregator({ prices })
      let complete = false
      try {
        // Retained rows go in FIRST: they describe calls whose sessions were
        // deleted, and folding the live logs afterwards lets an existing
        // session override any (possibly stale) retained copy of itself.
        if (historyReady) nextAggregator.loadRetained(history.rows())
        const ids = await listSessionIds()
        if (ids === null) {
          scan = { ...scan, failed: 1 }
          throw new Error('sessionQuery.listSessions() returned a non-array')
        }
        scan = { ...scan, total: ids.length }
        let chunkStart = Date.now()
        for (const sid of ids) {
          if (disposed) return
          try {
            await loadOne(sid, nextAggregator)
            scan = { ...scan, loaded: scan.loaded + 1 }
          } catch (error) {
            scan = { ...scan, failed: scan.failed + 1 }
            console.error(`[dsh-usage-dashboard] session read failed (${sid}):`, error)
          }
          if (Date.now() - chunkStart > BASELINE_CHUNK_MS) {
            chunkStart = Date.now()
            // `timeout` rejects when the fiber is disposed, which is a normal end.
            await ctx.timeout(0).catch(() => {})
          }
        }
        complete = scan.failed === 0
        // Recover sessions deleted before this feature existed. Done here (not
        // at startup) because it can only recognise them AFTER a scan knows
        // which ids the host still lists. The rows join the fold the snapshot
        // is built from, so the published view is never partial.
        if (complete && !disposed) {
          const recovered = await backfillRows(new Set(ids))
          if (recovered.length > 0) {
            // Only the recovered rows: `loadRetained` never overwrites a slot
            // the live fold already filled, so re-loading everything is wasted
            // work while the live logs stay authoritative.
            nextAggregator.loadRetained(recovered)
            history.absorb(recovered)
            historyDirty = true
          }
        }
      } catch (error) {
        console.error('[dsh-usage-dashboard] baseline failed:', error)
      } finally {
        if (complete && !disposed) {
          aggregator = nextAggregator
          // Record what this scan just measured, so the next scan still knows
          // about it after the session is deleted.
          absorbHistory(nextAggregator)
        }
        scan = { ...scan, done: true }
        baselineRunning = false
        baselinePromise = null
        bump()
      }
    })()
    return baselinePromise
  }

  // Live updates are debounced and reload the touched session from the host
  // rather than folding the event here: the durable log is the single truth, and
  // a partial fold could disagree with what the next baseline produces.
  function scheduleLive(sid) {
    livePending.add(sid)
    if (liveScheduled) return
    liveScheduled = true
    ctx.timeout(async () => {
      liveScheduled = false
      const pending = [...livePending]
      livePending.clear()
      for (const id of pending) {
        if (disposed) return
        try {
          await loadOne(id)
          bump()
        } catch (error) {
          console.error(`[dsh-usage-dashboard] live reload failed (${id}):`, error)
        }
      }
      // The reloaded session now has fresh rows; keep the durable copy in step
      // so deleting it later keeps everything it spent up to this moment.
      if (pending.length > 0) absorbHistory()
    }, LIVE_DEBOUNCE_MS)
  }

  // --- routes --------------------------------------------------------------

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-usage-dashboard/summary',
    handler: (req, res) => {
      if (req.method !== 'GET') { res.statusCode = 405; res.end(); return }
      if (!isTrustedLocalRequest(req)) { sendJson(res, 403, { ok: false, message: 'untrusted' }); return }
      const params = Object.fromEntries(new URL(req.url ?? '/', 'http://x').searchParams)
      // `days=all` needs the oldest record, which only the aggregator knows.
      sendJson(res, 200, payload(scopeFromParams(params, { earliest: snapshot().earliest })))
    },
  }))

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/api/dsh-usage-dashboard/pricing',
    handler: async (req, res) => {
      if (!isTrustedLocalRequest(req)) { sendJson(res, 403, { ok: false, message: 'untrusted' }); return }
      if (req.method === 'GET') {
        sendJson(res, 200, {
          ok: true,
          token: writeToken,
          prices: prices.map(publicPrice),
          // Fold rows are keyed by provider + route id, so one model reached
          // over two routes arrives twice here. Prices key off the MODEL alone
          // (see pricing.js), so two rows would edit the same index slot: the
          // form would show a value in one row and blank in the other, and the
          // later write would silently win. Collapse on the price key first.
          models: pricingCandidates(snapshot().models, aliases),
        })
        return
      }
      if (req.method !== 'POST') { res.statusCode = 405; res.end(); return }
      if (!tokenEquals(requestHeader(req, 'x-dsh-usage-dashboard-token'), writeToken)) {
        sendJson(res, 403, { ok: false, message: 'bad-token' })
        return
      }
      const parsed = await readJsonBody(req)
      if (parsed.tooLarge === true || parsed.invalid === true) {
        sendJson(res, 400, { ok: false, message: parsed.tooLarge ? 'too-large' : 'bad-body' })
        return
      }
      const rows = isRecord(parsed.body) && Array.isArray(parsed.body.prices) ? parsed.body.prices : null
      if (rows === null) { sendJson(res, 400, { ok: false, message: 'bad-prices' }); return }
      prices = mergePrices(rows)
      // The baseline publishes a fresh aggregator only after every session has
      // been read successfully, so keep the current view until then.
      await persistPrices()
      await runBaseline()
      sendJson(res, 200, { ok: true, revision, count: prices.length })
    },
  }))

  // --- lifecycle -----------------------------------------------------------

  ctx.on('session/event', (session, event) => {
    if (disposed || !scan.done) return
    const type = event?.type
    if (type !== 'assistant/message' && type !== 'assistant/chunk' && type !== 'request/header' && type !== 'request/context') return
    const sid = session?.id
    if (typeof sid !== 'string') return
    scheduleLive(sid)
  })

  ctx.on('session/flush', (session) => {
    if (disposed || !scan.done) return
    const sid = session?.id
    if (typeof sid === 'string') scheduleLive(sid)
  })

  ctx.effect(() => {
    const stop = ctx.interval(() => { void runBaseline() }, RECONCILE_INTERVAL_MS)
    return stop
  })

  ctx.effect(() => {
    const stop = ctx.interval(() => { void refreshAliases() }, ALIAS_REFRESH_MS)
    return stop
  })

  ctx.effect(() => async () => {
    disposed = true
    const unit = kvUnit
    const historyUnit = historyKvUnit
    kvUnit = null
    historyKvUnit = null
    await writeChain.catch(() => {})
    if (historyDirty) await persistHistory().catch(() => {})
    await historyWriteChain.catch(() => {})
    await unit?.close().catch(() => {})
    await historyUnit?.close().catch(() => {})
  })

  void (async () => {
    // Before the baseline so the first render already carries real names
    // rather than flashing route ids and correcting itself.
    await refreshAliases()
    await loadPrices()
    // Before the baseline so the first fold already includes the sessions
    // that no longer exist. Loading it later would publish a first snapshot
    // that is missing every deleted session's usage.
    await loadHistory()
    await runBaseline()
  })()
}

export default { name, inject, apply }
