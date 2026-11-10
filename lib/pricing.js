/**
 * Cost model for dsh-usage-dashboard.
 *
 * Prices are USD per 1,000,000 tokens and belong to the MODEL, not to the route:
 * the same model reached through a reseller is priced the same way, and a model
 * with no entry is reported as unpriced instead of receiving a guessed rate.
 *
 * DeepSeek's peak/off-peak table is carried as data (verified against the
 * official announcement effective 2026-08-16T16:00:00Z), never derived as an
 * automatic "half price" rule, and it excludes Chinese statutory holidays.
 */

export const PRICING_EPOCH_MS = Date.UTC(2026, 7, 16, 16, 0, 0)

// Peak windows are UTC half-open ranges; everything else is off-peak.
// 01:00–04:00 and 06:00–10:00 UTC = 09:00–12:00 and 14:00–18:00 Beijing.
export const DEFAULT_PEAK_RULE = Object.freeze({
  weekdays: [1, 2, 3, 4, 5],
  windows: [
    { startMinute: 60, endMinute: 240 },
    { startMinute: 360, endMinute: 600 },
  ],
})

// 2026 arrangement from the State Council notice
// (https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm).
// A later year ships with a plugin update or is extended by hand.
export const CHINA_HOLIDAYS_2026 = Object.freeze([
  '2026-01-01', '2026-01-02', '2026-01-03', '2026-02-15', '2026-02-16', '2026-02-17',
  '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06', '2026-05-01', '2026-05-02', '2026-05-03',
  '2026-05-04', '2026-05-05', '2026-06-19', '2026-06-20', '2026-06-21', '2026-09-25',
  '2026-09-26', '2026-09-27', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
])

/**
 * Seed price table. `offPeak` is the always-on rate; `peak` only applies to
 * models whose provider publishes a time-of-day table (first-party DeepSeek).
 * Everything the user runs today that is NOT here stays unpriced on purpose:
 * `qfmodel`, `nemotron-*-free` and `gpt-oss-120b` have no public per-token
 * price to inherit, and inventing one would print a plausible wrong number.
 */
export const DEFAULT_PRICES = Object.freeze([
  {
    modelId: 'deepseek-v4-flash',
    label: 'DeepSeek V4.1 Flash',
    offPeak: { input: '0.15', output: '0.6', cacheRead: '0.003', cacheWrite: '0' },
    peak: { input: '0.44', output: '1.32', cacheRead: '0.014', cacheWrite: '0' },
    holidays: CHINA_HOLIDAYS_2026,
    effectiveFrom: PRICING_EPOCH_MS,
  },
  {
    modelId: 'deepseek-flash',
    label: 'DeepSeek V4.1 Flash',
    offPeak: { input: '0.15', output: '0.6', cacheRead: '0.003', cacheWrite: '0' },
    peak: { input: '0.44', output: '1.32', cacheRead: '0.014', cacheWrite: '0' },
    holidays: CHINA_HOLIDAYS_2026,
    effectiveFrom: PRICING_EPOCH_MS,
  },
  {
    modelId: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    offPeak: { input: '0.66', output: '1.98', cacheRead: '0.022', cacheWrite: '0' },
    peak: { input: '1.32', output: '3.96', cacheRead: '0.044', cacheWrite: '0' },
    holidays: CHINA_HOLIDAYS_2026,
    effectiveFrom: PRICING_EPOCH_MS,
  },
  {
    modelId: 'deepseek-v4-flash-vision-exp',
    label: 'DeepSeek V4 Flash Vision Exp',
    offPeak: { input: '0.15', output: '0.6', cacheRead: '0.003', cacheWrite: '0' },
    peak: { input: '0.44', output: '1.32', cacheRead: '0.014', cacheWrite: '0' },
    holidays: CHINA_HOLIDAYS_2026,
    effectiveFrom: Date.UTC(2026, 7, 21, 0, 0, 0),
  },
])

const BUCKETS = ['input', 'output', 'cacheRead', 'cacheWrite']

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Parse a price string into an exact BigInt scaled by 1e12, or null when unusable. */
function parseRate(raw) {
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null
    return parseRate(String(raw))
  }
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text === '') return null
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text)
  if (match === null) return null
  const digits = `${match[1]}${match[2] ?? ''}`
  const exponent = match[3] !== undefined ? Number(match[3]) : 0
  const scale = (match[2]?.length ?? 0) - exponent
  return { digits: BigInt(digits), scale }
}

const RATE_SCALE = 12n

