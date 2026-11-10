import test from 'node:test'
import assert from 'node:assert/strict'
import { createAggregator } from '../lib/aggregate.js'
import { createHistoryStore } from '../lib/history.js'

/**
 * Regression: deleting a conversation must not erase its usage from history.
 *
 * The panel folds only what `sessionQuery.listSessions()` still returns, so a
 * deleted session silently subtracts its tokens from every total — on this
 * machine that was ~3.1B of 6.67B. The fix keeps a durable per-session cost
 * record that outlives the log.
 */

const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({
  inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
})

function events(sessionId, steps) {
  const out = [{ type: 'session', id: sessionId, time: 1_700_000_000_000 }]
  for (const [turn, step, u] of steps) {
    out.push({
      type: 'assistant/message',
      seq: turn * 100 + step,
      time: 1_700_000_000_000 + turn * 1000,
      data: { turn, step, usage: u },
    })
  }
  return out
}

test('a session that disappears from disk keeps contributing its usage', () => {
  const aggregator = createAggregator()
  aggregator.loadSession('s-alive', events('s-alive', [[1, 1, usage(100, 10, 900)]]))
  aggregator.loadSession('s-gone', events('s-gone', [[1, 1, usage(200, 20, 1800)]]))
  assert.equal(aggregator.snapshot().realTokens, 3030)

  // The user deletes the conversation: the log is gone, the host stops listing it.
  const retained = aggregator.snapshot().requests
  const store = createHistoryStore()
  store.absorb(retained)

  const afterDelete = createAggregator()
  afterDelete.loadSession('s-alive', events('s-alive', [[1, 1, usage(100, 10, 900)]]))
  afterDelete.loadRetained(store.rows())

  assert.equal(afterDelete.snapshot().realTokens, 3030, 'deleting a session must not shrink history')
})

test('a retained session is replaced, never double counted as it grows', () => {
  const store = createHistoryStore()
  const first = createAggregator()
  first.loadSession('s1', events('s1', [[1, 1, usage(100, 10)]]))
  store.absorb(first.snapshot().requests)

  const grown = createAggregator()
  grown.loadSession('s1', events('s1', [[1, 1, usage(100, 10)], [2, 1, usage(300, 30)]]))
  store.absorb(grown.snapshot().requests)

  assert.equal(store.rows().length, 2, 'one row per call slot, not per scan')

  const folded = createAggregator()
  folded.loadRetained(store.rows())
  assert.equal(folded.snapshot().realTokens, 440)
})

test('retained rows never override a live log that still exists', () => {
  const store = createHistoryStore()
  const aggregator = createAggregator()
  aggregator.loadSession('s1', events('s1', [[1, 1, usage(500, 50)]]))
  store.absorb(aggregator.snapshot().requests)

  // A live session is authoritative: a stale retained row must lose to it.
  const rebuilt = createAggregator()
  rebuilt.loadSession('s1', events('s1', [[1, 1, usage(100, 10)]]))
  rebuilt.loadRetained(store.rows())
  assert.equal(rebuilt.snapshot().realTokens, 110)
})

test('history rows survive a JSON round trip with their day and model intact', () => {
  const aggregator = createAggregator()
  aggregator.loadSession('s1', events('s1', [[1, 1, usage(100, 10, 900)]]))
  const store = createHistoryStore()
  store.absorb(aggregator.snapshot().requests)

  const restored = createHistoryStore(JSON.parse(JSON.stringify(store.toJSON())))
  const folded = createAggregator()
  folded.loadRetained(restored.rows())
  const snapshot = folded.snapshot()
  assert.equal(snapshot.realTokens, 1010)
  assert.equal(snapshot.days.length, 1)
  assert.equal(snapshot.requests[0].tokens.cacheRead, 900)
})
