# Changelog

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
