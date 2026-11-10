import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAggregator } from '../lib/aggregate.js'
import { createHistoryStore } from '../lib/history.js'
import { readBackfillRows } from '../lib/backfill.js'

/**
 * Saved history is history, not a cache to be rebuilt.
 *
 * A checkpoint total describes one deleted session. Recovering it on every
 * start would re-sum the past, and any store that also holds a per-day split
 * for the same session would then count that usage twice. The guard is that a
 * session is admitted at most once.
 */

const DIR = 'session_projcache/sessions'

function checkpoint(input) {
  return JSON.stringify({
    version: 7,
    record: {
      identity: { formatVersion: 4, createdAt: 1_700_000_000_000, cwd: '/tmp', isSeeded: false },
      rows: {
        tokenUsage: { ver: 2, seq: 10, val: { totals: {
          uncachedInputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        } } },
      },
    },
  })
}

/** One simulated start: read checkpoints, admit only sessions not yet stored. */
async function boot(root, history) {
  const { rows } = await readBackfillRows(root, new Set())
  const recorded = history.sessionIds()
  const fresh = rows.filter((row) => !recorded.has(row.sessionId))
  history.absorb(fresh)
  const agg = createAggregator()
  agg.loadRetained(history.rows())
  return { fresh, total: agg.snapshot().realTokens }
}

test('a session is recovered once and never re-summed on later starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'once-'))
  try {
    await mkdir(join(root, DIR), { recursive: true })
    await writeFile(join(root, DIR, 's1.json'), checkpoint(100))
    await writeFile(join(root, DIR, 's2.json'), checkpoint(200))

    const history = createHistoryStore()

    const first = await boot(root, history)
    assert.equal(first.fresh.length, 2)
    assert.equal(first.total, 300)

    for (let start = 2; start <= 4; start++) {
      const next = await boot(root, history)
      assert.equal(next.fresh.length, 0, `start ${start} must not re-admit a recorded session`)
      assert.equal(next.total, 300, `start ${start} must not grow the total`)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a newly deleted session is still recovered on the next start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'once-'))
  try {
    await mkdir(join(root, DIR), { recursive: true })
    await writeFile(join(root, DIR, 's1.json'), checkpoint(100))

    const history = createHistoryStore()
    const first = await boot(root, history)
    assert.equal(first.total, 100)

    // A second session is deleted between starts.
    await writeFile(join(root, DIR, 's2.json'), checkpoint(200))
    const second = await boot(root, history)
    assert.equal(second.fresh.length, 1, 'only the new session is admitted')
    assert.equal(second.total, 300)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a stored per-day split is never joined by a whole-session total', async () => {
  // This is the shape that doubled a lifetime figure: one session recorded as
  // per-day rows, with a checkpoint total still available to re-add.
  const root = await mkdtemp(join(tmpdir(), 'once-'))
  try {
    await mkdir(join(root, DIR), { recursive: true })
    await writeFile(join(root, DIR, 's1.json'), checkpoint(300))

    const history = createHistoryStore()
    history.absorb([
      { id: 's1:retained:2026-10-19', sessionId: 's1', time: null, date: '2026-10-19',
        provider: null, modelId: null, tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } },
      { id: 's1:retained:2026-10-20', sessionId: 's1', time: null, date: '2026-10-20',
        provider: null, modelId: null, tokens: { input: 200, output: 0, cacheRead: 0, cacheWrite: 0 } },
    ])

    const run = await boot(root, history)
    assert.equal(run.fresh.length, 0, 'the session is already recorded')
    assert.equal(run.total, 300, 'the split stays 300, not 600')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
