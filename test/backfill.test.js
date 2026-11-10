import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCheckpoint, readBackfillRows, PROJCACHE_DIR } from '../lib/backfill.js'
import { createAggregator } from '../lib/aggregate.js'

function checkpoint(totals, createdAt = 1_700_000_000_000) {
  return JSON.stringify({
    version: 7,
    record: {
      identity: { formatVersion: 4, createdAt, cwd: '/tmp', isSeeded: false },
      rows: {
        tokenUsage: { ver: 2, seq: 10, val: { totals } },
        title: { ver: 1, seq: 10, val: 'gone' },
      },
    },
  })
}

const TOTALS = {
  uncachedInputTokens: 200, outputTokens: 20, cacheReadTokens: 1800, cacheWriteTokens: 0,
}

test('a checkpoint with a tokenUsage total becomes one backfill row', () => {
  const row = parseCheckpoint(JSON.parse(checkpoint(TOTALS)), 'session-gone')
  assert.equal(row.sessionId, 'session-gone')
  assert.equal(row.id, 'session-gone:retained')
  assert.equal(row.tokens.input, 200)
  assert.equal(row.tokens.cacheRead, 1800)
  assert.equal(row.time, 1_700_000_000_000)
})

test('a checkpoint without a usable total contributes nothing', () => {
  assert.equal(parseCheckpoint(JSON.parse(checkpoint({ uncachedInputTokens: 0, outputTokens: 0 })), 'x'), null)
  assert.equal(parseCheckpoint({ version: 7, record: { identity: {}, rows: {} } }, 'x'), null)
  assert.equal(parseCheckpoint({ version: 7 }, 'x'), null)
  assert.equal(parseCheckpoint(null, 'x'), null)
})

test('backfill skips sessions the current scan still sees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'umdash-'))
  try {
    const dir = join(root, PROJCACHE_DIR)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session-alive.json'), checkpoint(TOTALS))
    await writeFile(join(dir, 'session-gone.json'), checkpoint({ ...TOTALS, cacheReadTokens: 5000 }))
    await writeFile(join(dir, 'session-zero.json'), checkpoint({ uncachedInputTokens: 0 }))
    await writeFile(join(dir, 'notes.txt'), 'not a checkpoint')

    const { rows } = await readBackfillRows(root, new Set(['session-alive']))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].sessionId, 'session-gone')
    assert.equal(rows[0].tokens.cacheRead, 5000)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a missing checkpoint directory is not an error', async () => {
  const { rows, scanned } = await readBackfillRows('/nonexistent/root/for/sure', new Set())
  assert.deepEqual(rows, [])
  assert.equal(scanned, 0)
})

test('a corrupt checkpoint is skipped without failing the batch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'umdash-'))
  try {
    const dir = join(root, PROJCACHE_DIR)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session-bad.json'), '{ not json')
    await writeFile(join(dir, 'session-good.json'), checkpoint(TOTALS))
    const { rows, failed } = await readBackfillRows(root, new Set())
    assert.equal(rows.length, 1)
    assert.equal(rows[0].sessionId, 'session-good')
    assert.equal(failed, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('backfilled rows raise the total a scan would otherwise under-report', () => {
  const aggregator = createAggregator()
  aggregator.loadRetained([{
    id: 'session-gone:retained', sessionId: 'session-gone', time: 1_700_000_000_000,
    date: null, provider: null, modelId: null, tokens: { input: 200, output: 20, cacheRead: 1800, cacheWrite: 0 },
  }])
  assert.equal(aggregator.snapshot().realTokens, 2020)
})
