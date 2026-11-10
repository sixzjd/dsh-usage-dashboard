import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const clientPath = new URL('../client.js', import.meta.url)

// The panel renders inside the host Settings dialog, so Escape must close the
// metric detail FIRST and never reach the settings dialog behind it. Two paths
// exist and each owns Escape differently; both are guarded here.
test('Escape closes the detail without leaking to the settings dialog', async () => {
  const source = await readFile(clientPath, 'utf8')

  // Fallback path (no host Modal): a capture-phase listener consumes the key
  // before anything outside the panel can see it.
  assert.match(
    source,
    /const onKeyDown = \(event\) => \{ if \(event\.key === "Escape"\) \{ event\.preventDefault\(\); event\.stopPropagation\(\); event\.stopImmediatePropagation\?\.\(\); setDetailKind\(null\); \} \}; document\.addEventListener\("keydown", onKeyDown, true\)/,
    'fallback must intercept Escape in the capture phase',
  )

  // Native path: the host Modal owns Escape and focus return, so the panel must
  // NOT also register its own handler — two handlers would fight over the key
  // and the Modal would never restore focus to the triggering bar.
  assert.match(
    source,
    /if \(!detailKind \|\| Modal !== null\) return undefined/,
    'own Escape handler must be skipped when the host Modal is available',
  )
  assert.match(
    source,
    /if \(Modal !== null\) return h\(Modal, \{ open: true, onClose, title, closeLabel: "关闭详情" \}, body\)/,
    'detail must delegate to the host Modal when present',
  )
})

test('the fallback overlay is viewport-fixed, never absolute inside the content column', async () => {
  const source = await readFile(clientPath, 'utf8')
  const rule = /\.um-detail-backdrop\{([^}]*)\}/.exec(source)
  assert.ok(rule, 'backdrop rule is present')
  assert.match(rule[1], /position:fixed/, 'backdrop must be fixed to the viewport')
  assert.doesNotMatch(rule[1], /position:absolute/, 'absolute would bury the card below the fold')
  // The card being invisible while the mask covered everything was the bug.
  assert.match(rule[1], /z-index:1000/, 'backdrop must sit above the settings dialog')
})

test('axis ticks never collide and always label the final day', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.split('\n').findIndex((line) => line.startsWith('    const tickIndexes = '))
  assert.ok(start >= 0, 'tickIndexes is present')
  let end = -1
  const lines = source.split('\n')
  for (let i = start + 1; i < lines.length; i++) { if (lines[i] === '    }') { end = i; break } }
  assert.ok(end > start, 'tickIndexes block closes')
  const tickIndexes = new Function(lines.slice(start, end + 1).join('\n') + '\nreturn tickIndexes')()

  for (const length of [1, 2, 3, 7, 14, 15, 30, 31, 45, 46, 60, 61, 90, 120, 180, 365]) {
    const ticks = [...tickIndexes(length)].sort((a, b) => a - b)
    assert.ok(ticks.every((t) => t >= 0 && t < length), `${length}: ticks in range`)
    assert.ok(ticks.includes(length - 1), `${length}: final day is labelled`)
    // Slots are ~18px (16 bar + 2 gap) at short ranges and a label is ~34px,
    // so adjacent ticks need enough pitch to keep "10/09" and "10/10" apart.
    const pitch = (length > 60 ? 6 : length > 30 ? 10 : 16) + (length > 120 ? 1 : 2)
    for (let i = 1; i < ticks.length; i++) {
      assert.ok(
        (ticks[i] - ticks[i - 1]) * pitch >= 34,
        `${length}: ticks ${ticks[i - 1]}/${ticks[i]} would overlap (${(ticks[i] - ticks[i - 1]) * pitch}px)`,
      )
    }
  }
})

