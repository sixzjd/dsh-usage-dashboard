import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('chart slots fill the width but the bars stay a readable size', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const slot = source.match(/\.um-bar-slot\{[^}]*\}/)?.[0] ?? ''
  const bar = source.match(/\.um-bar\{[^}]*\}/)?.[0] ?? ''
  const tick = source.match(/\.um-bars-x-tick\{[^}]*\}/)?.[0] ?? ''

  // Slots and ticks still divide the plot evenly, so spacing stays uniform.
  assert.match(slot, /flex:1 1 0/)
  assert.ok(!slot.includes('max-width'), 'slot must not cap the grid')
  assert.match(tick, /flex:1 1 0/)
  assert.ok(!tick.includes('max-width'), 'tick must not cap the grid')

  // But the visual bar is capped and centred in its slot: a 7-day chart should
  // spread out, not turn each bar into a 126px slab.
  assert.match(bar, /max-width:/, 'the bar itself has a width cap')
  assert.match(bar, /margin:[^;]*auto/, 'the bar is centred in its slot')
})
