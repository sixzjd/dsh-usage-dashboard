/**
 * Durable per-call usage history for dsh-usage-dashboard.
 *
 * Why this exists
 * ---------------
 * The panel's only data source is `sessionQuery`, which by construction only
 * sees the logs that still exist on disk. That makes a DELETION look like a
 * real drop in usage: the moment a conversation is deleted, every token it
 * ever spent disappears from every total. On the machine that motivated this
 * module, 362 deleted sessions were worth ~3.1B tokens against a 6.67B
 * lifetime figure — the panel showed 3.5B and looked like it had lost half
 * the history.
 *
 * The fix is to stop treating "the log still exists" as the definition of
 * history. Every scan records what each call slot cost into a durable store;
 * a later scan that no longer sees a session keeps paying its recorded rows
 * forward. Deleting a conversation stops it from growing, never from counting.
 *
 * Two invariants make that safe:
 *
 *  - A retained row is keyed by `${sessionId}:${turn}:${step}` — the same slot
 *    the fold uses — so rescanning a surviving session replaces rather than
 *    duplicates it.
 *  - A live log always wins. Retained rows load first and live log rows are
 *    set afterwards, so a session that still exists is measured from its log
 *    and never from a possibly stale copy of it.
 *
 * Rows are pruned by age, not by session count, so an idle month cannot push
 * real history out of the store.
 */

const TABLE = 'usage_history'
const VERSION = 1

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeInt(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.trunc(n)
}

function tokensOf(raw) {
  return {
    input: safeInt(raw?.input),
    output: safeInt(raw?.output),
    cacheRead: safeInt(raw?.cacheRead),
    cacheWrite: safeInt(raw?.cacheWrite),
  }
}

function isAllZero(tokens) {
  return tokens.input === 0 && tokens.output === 0 && tokens.cacheRead === 0 && tokens.cacheWrite === 0
}

/** One retained row: the durable form of a single call slot. */
function toRow(request) {
  if (!isRecord(request)) return null
  const id = typeof request.id === 'string' ? request.id : null
  if (id === null || id === '') return null
  const tokens = tokensOf(request.tokens)
  if (isAllZero(tokens)) return null
  return {
    id,
    sessionId: typeof request.sessionId === 'string' ? request.sessionId : id.split(':')[0],
    time: Number.isFinite(request.time) ? Math.trunc(request.time) : null,
    date: typeof request.date === 'string' ? request.date : null,
    provider: typeof request.provider === 'string' ? request.provider : null,
    modelId: typeof request.modelId === 'string' ? request.modelId : null,
    tokens,
  }
}

/**
 * The in-memory index over retained rows.
 *
 * `absorb` takes a snapshot's request rows; `rows` returns what a fresh
 * aggregator should reload through `loadRetained`. Persist `toJSON()` and hand
 * it back to the constructor on the next start.
 */
export function createHistoryStore(initial = null) {
  const rows = new Map()

  if (isRecord(initial) && Array.isArray(initial.rows)) {
    for (const raw of initial.rows) {
      const row = toRow({ ...raw, id: raw?.id, sessionId: raw?.sessionId, date: raw?.date })
      if (row !== null) rows.set(row.id, row)
    }
  }

  /**
   * Record every row of one snapshot.
   *
   * A row already present is REPLACED, which is what keeps a growing session
   * from being counted twice: the latest scan of that slot is the truth.
   */
  function absorb(requests) {
    if (!Array.isArray(requests)) return 0
    let changed = 0
    for (const request of requests) {
      const row = toRow(request)
      if (row === null) continue
      const previous = rows.get(row.id)
      if (previous !== undefined && sameRow(previous, row)) continue
      rows.set(row.id, row)
      changed += 1
    }
    return changed
  }

  function sameRow(a, b) {
    return a.time === b.time && a.date === b.date && a.provider === b.provider
      && a.modelId === b.modelId && a.tokens.input === b.tokens.input
      && a.tokens.output === b.tokens.output && a.tokens.cacheRead === b.tokens.cacheRead
      && a.tokens.cacheWrite === b.tokens.cacheWrite
  }

  /** Drop rows for sessions that no longer exist AND are older than a cut. */
  function prune(keepSessionIds, beforeMs) {
    const keep = keepSessionIds instanceof Set ? keepSessionIds : new Set(keepSessionIds ?? [])
    let removed = 0
    for (const [id, row] of rows) {
      if (keep.has(row.sessionId)) continue
      if (beforeMs !== null && row.time !== null && row.time >= beforeMs) continue
      rows.delete(id)
      removed += 1
    }
    return removed
  }

  function rows_() {
    return [...rows.values()].map((row) => ({ ...row, tokens: { ...row.tokens } }))
  }

  function toJSON() {
    return { version: VERSION, rows: rows_() }
  }

  function size() {
    return rows.size
  }

  function sessionIds() {
    return new Set([...rows.values()].map((row) => row.sessionId))
  }

  return { absorb, prune, rows: rows_, toJSON, size, sessionIds, table: TABLE }
}
