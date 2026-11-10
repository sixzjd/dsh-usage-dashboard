import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/plugin.js'

// The route layer is where the named ranges become real scopes, so it is worth
// exercising for real: a unit test on scopeFromParams cannot catch a handler
// that forgets to hand over the oldest record, which is exactly how "全部时间"
// would quietly become a 30-day window.
function harness() {
  const routes = new Map()
  const ctx = {
    get: (name) => (name === 'webServer'
      ? { register: (route) => { routes.set(route.path, route.handler); return () => {} } }
      : undefined),
    effect: (fn) => { const stop = fn(); return () => { if (typeof stop === 'function') stop() } },
    on: () => {},
    timeout: () => Promise.resolve(),
    interval: () => () => {},
  }
  const sessionQuery = { listSessions: async () => [], readSession: async () => ({ events: [] }) }
  ctx.get = (name) => (name === 'webServer'
    ? { register: (route) => { routes.set(route.path, route.handler); return () => {} } }
    : name === 'sessionQuery' ? sessionQuery : undefined)
  return { ctx, routes }
}

function call(handler, path) {
  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    end(body) { this.body = body },
  }
  handler({
    method: 'GET',
    url: path,
    headers: { host: '127.0.0.1:3080' },
    socket: { remoteAddress: '127.0.0.1' },
  }, res)
  return res
}

const localDay = (atMs) => {
  const d = new Date(atMs)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

test('the summary route answers today with 24 hourly buckets', async () => {
  const { ctx, routes } = harness()
  apply(ctx)
  const handler = routes.get('/api/dsh-usage-dashboard/summary')
  assert.ok(handler, 'the summary route is registered')
  await new Promise((resolve) => setTimeout(resolve, 20))

  const res = call(handler, '/api/dsh-usage-dashboard/summary?days=today')
  assert.equal(res.statusCode, 200)
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  const today = localDay(Date.now())
  assert.equal(body.scope.start, today)
  assert.equal(body.scope.end, today)
  assert.equal(body.granularity, 'hour')
  assert.equal(body.hours.length, 24)
  assert.deepEqual(body.hours.map((slot) => slot.label).slice(0, 2), ['00:00', '01:00'])

  // An empty machine answers "all time" as today. It must still be a valid day
  // range rather than the 30-day default, and daily rather than hourly.
  const all = JSON.parse(call(handler, '/api/dsh-usage-dashboard/summary?days=all').body)
  assert.equal(all.granularity, 'day')
  assert.equal(all.hours, null)
  assert.equal(all.scope.start, today)

  // The default view is untouched.
  const d30 = JSON.parse(call(handler, '/api/dsh-usage-dashboard/summary').body)
  assert.equal(d30.granularity, 'day')
  assert.equal(d30.scope.end, today)
  const start = new Date(Date.now() - 29 * 86400000)
  assert.equal(d30.scope.start, localDay(start.getTime()))
})

test('the summary route still refuses a non-loopback caller', async () => {
  const { ctx, routes } = harness()
  apply(ctx)
  const handler = routes.get('/api/dsh-usage-dashboard/summary')
  await new Promise((resolve) => setTimeout(resolve, 20))

  const res = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name] = value },
    end(body) { this.body = body },
  }
  handler({
    method: 'GET',
    url: '/api/dsh-usage-dashboard/summary?days=today',
    headers: { host: 'evil.example' },
    socket: { remoteAddress: '10.0.0.7' },
  }, res)
  assert.equal(res.statusCode, 403)
  assert.equal(JSON.parse(res.body).ok, false)
})
