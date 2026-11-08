import test from 'node:test'
import assert from 'node:assert/strict'
import { filterSnapshot, scopeFromParams } from '../lib/plugin.js'
import { createAggregator } from '../lib/aggregate.js'

const cost = (total, unpriced = 0) => ({
  currency: 'USD',
  input: total,
  output: '0',
  cacheRead: '0',
  cacheWrite: '0',
  total,
  priced: unpriced === 0 ? 1 : 0,
  unpriced,
})

function request(id, date, provider, modelId, input, total) {
  return {
    id, sessionId: id.split(':')[0], time: Date.parse(`${date}T12:00:00Z`), date,
    provider, modelId, tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
    realTokens: input, hitRate: 0, cost: cost(total), status: 'complete',
  }
}

test('normalizes inverted dates and parses comma-separated filters', () => {
  assert.deepEqual(scopeFromParams({
    start: '2026-10-09',
    end: '2026-10-01',
    provider: ' alpha, beta,alpha ',
    model: 'model-a, model-b',
  }), {
    start: '2026-10-01',
    end: '2026-10-09',
    granularity: 'day',
    providers: ['alpha', 'beta'],
    models: ['model-a', 'model-b'],
  })
})

test('filters requests and rebuilds totals and groups from selected rows', () => {
  const snapshot = {
    calls: 3,
    requests: [
      request('s1:1:1', '2026-10-01', 'alpha', 'model-a', 10, '1'),
      request('s1:2:1', '2026-10-02', 'beta', 'model-b', 20, '2'),
      request('s2:1:1', '2026-10-03', 'alpha', 'model-a', 30, '3'),
    ],
  }
  const result = filterSnapshot(snapshot, {
    start: '2026-10-01',
    end: '2026-10-02',
    providers: ['alpha'],
    models: [],
  })
  assert.equal(result.requests.length, 1)
  assert.equal(result.totals.calls, 1)
  assert.equal(result.totals.sessions, 1)
  assert.equal(result.totals.turns, 1)
  assert.equal(result.totals.realTokens, 10)
  assert.equal(result.totals.cost.total, '1')
  assert.deepEqual(result.providers.map(({ provider, calls }) => ({ provider, calls })), [
    { provider: 'alpha', calls: 1 },
  ])
  assert.deepEqual(result.models.map(({ modelId, calls }) => ({ modelId, calls })), [
    { modelId: 'model-a', calls: 1 },
  ])
  assert.deepEqual(result.days.map(({ date, calls }) => ({ date, calls })), [
    { date: '2026-10-01', calls: 1 },
  ])
  // allTime describes the whole snapshot, not the selected range: the scope
  // keeps one request while the snapshot carries three. realTokens falls back to
  // the scoped total because this partial fixture omits the unfiltered figure.
  assert.equal(result.allTime.calls, 3)
  assert.equal(result.allTime.realTokens, 10)
})

test('rebuilds priced daily cost when filtering requests', () => {
  const result = filterSnapshot({
    requests: [request('s1:1:1', '2026-10-01', 'alpha', 'model-a', 10, '1.25')],
  }, { start: '2026-10-01', end: '2026-10-01', providers: [], models: [] })

  assert.equal(result.days[0].cost.total, '1.25')
  assert.equal(result.totals.cost.total, '1.25')
})

test('preserves unknown model unpriced state in request and filtered aggregates', () => {
  const aggregator = createAggregator()
  aggregator.loadSession('session-unknown', [
    { type: 'request/context', time: 0, data: { provider: 'mystery', model: 'not-priced' } },
    { type: 'assistant/message', time: 0, data: { turn: 1, step: 1, usage: { inputTokens: 4 } } },
  ])
  const result = filterSnapshot(aggregator.snapshot(), {
    start: '1970-01-01', end: '1970-01-01', providers: [], models: [],
  })

  assert.equal(result.requests[0].cost.unpriced, 1)
  assert.equal(result.totals.cost.unpriced, 1)
  assert.equal(result.providers[0].cost.unpriced, 1)
  assert.equal(result.models[0].cost.unpriced, 1)
  assert.equal(result.models[0].priced, false)
})

test('allTime reports the unfiltered whole history, not the selected range', () => {
  // Regression: allTime was recomputed from the already-filtered rows, so a
  // 7-day window reported "all time" as 7 days and a provider filter narrowed
  // it further. The label contradicted its own name.
  const snapshot = {
    calls: 9,
    realTokens: 900,
    earliest: Date.parse('2026-09-01T12:00:00Z'),
    latest: Date.parse('2026-10-09T12:00:00Z'),
    sessions: 4,
    requests: [
      request('s1:1:1', '2026-09-01', 'alpha', 'model-a', 10, '1'),
      request('s2:1:1', '2026-09-20', 'beta', 'model-b', 20, '2'),
      request('s3:1:1', '2026-10-09', 'alpha', 'model-a', 30, '3'),
    ],
  }

  const narrow = filterSnapshot(snapshot, {
    start: '2026-10-01', end: '2026-10-31', providers: [], models: [],
  })

  // The range keeps only one request, but allTime must still describe all nine.
  assert.equal(narrow.requests.length, 1)
  assert.equal(narrow.totals.calls, 1)
  assert.equal(narrow.allTime.calls, 9)
  assert.equal(narrow.allTime.realTokens, 900)
  assert.equal(narrow.allTime.sessions, 4)
  assert.equal(narrow.allTime.earliest, snapshot.earliest)
  assert.equal(narrow.allTime.latest, snapshot.latest)

  // A provider filter must not shrink allTime either.
  const filtered = filterSnapshot(snapshot, {
    start: '2026-09-01', end: '2026-10-31', providers: ['alpha'], models: [],
  })
  assert.equal(filtered.totals.calls, 2)
  assert.equal(filtered.allTime.calls, 9)
})

