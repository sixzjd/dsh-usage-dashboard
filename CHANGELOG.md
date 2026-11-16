# Changelog

## 0.6.4

### Fixed — the filter dropdowns were unreadable in Windows dark mode

A `<select>` popup belongs to the operating system, not to the page. On Windows
the popup kept the system's white background while its rows inherited this
panel's dark-theme near-white text, so on a dark desktop the row list rendered
as light grey on white. `color-scheme` alone does not fix it on every Chromium
build, and `var()` tokens are dropped by a popup the OS paints.

The two filter dropdowns are now drawn by the panel itself: a listbox styled
with the same tokens as the rest of the interface, identical on macOS, Windows
and Linux. It keeps what the native control gave for free — listbox and option
roles, an announced expanded state, arrow/Home/End navigation, Enter to choose,
Escape or an outside click to dismiss.

No native `<select>` remains, so this class of platform theme bug cannot come
back through these filters.

## 0.7.0

### Changed — model-name resolution is no longer tied to one plugin

Name resolution used to read one provider plugin's cache at a hardcoded path, so
it only ever helped users of that plugin. It now discovers catalogs by
**directory shape** across every provider plugin in every profile, and accepts
both layouts in the wild: a top-level `{models:[…]}` and per-account
`{entries:{…models:[…]}}`.

Measured on a live profile: alias coverage went from 15 names (1 plugin) to
**97 names (3 plugins)**, which is what finally labels models like
`deepseek-v4.1-flash` on machines that do not run the first plugin at all.

The README no longer presents any of this as one vendor's quirk: the limitation,
the credit-billing caveat and the private-cache disclosure are all stated in
provider-neutral terms.

### Added — a Settings / Sidebar placement choice

The panel's entry can now live in the sidebar as a first-class navigation row
(with a main-region panel behind it), in Settings as before, or in both. The
choice is saved server-side beside the price table and applies immediately —
choosing a location mounts or unmounts the corresponding slots without a reload.

Settings remains the default: the panel reports across all sessions, so it does
not claim a permanent seat in the app chrome next to actions that change
something unless the user asks for one.

## 0.6.3

### Supersedes the first 0.6.2

The version published as 0.6.2 imported another application's database to
recover per-day splits. That is not this plugin's job — it made the package read
a file it does not own — and it is gone. 0.6.3 reads only this machine's own
session logs and projection checkpoints.

### Fixed — history is read, not re-summed

Recovering a deleted session's usage from the projection checkpoint ran on
every start and re-admitted every session the checkpoints still listed. That
made the panel re-sum the past instead of reading what it had already saved,
and any store that also held a per-day split for the same session counted that
usage twice.

A session is now admitted at most once: `backfillRows` skips whatever the
durable store already records. Saved history stays history.

## 0.6.1

### Fixed — the settings entry never appeared

The client bundle registered itself as `dsh-usage-dashboard`, but the host keys
its boot graph by PACKAGE name and asserts that a loaded bundle registered that
exact id. The bundle loaded and then failed that assertion, so the settings
section was never mounted — the host half worked (its routes answered) while
nothing showed in the UI.

Escaped 0.6.0 because the rename changed the package name to
`@sixzjd/dsh-usage-dashboard` without changing the bundle id inside
`client.js`. Every other working client plugin in the profile registers under
its full package name; this one now does too, and a test pins the two together.

## 0.6.0

### Fixed — deleted sessions no longer erase their usage

The panel folded only what `sessionQuery.listSessions()` returned, which lists
the session logs that still exist on disk. Deleting a conversation therefore
subtracted every token it had ever spent from every total, silently: nothing
errored, the numbers just shrank.

On the machine that motivated this release, 362 deleted sessions were worth
~3.1B tokens against a 6.67B lifetime figure — the panel showed 3.5B and looked
like it had lost half the history.

- Per-call usage is now recorded durably (`lib/history.js`) and replayed into
  every later scan. Retained rows rank BELOW the live log — history loads first
  and disk logs fold afterwards — so a session that still exists is always
  measured from its own log.
- Sessions deleted before this release are recovered once from the host's
  session projection cache `tokenUsage` totals (`lib/backfill.js`).
- Known limitation: those checkpoints carry one whole-session total with no
  per-day or per-model split, so a backfilled row is anchored at the session's
  creation time. The total is accurate; its position on the daily chart is
  approximate.

### Changed — renamed to `@sixzjd/dsh-usage-dashboard`

The unscoped name `dsh-usage-dashboard` was already taken on npm, so the
package publishes under the `@sixzjd` scope. The GitHub repository moves to
`sixzjd/dsh-usage-dashboard` (GitHub keeps redirects from the old path).

Because the rename touches the module id, the route prefix
(`/api/dsh-usage-dashboard/*`), the settings-section id, the locale namespace,
and the storage unit names, **0.6.0 does not upgrade in place over 0.5.x**:
remove the old bundle before adding this one.

```bash
dsh plugin --profile web remove dsh-usage-dash-board
dsh plugin --profile web add @sixzjd/dsh-usage-dashboard
```

The rewrite of the storage units only renames paths for a store that never
materialized, so no price or history data is migrated or lost.