/** Normalise a parsed rate to a fixed 1e12 scale so buckets can be summed. */
function toScaled(parsed) {
  if (parsed === null) return null
  const diff = RATE_SCALE - BigInt(parsed.scale)
  if (diff >= 0n) return parsed.digits * 10n ** diff
  return parsed.digits / 10n ** -diff
}

function formatScaled(scaled) {
  if (scaled === 0n) return '0'
  const negative = scaled < 0n
  const value = (negative ? -scaled : scaled).toString().padStart(Number(RATE_SCALE) + 1, '0')
  const head = value.slice(0, value.length - Number(RATE_SCALE))
  const tail = value.slice(value.length - Number(RATE_SCALE)).replace(/0+$/, '')
  const body = tail === '' ? head : `${head}.${tail}`
  return negative ? `-${body}` : body
}

export function emptyCost() {
  return {
    currency: 'USD',
    input: '0', output: '0', cacheRead: '0', cacheWrite: '0',
    total: '0',
    priced: 0, unpriced: 0,
  }
}

function addCost(target, source) {
  for (const bucket of [...BUCKETS, 'total']) {
    const a = parseRate(target[bucket])
    const b = parseRate(source[bucket])
    if (a === null || b === null) continue
    target[bucket] = formatScaled(toScaled(a) + toScaled(b))
  }
  target.priced += source.priced
  target.unpriced += source.unpriced
  return target
}

export function addCosts(target, source) {
  return addCost(target, source)
}

/**
 * Decide the billing band for one instant.
 *
 * Usage recorded before a plan's `effectiveFrom` has no verifiable band, so it
 * fails closed as unpriced rather than inheriting today's rates.
 */
export function bandFor(entry, atMs) {
  if (!isRecord(entry)) return null
  const peak = isRecord(entry.peak) ? entry.peak : null
  if (peak === null) return 'off-peak'
  if (Number.isFinite(entry.effectiveFrom) && atMs < entry.effectiveFrom) return null
  const at = new Date(atMs)
  const weekday = at.getUTCDay()
  const rule = isRecord(entry.peakRule) ? entry.peakRule : DEFAULT_PEAK_RULE
  const weekdays = Array.isArray(rule.weekdays) ? rule.weekdays : []
  if (!weekdays.includes(weekday)) return 'off-peak'
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes()
  const holidays = Array.isArray(entry.holidays) ? entry.holidays : []
  const day = at.toISOString().slice(0, 10)
  // A statutory holiday is a full off-peak day: no rule can claim its instants.
  if (holidays.includes(day)) return 'off-peak'
  const windows = Array.isArray(rule.windows) ? rule.windows : []
  for (const window of windows) {
    if (!isRecord(window)) continue
    if (minute >= window.startMinute && minute < window.endMinute) return 'peak'
  }
  return 'off-peak'
}

/**
 * Price one usage record. Returns null when the model has no entry at all,
 * which the caller counts as `unpriced` rather than as zero.
 */
export function priceUsage(entry, usage, atMs) {
  if (!isRecord(entry)) return null
  const band = bandFor(entry, atMs)
  if (band === null) return null
  const rates = band === 'peak' && isRecord(entry.peak) ? entry.peak : entry.offPeak
  if (!isRecord(rates)) return null
  const out = emptyCost()
  let scaledTotal = 0n
  for (const bucket of BUCKETS) {
    const rate = toScaled(parseRate(rates[bucket]))
    const tokens = BigInt(Math.max(0, Math.trunc(Number(usage?.[bucket]) || 0)))
    if (rate === null) continue
    // price = tokens × ratePerMillion / 1e6, kept exact at 1e12 scale.
    const scaled = (tokens * rate) / 1000000n
    out[bucket] = formatScaled(scaled)
    scaledTotal += scaled
  }
  out.total = formatScaled(scaledTotal)
  out.priced = 1
  return out
}

/** Index a price list by normalised model id. Later rows win, so user edits override defaults. */
export function buildPriceIndex(entries) {
  const index = new Map()
  if (!Array.isArray(entries)) return index
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.modelId !== 'string') continue
    const key = entry.modelId.trim().toLowerCase()
    if (key === '') continue
    index.set(key, entry)
  }
  return index
}

/** Last path segment of a `vendor/model` route id, so reseller ids still match. */
export function normalizeModelId(raw) {
  if (typeof raw !== 'string') return ''
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === '') return ''
  const slash = trimmed.lastIndexOf('/')
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed
}

export function lookupPrice(index, modelId) {
  if (index.size === 0) return null
  const exact = index.get(String(modelId ?? '').trim().toLowerCase())
  if (exact !== undefined) return exact
  const short = normalizeModelId(modelId)
  if (short === '') return null
  const byShort = index.get(short)
  return byShort === undefined ? null : byShort
}
