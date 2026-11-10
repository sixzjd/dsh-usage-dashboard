/**
 * One-shot backfill of usage for sessions whose log is already gone.
 *
 * The durable history store only starts helping from the moment it is turned
 * on; sessions deleted BEFORE that have no retained row. Their totals do
 * survive in one place: the host's persisted session-projection checkpoint
 * (`<storage root>/session_projcache/sessions/<id>.json`), whose `tokenUsage`
 * row carries the whole-log `uncachedInputTokens` / `outputTokens` /
 * `cacheReadTokens` / `cacheWriteTokens` for that session.
 *
 * This module reads those checkpoints directly, for three reasons:
 *
 *  - `sessionQuery` cannot help: it lists sessions, and a deleted session is
 *    by definition no longer listed.
 *  - The host exposes no service that serves projections for a session that
 *    no longer exists, so there is no public API to call.
 *  - The files are a documented, stable on-disk layout of a shipped package,
 *    and this is a read-only, best-effort backfill: anything unreadable is
 *    skipped rather than guessed at.
 *
 * What it CANNOT recover: a per-day or per-model split. `tokenUsage` is one
 * whole-session figure. The row is therefore anchored at the session's
 * creation time and recorded as a single synthetic call, which keeps day and
 * model totals honest at the session level and never invents a distribution.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** The on-disk location of the projection checkpoints, relative to a JSON storage root. */
export const PROJCACHE_DIR = 'session_projcache/sessions'

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function safeInt(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.trunc(n)
}

/**
 * Read one `tokenUsage` checkpoint document.
 *
 * Returns `null` for anything that is not a usable checkpoint: an unreadable
 * file, invalid JSON, a missing row, or an all-zero total. A backfill that
 * cannot prove a number must contribute nothing rather than a guess.
 */
export function parseCheckpoint(document, sessionId) {
  if (!isRecord(document)) return null
  const record = isRecord(document.record) ? document.record : null
  if (record === null) return null
  const rows = isRecord(record.rows) ? record.rows : null
  if (rows === null) return null
  const usageRow = isRecord(rows.tokenUsage) ? rows.tokenUsage : null
  if (usageRow === null) return null
  const totals = isRecord(usageRow.val) ? usageRow.val.totals : null
  if (!isRecord(totals)) return null
  const tokens = {
    input: safeInt(totals.uncachedInputTokens ?? totals.inputTokens ?? totals.input),
    output: safeInt(totals.outputTokens ?? totals.output),
    cacheRead: safeInt(totals.cacheReadTokens ?? totals.cacheRead),
    cacheWrite: safeInt(totals.cacheWriteTokens ?? totals.cacheWrite),
  }
  if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0) return null
  const identity = isRecord(record.identity) ? record.identity : {}
  const createdAt = Number(identity.createdAt)
  return {
    id: `${sessionId}:retained`,
    sessionId,
    time: Number.isFinite(createdAt) && createdAt >= 0 ? Math.trunc(createdAt) : null,
    date: null,
    provider: null,
    modelId: null,
    tokens,
  }
}

/**
 * Collect backfill rows for sessions the current scan did not find.
 *
 * `known` is the set of session ids the scan DID find; only sessions outside
 * it are considered, so a live session is never backfilled from a checkpoint
 * (its log is authoritative and already more precise).
 */
export async function readBackfillRows(root, known, options = {}) {
  const dir = join(root, PROJCACHE_DIR)
  const limit = Number.isFinite(options.limit) ? Math.trunc(options.limit) : Infinity
  const skip = known instanceof Set ? known : new Set(known ?? [])
  let names
  try {
    names = await readdir(dir)
  } catch {
    // No checkpoint directory is a normal state (fresh install, other backend).
    return { rows: [], scanned: 0, failed: 0 }
  }
  const rows = []
  let scanned = 0
  let failed = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const sessionId = name.slice(0, -'.json'.length)
    if (sessionId === '' || skip.has(sessionId)) continue
    if (scanned >= limit) break
    scanned += 1
    try {
      const text = await readFile(join(dir, name), 'utf8')
      const row = parseCheckpoint(JSON.parse(text), sessionId)
      if (row !== null) rows.push(row)
    } catch {
      failed += 1
    }
  }
  return { rows, scanned, failed }
}
