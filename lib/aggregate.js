/**
 * Usage aggregation for dsh-usage-dashboard.
 *
 * One fold over the durable session log produces the same numbers whether it
 * runs over a historical snapshot or over live events, so a reload and a
 * running conversation agree.
 *
 * Token accounting follows the host's documented DISJOINT semantics
 * (`@deepseek-ai/dsh-llm`): `inputTokens` is uncached input only, and cached
 * input is reported separately as `cacheReadTokens` / `cacheWriteTokens`.
 * That makes "real consumed tokens" exactly
 *
 *     input + output + cacheWrite + cacheRead
 *
 * and the cache hit rate
 *
 *     cacheRead / (input + cacheWrite + cacheRead)
 *
 * Adapters that never report `cacheWriteTokens` (OpenAI-style protocols) simply
 * contribute 0 there, which is why the hit rate stays correct instead of
 * silently inflated.
 */

import { buildPriceIndex, lookupPrice, priceUsage, emptyCost, addCosts } from './pricing.js'

const ZERO = 0

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeInt(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.trunc(n)
}

function validTime(value) {
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null
}

/** Local (host timezone) calendar day, so "today" means the user's today. */
export function localDay(atMs) {
  const d = new Date(atMs)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function emptyTokens() {
  return { input: ZERO, output: ZERO, cacheRead: ZERO, cacheWrite: ZERO }
}

function addTokens(target, usage) {
  target.input += safeInt(usage?.inputTokens ?? usage?.input) ?? ZERO
  target.output += safeInt(usage?.outputTokens ?? usage?.output) ?? ZERO
  target.cacheRead += safeInt(usage?.cacheReadTokens ?? usage?.cacheRead) ?? ZERO
  target.cacheWrite += safeInt(usage?.cacheWriteTokens ?? usage?.cacheWrite) ?? ZERO
  return target
}

function isAllZero(tokens) {
  return tokens.input === 0 && tokens.output === 0 && tokens.cacheRead === 0 && tokens.cacheWrite === 0
}

/** Real consumed tokens, the cc-switch "真实消耗 Tokens" figure. */
export function realTokens(tokens) {
  return tokens.input + tokens.output + tokens.cacheWrite + tokens.cacheRead
}

/** Cache hit rate in 0..1, or null when nothing was cacheable. */
export function cacheHitRate(tokens) {
  const denominator = tokens.input + tokens.cacheWrite + tokens.cacheRead
  if (denominator <= 0) return null
  return tokens.cacheRead / denominator
}

/**
 * One call slot. `message` wins over `chunk` because a provider's final usage
 * report supersedes the streaming one for the same attempt; an all-zero chunk
 * never overwrites a recorded real number (replays and aborted requests).
 */
function makeSlot() {
  return { tokens: emptyTokens(), time: null, modelId: null, provider: null, hasMessage: false }
}

export function createAggregator(options = {}) {
  const priceIndex = buildPriceIndex(options.prices ?? [])
  // sessionId -> (turn:step -> slot). Replacing a whole session re-derives its
  // map, so a rewritten history cannot double count.
  const bySession = new Map()
  // sessionId -> { modelId, provider } carried by the newest request header.
  const sessionRoute = new Map()

  function routeFor(sid, event) {
    const current = sessionRoute.get(sid) ?? { modelId: null, provider: null }
    if (!isRecord(event) || !isRecord(event.data)) return current
    if (event.type === 'request/header') {
      const config = event.data.header?.config
      if (isRecord(config)) {
        return {
          modelId: typeof config.model === 'string' ? config.model : current.modelId,
          provider: typeof config.provider === 'string' ? config.provider : current.provider,
        }
      }
      return current
    }
    if (event.type === 'request/context') {
      const data = event.data
      return {
        modelId: typeof data.model === 'string' ? data.model : current.modelId,
        provider: typeof data.provider === 'string' ? data.provider : current.provider,
      }
    }
    return current
  }

  /** Extract one usage report, or null when the event carries none. */
  function usageOf(event) {
    if (!isRecord(event) || !isRecord(event.data)) return null
    const data = event.data
    if (event.type === 'assistant/chunk') {
      if (!isRecord(data.chunk) || data.chunk.type !== 'usage') return null
      return { usage: data.chunk.usage, kind: 'chunk', data }
    }
    if (event.type === 'assistant/message') {
      if (!Object.hasOwn(data, 'usage') || data.usage === undefined) return null
      return { usage: data.usage, kind: 'message', data }
    }
    return null
  }

  function slotKey(data) {
    const turn = safeInt(data?.turn)
    const step = safeInt(data?.step)
    if (turn === null || step === null) return null
    return `${turn}:${step}`
  }

  /** The slot a retained history row names, given `${sessionId}:<slot>` ids. */
  function retainedSlotKey(sessionId, id) {
    if (typeof id !== 'string' || id === '') return null
    const prefix = `${sessionId}:`
    if (id.startsWith(prefix)) {
      const rest = id.slice(prefix.length)
      return rest === '' ? null : rest
    }
    const at = id.indexOf(':')
    return at < 0 ? null : id.slice(at + 1)
  }

  function foldEvent(sessionId, event) {
    const extracted = usageOf(event)
    const time = validTime(event?.time)
    // Route tracking runs even for non-usage events: the model identity of a
    // later call comes from the header that precedes it.
    const route = routeFor(sessionId, event)
    if (route.modelId !== null || route.provider !== null) {
      const previous = sessionRoute.get(sessionId)
      if (previous?.modelId !== route.modelId || previous?.provider !== route.provider) {
        sessionRoute.set(sessionId, route)
      }
    }
    if (extracted === null) return
    const slots = bySession.get(sessionId)
    if (slots === undefined) return
    const key = slotKey(extracted.data)
    if (key === null) return
    const tokens = emptyTokens()
    addTokens(tokens, extracted.usage)
    // A replayed all-zero report must not erase a real one.
    if (isAllZero(tokens)) {
      const existing = slots.get(key)
      if (existing !== undefined && !isAllZero(existing.tokens)) return
    }
    const existing = slots.get(key) ?? makeSlot()
    if (existing.hasMessage && extracted.kind !== 'message') return
    const record = {
      tokens,
      time: time ?? existing.time,
      modelId: route.modelId ?? existing.modelId,
      provider: route.provider ?? existing.provider,
      hasMessage: existing.hasMessage || extracted.kind === 'message',
    }
    slots.set(key, record)
  }

  function resetSession(sessionId) {
    bySession.set(sessionId, new Map())
    sessionRoute.delete(sessionId)
  }

  function removeSession(sessionId) {
    bySession.delete(sessionId)
    sessionRoute.delete(sessionId)
  }

  /** Load one complete session log, replacing any previous view of it. */
  function loadSession(sessionId, events) {
    resetSession(sessionId)
    if (!Array.isArray(events)) return
    for (const event of events) foldEvent(sessionId, event)
  }

  /**
   * Load rows recovered from the durable history store.
   *
   * These describe call slots the aggregator may no longer be able to read:
   * the session they belonged to was deleted, so `sessionQuery` will never
   * list it again and its log can never be folded. Without them a deletion
   * silently subtracts real usage from every total.
   *
   * Ordering is part of the contract: call this BEFORE the session logs are
   * folded, so a session that still exists is always measured from its own
   * log and a stale retained copy can never win.
   */
  function loadRetained(rows) {
    if (!Array.isArray(rows)) return
    for (const row of rows) {
      if (!isRecord(row) || typeof row.sessionId !== 'string') continue
      const key = retainedSlotKey(row.sessionId, row.id)
      if (key === null) continue
      const tokens = emptyTokens()
      addTokens(tokens, row.tokens)
      if (isAllZero(tokens)) continue
      let slots = bySession.get(row.sessionId)
      if (slots === undefined) {
        slots = new Map()
        bySession.set(row.sessionId, slots)
      }
      const existing = slots.get(key)
      // A live fold of the same slot is authoritative; keep it.
      if (existing !== undefined && !isAllZero(existing.tokens)) continue
      const time = validTime(row.time)
      if (existing !== undefined) {
        slots.set(key, {
          ...existing,
          tokens,
          time: time ?? existing.time,
          modelId: existing.modelId ?? (typeof row.modelId === 'string' ? row.modelId : null),
          provider: existing.provider ?? (typeof row.provider === 'string' ? row.provider : null),
        })
        continue
      }
      slots.set(key, {
        tokens,
        time,
        modelId: typeof row.modelId === 'string' ? row.modelId : null,
        provider: typeof row.provider === 'string' ? row.provider : null,
        hasMessage: true,
      })
      const route = sessionRoute.get(row.sessionId) ?? { modelId: null, provider: null }
      if (route.modelId === null && typeof row.modelId === 'string') {
        sessionRoute.set(row.sessionId, {
          modelId: row.modelId,
          provider: route.provider ?? (typeof row.provider === 'string' ? row.provider : null),
        })
      }
    }
  }

  /** Apply one live event to an already-loaded session. */
  function applyEvent(sessionId, event) {
    if (!bySession.has(sessionId)) resetSession(sessionId)
    foldEvent(sessionId, event)
  }

  /**
   * Fold everything into day / model buckets.
   *
   * `days` is keyed by local calendar day; `models` by model id. Both carry the
   * same totals so a range query can merge days without touching per-call rows.
   */
  function snapshot() {
    const days = new Map()
    const models = new Map()
    const providers = new Map()
    const requests = []
    const totals = { calls: 0, tokens: emptyTokens(), cost: emptyCost(), turns: new Set() }
    let earliest = null
    let latest = null

    for (const [sessionId, slots] of bySession) {
      for (const [key, record] of slots) {
        const tokens = record.tokens
        const calls = 1
        const day = record.time === null ? 'unknown' : localDay(record.time)
        const dayEntry = days.get(day) ?? {
          date: day, calls: 0, tokens: emptyTokens(), cost: emptyCost(),
          sessions: new Set(), turns: new Set(),
        }
        dayEntry.calls += calls
        addTokens(dayEntry.tokens, tokens)
        dayEntry.sessions.add(sessionId)
        dayEntry.turns.add(`${sessionId}:${key.split(':')[0]}`)

        const modelKey = record.modelId ?? 'unknown'
        const providerKey = record.provider ?? 'unknown'
        const modelAggregateKey = `${providerKey}\u0000${modelKey}`
        const modelEntry = models.get(modelAggregateKey) ?? {
          modelId: modelKey, provider: record.provider ?? null,
          calls: 0, tokens: emptyTokens(), cost: emptyCost(),
        }
        modelEntry.calls += calls
        addTokens(modelEntry.tokens, tokens)
        if (record.provider && !modelEntry.provider) modelEntry.provider = record.provider
        const providerEntry = providers.get(providerKey) ?? {
          provider: record.provider ?? null, calls: 0, tokens: emptyTokens(), cost: emptyCost(),
        }
        providerEntry.calls += calls
        addTokens(providerEntry.tokens, tokens)

        totals.calls += calls
        addTokens(totals.tokens, tokens)
        for (const turn of dayEntry.turns) totals.turns.add(turn)

        if (record.time !== null) {
          if (earliest === null || record.time < earliest) earliest = record.time
          if (latest === null || record.time > latest) latest = record.time
        }

        // Price per call so a peak/off-peak band can be chosen from its own time.
        const entry = lookupPrice(priceIndex, modelKey)
        const cost = entry === null ? null : priceUsage(entry, tokens, record.time ?? Date.now())
        if (cost === null) {
          dayEntry.cost.unpriced += calls
          modelEntry.cost.unpriced += calls
          providerEntry.cost.unpriced += calls
          totals.cost.unpriced += calls
        } else {
          addCosts(dayEntry.cost, cost)
          addCosts(modelEntry.cost, cost)
          addCosts(providerEntry.cost, cost)
          addCosts(totals.cost, cost)
        }
        requests.push({
          id: `${sessionId}:${key}`,
          sessionId,
          time: record.time,
          date: day,
          provider: record.provider,
          modelId: record.modelId,
          tokens: { ...tokens },
          realTokens: realTokens(tokens),
          hitRate: cacheHitRate(tokens),
          cost: cost ?? { ...emptyCost(), unpriced: 1 },
          status: 'complete',
        })
        days.set(day, dayEntry)
        models.set(modelAggregateKey, modelEntry)
        providers.set(providerKey, providerEntry)
      }
    }

    const dayList = [...days.values()]
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((entry) => ({
        date: entry.date,
        calls: entry.calls,
        sessions: entry.sessions.size,
        turns: entry.turns.size,
        tokens: entry.tokens,
        realTokens: realTokens(entry.tokens),
        hitRate: cacheHitRate(entry.tokens),
        cost: entry.cost,
      }))

    const modelList = [...models.values()]
      .map((entry) => ({
        modelId: entry.modelId,
        provider: entry.provider,
        calls: entry.calls,
        tokens: entry.tokens,
        realTokens: realTokens(entry.tokens),
        hitRate: cacheHitRate(entry.tokens),
        cost: entry.cost,
        priced: lookupPrice(priceIndex, entry.modelId) !== null,
      }))
      .sort((a, b) => b.realTokens - a.realTokens)

    const providerList = [...providers.values()]
      .map((entry) => ({
        provider: entry.provider,
        calls: entry.calls,
        tokens: entry.tokens,
        realTokens: realTokens(entry.tokens),
        hitRate: cacheHitRate(entry.tokens),
        cost: entry.cost,
      }))
      .sort((a, b) => b.realTokens - a.realTokens)

    return {
      calls: totals.calls,
      turns: totals.turns.size,
      sessions: bySession.size,
      tokens: totals.tokens,
      realTokens: realTokens(totals.tokens),
      hitRate: cacheHitRate(totals.tokens),
      cost: totals.cost,
      earliest,
      latest,
      days: dayList,
      models: modelList,
      providers: providerList,
      requests: requests.sort((a, b) => (a.time ?? 0) - (b.time ?? 0)),
    }
  }

  function sessionCount() {
    return bySession.size
  }

  function callCount() {
    let total = 0
    for (const slots of bySession.values()) total += slots.size
    return total
  }

  return { loadSession, loadRetained, applyEvent, removeSession, resetSession, snapshot, sessionCount, callCount }
}