// The models table groups by provider + route id on purpose, so one model
// reached over two routes is two rows. Rendering only the model name made that
// pair look like a duplicated entry, so the route has to be shown alongside it.
test('model rows name the route so same-model rows stay distinguishable', async () => {
  const source = await readFile(clientPath, 'utf8')
  // The window is generous on purpose: the cell also carries a hover title and
  // the clipped-name span, so proximity is a weaker signal than the exact
  // render call, which is what is asserted.
  assert.match(
    source,
    /tab === "models"[\s\S]{0,520}?h\("span", \{ className: "um-cell-sub" \}, r\.provider\)/,
    'the model cell must render the provider as a secondary label',
  )
  assert.match(source, /\.um-cell-sub\{/, 'the secondary label needs a style rule')
})

// Two regressions in one rule: overflow-wrap:anywhere let "5148.5万" break
// between ".5" and "万" inside a fixed-height card, and the follow-up
// overflow:hidden fix then clipped the 23px glyphs top-and-bottom, because
// the 83px box never actually fit label+gap+value+padding anyway (it relies
// on overflow). The honest shape: cards grow (min-height), values never
// wrap, and nothing hides overflow.
test("metric values stay fully visible at narrow card widths", async () => {
  const source = await readFile(clientPath, "utf8")
  assert.match(source, /\.um-card\{[^}]*min-height:83px/, "card grows instead of clipping")
  // (?<!min-) keeps this from matching the min-height line above it.
  assert.doesNotMatch(source, /\.um-card\{[^}]*(?<!min-)height:83px/, "no fixed card height")
  assert.match(source, /\.um-value\{[^}]*white-space:nowrap/, "card value must not wrap")
  assert.doesNotMatch(source, /\.um-value\{[^}]*overflow/, "card value must not hide overflow")
  assert.doesNotMatch(source, /\.um-detail-value\{[^}]*overflow/, "modal value must not hide overflow")
  assert.match(source, /\.um-card\{[^}]*padding:20px 24px/, "card padding widened the content box")
})

// Two bugs shared one root: the grouped tables keyed rows on modelId OR
// provider, so the two qfmodel routes (qoder, qoder-global) collided on the
// same React key. Undefined diff behaviour then let a stale models-table row
// (4 cells: name+route / calls / tokens / cost) survive into the requests
// table (5 cells) when switching tabs - the "time column shows a model"
// screenshot. Keys must carry both dimensions.
test('grouped rows key on provider AND model, never one or the other', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.match(source, /h\("tr", \{ key: `\$\{r\.provider[^\n]*r\.modelId/,
    'grouped table key must join provider and modelId')
  assert.doesNotMatch(source, /key: `\$\{r\.modelId \|\| r\.provider/,
    'the || key form let two routes collide')
})

// The requests array arrives oldest-first; slice(0, 100) therefore showed the
// 100 OLDEST requests of the range and silently hid everything recent - a
// user's fresh deepseek calls existed in the data but could never appear.
// Newest-first (last 100, reversed) is what a request log means.
test('request log sorts by time and defaults to newest first', async () => {
  const source = await readFile(clientPath, 'utf8')
  // Sort-then-slice, not slice-then-reverse: the visible window follows the
  // chosen direction instead of hard-coding one.
  assert.match(source, /sortRows\(rows, \(r\) => r\.time \?\? 0\)\.slice\(0, 100\)/,
    'requests must sort by time before capping to 100 rows')
  assert.match(source, /\[sortDesc, setSortDesc\] = React\.useState\(true\)/,
    'default direction must be newest/largest first')
  assert.match(source, /sortTh\("时间"/, 'the time header must be the sort control')
  assert.match(source, /aria-sort/, 'sort direction must be announced to AT')
  assert.doesNotMatch(source, /rows \|\| \[\]\)\.slice\(0, 100\)/,
    'an unsorted leading slice showed stale history only')
})

// The 费用 column rendered OUTSIDE the panel border. Cause: `.um-table` is a
// real table, the cells are nowrap, and a table can never be narrower than its
// min-content width - so `width:100%` was a floor, not a cap. The scroll
// container meant to contain it had been written as a rule on `.um-table`
// itself and parked inside the <=760px media query, so only mobile ever
// clipped. Two independent things must hold now: the wrapper exists at every
// width, and every ancestor of it may shrink (a flex/grid item defaults to
// min-width:auto, so it would rather widen the whole settings pane than let
// the table scroll inside itself).
test('detail tables are clamped inside their panel at every width', async () => {
  const source = await readFile(clientPath, 'utf8')
  const mobile = source.slice(
    source.indexOf('@media(max-width:760px)'),
    source.indexOf('@media(max-width:480px)'),
  )
  assert.match(source, /\.um-table-wrap\{[^}]*overflow-x:auto/,
    'the horizontal scroll container must be a wrapper element')
  assert.doesNotMatch(mobile, /um-table-wrap/,
    'the scroll container must not be mobile-only - that was the bug')
  assert.doesNotMatch(mobile, /\.um-table\{[^}]*overflow/,
    'the table itself must never carry the scroll rule')
  assert.match(source, /\.um-root\{[^}]*margin:0 auto;min-width:0\}/,
    'the root must be allowed to shrink inside the settings pane')
  assert.match(source, /\.um-content\{position:relative;min-width:0\}/,
    'the content column must be allowed to shrink')
  assert.match(source, /\.um-panel\{padding:16px;margin-bottom:16px;min-width:0\}/,
    'the panel must be allowed to shrink')
  assert.match(source, /rows\?\.length \? h\("div", \{ className: "um-table-wrap" \}, table\)/,
    'both detail tables must render inside the wrapper')
})

// Containment alone would only have HIDDEN the 费用 column behind a scrollbar.
// Measured min-content of the request table was ~566px against a ~507px panel
// content box: 5 columns of 8px gutters plus a one-line "2026/10/18 22:46:14"
// stamp. These are the four changes that brought it to ~474px so it fits
// without scrolling, with 费用 fully readable.
test('the request table is narrow enough to fit a settings pane', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.match(source, /\.um-table th\{padding:0 6px 9px/, 'header gutter trimmed')
  assert.match(source, /\.um-table td\{padding:10px 6px/, 'cell gutter trimmed')
  assert.match(source, /\.um-table th:first-child,\.um-table td:first-child\{padding-left:0\}/,
    'the panel already supplies the outer inset')
  assert.match(source, /\.um-table th:last-child,\.um-table td:last-child\{padding-right:0\}/,
    'the panel already supplies the outer inset')
  assert.match(source, /\.um-num\{text-align:right;font-variant-numeric:tabular-nums\}/,
    'numeric columns align like a ledger and keep digits on a common grid')
  assert.match(source, /const stampParts = \(atMs\) =>/, 'the timestamp must be splittable')
  assert.match(source, /timeCell\(r\)/, 'the request log must use the stacked date/clock cell')
  assert.doesNotMatch(source, /new Date\(r\.time\)\.toLocaleString\(\)/,
    'the one-line stamp was the single widest cell in the table')
  assert.match(source, /h\("td", \{ className: "um-num" \}, displayCost\(r\.cost\)\)/,
    '费用 is a numeric column')
})

// The provider and model names are the only unbounded-width cells in the
// table, and on a wide panel they spread the whole grid out. Clipping has to
// happen in CSS, never by shortening the string in JS: the DOM keeps the full
// name so the cell's accessible name stays complete, and `title` gives the
// mouse the same full text.
test('long provider and model names clip visually but keep the full value', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.match(source, /\.um-ellip\{display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap\}/,
    'the clip box needs ellipsis, not hidden')
  // A span max-width alone does NOT cap a column: under table-layout:auto the
  // browser hands the panel's leftover width back to the columns, so the column
  // stays wide while its text is clipped inside it. Fixed layout pins it, and
  // the one unsized column absorbs the slack.
  assert.match(source, /\.um-table\{[^}]*table-layout:fixed\}/,
    'column widths are only honoured under fixed layout')
  assert.match(source, /h\("colgroup", null, h\("col", \{ style: \{ width: "96px" \} \}\), h\("col", \{ style: \{ width: "88px" \} \}\), h\("col"\)/,
    'the name columns are capped and the model column takes the slack')
  assert.match(source, /h\("td", \{ title: r\.provider \|\| "unknown" \}/,
    'the provider cell needs a hover title')
  assert.match(source, /h\("td", \{ title: fullModelName\(r\) \}/,
    'the model cell needs a hover title')
  // The full text stays in the DOM; only the box clips.
  assert.match(source, /h\("span", \{ className: "um-ellip" \}, modelLabel\(r\)\)/,
    'the model name must be rendered in full and clipped by CSS')
  assert.match(source, /const fullModelName = \(row\) =>/,
    'hover text must be derived, not re-truncated')
  assert.match(source, /return id && id !== label \? `\$\{label\}（\$\{id\}）` : label;/,
    'hover text carries the route id when it differs from the shown name')
})

// "今天" is one calendar day, so the chart plots 24 hourly buckets; "全部时间"
// starts at the oldest record the aggregator has seen. The panel must still
// open on 近 30 天 — a new option is not allowed to change the default view.
test('the range select offers today and all time in the requested order', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.match(
    source,
    /useState\(\{ days: "30", start: "", end: "", provider: "", model: "" \}\)/,
    'the panel still opens on 30 days',
  )
  const from = source.indexOf('"时间范围"')
  const to = source.indexOf('"自定义区间"', from)
  assert.ok(from > 0 && to > from, 'the range select is present')
  const values = [...source.slice(from, to + 10)
    .matchAll(/h\("option", \{ value: "([^"]+)" \}, "([^"]+)"\)/g)]
    .map((match) => [match[1], match[2]])
  assert.deepEqual(values, [
    ['today', '今天'],
    ['7', '近 7 天'],
    ['30', '近 30 天'],
    ['90', '近 90 天'],
    ['all', '全部时间'],
    ['custom', '自定义区间'],
  ], '今天 is first, 全部时间 sits between 近 90 天 and 自定义区间')
})

test('a one-day range is plotted per hour and titled as such', async () => {
  const source = await readFile(clientPath, 'utf8')
  assert.match(
    source,
    /const hourly = granularity === "hour" && Array\.isArray\(hours\) && hours\.length > 0/,
    'the chart switches on the granularity the server reported',
  )
  assert.match(
    source,
    /tickIndexes\(series\.length, barWidth, barGap, hourly\)/,
    'hourly series get their own tick cadence',
  )
  assert.match(
    source,
    /data\?\.granularity === "hour" \? "使用趋势 · 按小时" : "使用趋势 · 按天"/,
    'the panel title follows the granularity',
  )
  assert.match(
    source,
    /h\(Chart, \{ days: data\?\.days, hours: data\?\.hours, granularity: data\?\.granularity, metric, scope: data\?\.scope \}\)/,
    'the chart receives the hourly buckets',
  )
})

// 24 hourly slots are "HH:00" wide (~34px), exactly like "MM/DD", so they need
// a cadence of their own: the day cadence would print 7 labels across a single
// day and 0/7/14/23 would drift. The last slot is still always labelled.
test('hourly ticks stay legible and keep the final hour', async () => {
  const source = await readFile(clientPath, 'utf8')
  const start = source.split('\n').findIndex((line) => line.startsWith('    const tickIndexes = '))
  assert.ok(start >= 0, 'tickIndexes is present')
  const lines = source.split('\n')
  let end = -1
  for (let i = start + 1; i < lines.length; i++) { if (lines[i] === '    }') { end = i; break } }
  assert.ok(end > start, 'tickIndexes block closes')
  const tickIndexes = new Function(lines.slice(start, end + 1).join('\n') + '\nreturn tickIndexes')()
  const ticks = [...tickIndexes(24, 16, 2, true)].sort((a, b) => a - b)
  assert.ok(ticks.every((t) => t >= 0 && t < 24), 'hourly ticks stay in range')
  assert.ok(ticks.includes(23), 'the final hour is labelled')
  assert.ok(ticks.length >= 4 && ticks.length <= 8, `24 hourly slots want 4-8 labels, got ${ticks.length}`)
  for (let i = 1; i < ticks.length; i++) {
    assert.ok((ticks[i] - ticks[i - 1]) * 18 >= 34,
      `hours ${ticks[i - 1]}/${ticks[i]} would overlap`)
  }
})

// A number cannot be checked against anything if the reader cannot tell when it
// was taken. Two tables in the same panel never disagree — both are rendered
// from one response — but a panel that refetched between two glances will show
// two different snapshots, and without a timestamp that reads as a bug.
test('the panel stamps when its numbers were captured', async () => {
  const source = await readFile(clientPath, 'utf8')
  const lines = source.split('\n')
  const pad2 = lines.find((line) => line.startsWith('    const pad2 = '))
  const clock = lines.find((line) => line.startsWith('    const clock = '))
  assert.ok(pad2 && clock, 'the clock helpers are present')
  const stamp = new Function(`${pad2}\n${clock}\nreturn clock`)()
  assert.equal(stamp(new Date(2026, 9, 19, 9, 5, 7).getTime()), '09:05:07', 'zero-padded HH:MM:SS')

  assert.match(source, /className: "um-stamp"/, 'the header carries a stamp element')
  assert.match(source, /` · 数据更新于 \$\{stampParts\(data\.generatedAt\)\.time\}`/,
    'the stamp shows the payload capture time, not the render time')
  assert.match(source, /data\?\.generatedAt \?/,
    'no payload means no stamp, rather than a fabricated "now"')
  // A panel left open across midnight needs the day, which the tooltip holds.
  assert.match(source, /title: `抓取于 \$\{stampParts\(data\.generatedAt\)\.date\} \$\{stampParts\(data\.generatedAt\)\.time\}`/)
  assert.match(source, /\.um-stamp\{white-space:nowrap/, 'the stamp must not wrap mid-string')
})

// A pure-CSS bug that no JS test could see: `.um-table th` is (0,1,1) and
// `.um-num` is (0,1,0), so specificity — not source order — kept the numeric
// HEADERS left-aligned above right-aligned numbers. 请求 sat 54px to the left of
// the value it labelled, in both the provider and the model table.
// "The rule exists" would not catch a regression here, so this resolves the
// cascade the way a browser does: of every rule matching the element, the
// highest specificity wins, ties broken by source order.
test('numeric table headers right-align with the numbers under them', async () => {
  const source = await readFile(clientPath, 'utf8')

  // Subject of a selector is its last compound, so `.um-table th.um-num`
  // matches a th and is scored on the whole selector.
  const specificity = (selector) => [
    (selector.match(/#[\w-]+/g) || []).length,
    (selector.match(/\.[\w-]+/g) || []).length,
    (selector.replace(/[#.][\w-]+/g, '').match(/\b[a-z]+\b/g) || []).length,
  ]
  const higher = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2])
  const matches = (selector, tag, classes) => selector.split(',').some((part) => {
    const subject = part.trim().split(/\s+/).pop()
    // Pseudo-classes and @media preludes are out of scope for this check.
    if (/[:([@]/.test(subject)) return false
    const [, name, classList] = /^([a-z]*)((?:\.[\w-]+)*)$/.exec(subject) || []
    if (name === undefined || (name && name !== tag)) return false
    return (classList.match(/\.[\w-]+/g) || []).every((c) => classes.includes(c.slice(1)))
  })

  const rules = [...source.matchAll(/([^{};\n][^{}]*)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1].trim(), body: m[2] }))
  const declaration = (tag, classes) => {
    let winner = null
    rules.forEach((rule, order) => {
      const value = /text-align:\s*([a-z]+)/.exec(rule.body)
      if (!value || !matches(rule.selector, tag, classes)) return
      const score = specificity(rule.selector)
      if (!winner || higher(score, winner.score) > 0) winner = { value: value[1], selector: rule.selector, score, order }
    })
    return winner
  }

  for (const classes of [['um-num'], ['um-th-sort', 'um-num']]) {
    const winner = declaration('th', classes)
    assert.ok(winner, `a th.${classes.join('.')} rule sets text-align`)
    assert.equal(winner.value, 'right',
      `th.${classes.join('.')} resolves to ${winner.value} via ${winner.selector} — it must out-rank .um-table th's text-align:left`)
  }
  assert.equal(declaration('td', ['um-num']).value, 'right', 'body numbers stay right-aligned')
  // The time column is a label, not a number, so it must stay left-aligned.
  assert.equal(declaration('th', ['um-th-sort']).value, 'left', 'the 时间 header stays left-aligned')
})

// The settings row said "Usage Statistics" inside an otherwise Chinese sidebar.
// The only input to that label was `navigator.language`, and the desktop shell
// reports en-US while the settings page renders Chinese — so the row disagreed
// with the page it sits in. The host's own `locale` service is the authority.
// This drives the real module through `apply` rather than grepping the source,
// because the bug was in which input the label consulted, not in its spelling.
test('the settings row follows the host locale, not navigator.language', async () => {
  const source = await readFile(clientPath, 'utf8')
  // The module needs React and `window.__ModuleLoader__` to exist at load time.
  const React = {
    createElement: () => null,
    Fragment: Symbol('Fragment'),
    useState: (value) => [value, () => {}],
    useEffect: () => {},
    useMemo: (compute) => compute(),
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
  }
  let loaded = null
  const hostWindow = {
    __ModuleLoader__: {
      load: ({ id, factory }) => { loaded = { id, mod: factory((name) => (name === 'react' ? React : {})) } },
    },
  }
  // navigator.language is deliberately en-US: the label must ignore it.
  new Function('window', 'navigator', source)(hostWindow, { language: 'en-US' })
  assert.ok(loaded, 'the module registers itself')
  assert.equal(loaded.id, 'dsh-usage-dashboard')

  const apply = (locale) => {
    let options = null
    const ctx = { slots: { inject: (name, fn) => fn(), register: (opts) => { options = opts; return {} } } }
    if (locale) { ctx.locale = locale; ctx.effect = (fn) => fn() }
    loaded.mod.apply(ctx)
    return options
  }

  const dictionaries = []
  const translated = apply({
    register: (ns, dict) => dictionaries.push([ns, dict]),
    bind: (ns) => (key) => `${ns}:${key}`,
  })
  assert.equal(translated.label(), 'settings.dsh-usage-dashboard:nav',
    'the row asks the host locale for its name')
  assert.equal(translated.locale, 'settings.dsh-usage-dashboard', 'the slot is told which namespace it reads')
  assert.equal(dictionaries[0][0], 'settings.dsh-usage-dashboard', 'the namespace is registered')
  assert.equal(dictionaries[0][1].zh.nav, '用量统计')
  assert.equal(dictionaries[0][1].en.nav, 'Usage Statistics')

  // A host without the service must still get a row, and that row has to agree
  // with the Chinese body underneath it rather than guessing from the browser.
  const fallback = apply(null)
  assert.equal(fallback.label(), '用量统计', 'no locale service falls back to the panel language')
  assert.equal(fallback.locale, undefined, 'no namespace is advertised when nothing is bound')
  // Comments still name the old input (they explain why it was wrong), so the
  // guard looks at executable lines only.
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
  assert.doesNotMatch(code, /navigator\.language/,
    'navigator.language does not follow the host UI language and must not decide the label')
})

test('every service the client reads is declared in inject', async () => {
  // A service read without being declared is not guaranteed to exist when
  // `apply` runs, and the entry then fails to ACTIVATE — the whole browser half
  // stops loading over an untranslated label. That is exactly how this module
  // broke once: `ctx.locale` was read while `inject` still said only "slots".
  const source = await readFile(clientPath, 'utf8')
  const code = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
  const match = /const inject = \[([^\]]*)\]/.exec(code)
  assert.ok(match, 'client.js declares an inject list')
  const declared = match[1].split(',').map((entry) => entry.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
  for (const service of ['ctx.slots', 'ctx.locale']) {
    const used = code.includes(service)
    const name = service.slice('ctx.'.length)
    if (used) {
      assert.ok(declared.includes(name), `${service} is read but "${name}" is not in inject (${declared.join(', ')})`)
    }
  }
})