test('allTime falls back to scoped rows when the snapshot lacks totals', () => {
  // Older or partial snapshots may not carry the unfiltered aggregates; the
  // field must degrade to something honest rather than report undefined.
  const result = filterSnapshot({
    requests: [request('s1:1:1', '2026-10-01', 'alpha', 'model-a', 10, '1')],
  }, { start: '2026-10-01', end: '2026-10-01', providers: [], models: [] })

  assert.equal(result.allTime.calls, 1)
  assert.equal(result.allTime.sessions, 1)
  assert.ok(Number.isFinite(result.allTime.earliest))
})

const localDay = (atMs) => {
  const d = new Date(atMs)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

test('today and all are named ranges, and all really starts at the oldest record', () => {
  const today = localDay(Date.now())
  assert.deepEqual(scopeFromParams({ days: 'today' }), {
    start: today, end: today, granularity: 'hour', providers: [], models: [],
  })
  assert.equal(
    scopeFromParams({ days: 'all', end: '2026-10-19' }, { earliest: Date.parse('2026-08-01T09:00:00') }).start,
    '2026-08-01',
  )
  // Without the oldest record there is nothing honest to widen to. Collapsing
  // to today is wrong-looking but true; falling back to the 30-day default
  // would print a 30-day range under an "all time" label, which is a lie.
  assert.equal(scopeFromParams({ days: 'all', end: '2026-10-19' }).start, '2026-10-19')
  // ...and that degenerate one-day range must stay daily, or an empty machine
  // would render 全部时间 as 24 hourly buckets.
  assert.equal(scopeFromParams({ days: 'all', end: '2026-10-19' }).granularity, 'day')
  // A day count still behaves exactly as before. `end` is today rather than a
  // literal date: the count is measured back from *now*, so a fixed `end` in the
  // past makes start > end and the swap branch takes over — the assertion then
  // starts failing on a calendar date rather than on a code change.
  assert.equal(scopeFromParams({ days: '7', end: localDay(Date.now()) }).start, localDay(Date.now() - 6 * 86400000))
  // An explicit start outranks the named range.
  assert.equal(scopeFromParams({ days: 'all', start: '2026-09-01', end: '2026-10-19' }).start, '2026-09-01')
  // A one-day custom range is a single day, so it gets the hourly view too.
  assert.equal(scopeFromParams({ start: '2026-10-19', end: '2026-10-19' }).granularity, 'hour')
})

test('a single-day scope is bucketed by hour and asks the chart for hours', () => {
  const at = (day, hour) => new Date(`${day}T${String(hour).padStart(2, '0')}:30:00`).getTime()
  const rows = [
    { id: 's1:1:1', sessionId: 's1', time: at('2026-10-19', 9), date: '2026-10-19', provider: 'alpha', modelId: 'm', tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, realTokens: 10, hitRate: 0, cost: cost('1'), status: 'complete' },
    { id: 's1:2:1', sessionId: 's1', time: at('2026-10-19', 9), date: '2026-10-19', provider: 'alpha', modelId: 'm', tokens: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 }, realTokens: 10, hitRate: 0, cost: cost('1'), status: 'complete' },
    { id: 's1:3:1', sessionId: 's1', time: at('2026-10-19', 15), date: '2026-10-19', provider: 'alpha', modelId: 'm', tokens: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 }, realTokens: 5, hitRate: 0, cost: cost('1'), status: 'complete' },
  ]
  const scope = { start: '2026-10-19', end: '2026-10-19', providers: [], models: [] }
  const result = filterSnapshot({ calls: 3, requests: rows }, scope)

  assert.equal(result.granularity, 'hour')
  // All 24 slots exist, so a silent 03:00 keeps its place on the axis instead
  // of the bars closing the gap and implying activity there.
  assert.deepEqual(result.hours.map((slot) => slot.hour), [...Array(24).keys()])
  assert.deepEqual(result.hours.slice(0, 3).map((slot) => slot.label), ['00:00', '01:00', '02:00'])
  assert.equal(result.hours[9].calls, 2)
  assert.equal(result.hours[9].realTokens, 20)
  assert.equal(result.hours[15].calls, 1)
  assert.equal(result.hours[0].calls, 0)
  assert.equal(result.hours[0].realTokens, 0)
  // Hour buckets carry the same shape a day bucket does, so one chart plots both.
  for (const key of ['calls', 'tokens', 'realTokens', 'hitRate', 'cost']) {
    assert.ok(key in result.hours[9], `hour bucket carries ${key}`)
  }
  assert.equal(result.hours.reduce((sum, slot) => sum + slot.calls, 0), result.totals.calls)

  // Any wider range stays daily; the client must not be handed stale hours.
  const wide = filterSnapshot({ calls: 3, requests: rows }, { ...scope, start: '2026-10-18' })
  assert.equal(wide.granularity, 'day')
  assert.equal(wide.hours, null)
})
