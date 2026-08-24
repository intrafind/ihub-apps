# Audit Log Filtering — Root Cause & Multi-Select Filter Redesign

**Issue:** [#2213 — Audit Log Filtering not possible](https://github.com/intrafind/ihub-apps/issues/2213)
**Date:** 2026-08-24
**Status:** Plan / awaiting review

---

## 1. Problem Statement

Two distinct problems are reported in the ticket:

1. **The filters do nothing.** Selecting a resource, action, result or source leaves the table
   unchanged. This is a hard bug, not a UX complaint.
2. **Single-select filtering is the wrong tool.** The log is dominated by `login` entries. An admin
   wants to say *"everything except logins"*, which a one-value dropdown cannot express. The ticket
   asks for checkbox lists with deselect and select-none/select-all.

---

## 2. Root Cause of "filters do nothing"

`client/src/features/admin/pages/AdminAuditLogPage.jsx:328`

```js
const handleFilterChange = setter => value => {
  setter(value);        // setSearchParams(prev => ...)  -> navigate("?resource=app")
  setPageParam('1');    // setSearchParams(prev => ...)  -> navigate("?")   <-- overwrites
};
```

Both setters come from `useFilterState` (`client/src/features/admin/hooks/useFilterState.js`), which
wraps React Router's `setSearchParams` with a functional updater.

React Router's own documentation for `useSearchParams` states:

> The function callback version of `setSearchParams` does not support the queueing logic that
> React's `setState` implements. **Multiple calls to `setSearchParams` in the same tick will not
> build on the prior value.**

The v7 source confirms it — the updater is called with a copy of the **render-time** `searchParams`
closure, not a live ref:

```js
const newSearchParams = createSearchParams(
  typeof nextInit === "function" ? nextInit(new URLSearchParams(searchParams)) : nextInit
);
navigate("?" + newSearchParams, navigateOptions);
```

So the second call (`setPageParam('1')`) recomputes from the params as they were **before** the
filter was applied, deletes `page` (because `'1'` equals its default), and navigates. The filter
change is discarded before it ever reaches the URL. Since the `<select>` is controlled by the URL,
it visibly snaps back to "All" and `fetchEntries` never re-runs with the new filter — exactly the
reported symptom.

**Why only this page is affected:** every other `useFilterState` consumer (`AdminUsersPage`,
`AdminAppsPage`, `AdminToolsPage`, `AdminMarketplacePage`, …) calls exactly **one** setter per
change; `AdminMarketplacePage` keeps its page number in plain `useState`. `AdminAuditLogPage` is the
only page that chains two URL setters in one handler.

**Second occurrence of the same bug** — `AdminAuditLogPage.jsx:526`:

```js
onPageSizeChange: size => {
  setPageSizeParam(String(size));
  setPageParam('1');        // same overwrite -> page size silently reverts to 50
}
```

**The server-side filtering is correct.** `queryAuditLog()` in
`server/services/AuditLogService.js` filters on `actor`, `resource`, `action`, `result` and `source`
properly, and `server/routes/admin/auditLog.js` forwards all of them. Nothing on the server needs a
fix for problem 1 — the parameters simply never arrive.

---

## 3. Secondary defects found while investigating

These are real and worth fixing in the same change, because they make the filters useless even once
the parameters are transmitted.

### 3.1 The resource dropdown lists values that are never written

`RESOURCE_TYPES` in `AdminAuditLogPage.jsx:19` is a hardcoded list of 13 singular names. The values
actually written to the log are:

| Source | Values |
| --- | --- |
| Explicit `logAudit()` calls | `app`, `auth`, `tool`, `prompt`, `model`, `source`, `group`, `oauthClient`, `marketplaceItem`, `user`, `platform`, `marketplaceRegistry`, `integrations`, `credential`, `apps`, `uiConfig`, `uiAsset`, `backup`, `toolScript`, `oauthToken`, `marketplaceRegistryCatalog`, `feature` |
| `auditLogger` middleware (`deriveResource`) | **anything** derived from the URL path — plural and open-ended (`usage`, `configs`, `workflows`, `schedules`, …) |

So the dropdown **offers** `provider` (never written by anything) and **omits** `tool`, `credential`,
`integrations`, `marketplaceItem`, `marketplaceRegistry`, `uiConfig`, `uiAsset`, `toolScript`, `apps`
and every path-derived value. `server/validators/auditEntrySchema.js` documents `resource` as
deliberately free-form, so a static client list can never be right.

### 3.2 The actor dropdown only knows the current page

`fetchEntries` builds `actorList` from `data.entries` — i.e. the ≤50 rows currently displayed
(`AdminAuditLogPage.jsx:299`). An admin cannot filter by anyone who does not happen to appear on
page 1, and the list changes as they page around.

### 3.3 `mcp` is an offered source that is never produced

`auditSources` allows `'web' | 'mcp' | 'api' | 'admin'`, and the UI offers all four, but
`deriveSource()` only ever returns `web`, `admin` or `api`, and no call site passes `mcp`.
Selecting it can only ever return zero rows. (Either wire it up in the MCP path or drop it — see
open questions.)

### 3.4 The audit log page has no translations at all

`shared/i18n/en.json` and `de.json` contain **zero** `admin.auditLog.*` keys — every string on the
page relies on the inline `t(key, 'English default')` fallback. The German UI therefore shows the
audit log entirely in English.

### 3.5 The documentation describes a feature that does not exist

`docs/admin-ui.md:175` claims *"Click any row to expand it and see the full event details. If a diff
is available, it shows exactly what changed."* The page only has a show-more/show-less toggle on the
`summary` cell. No detail view, no diff.

### 3.6 `server/tests/auditLogService.test.js` never runs in CI

`tests/config/jest.config.js` `testMatch` covers only `tests/integration/**`,
`tests/unit/server/**/*.test.js` and `tests/unit/client/**/*.test.jsx`. The audit tests living under
`server/tests/` are orphaned. New tests must go under `tests/unit/**` to actually execute.

---

## 4. Proposed Solution

### 4.1 Fix the URL-state loss (blocking, ships the bug fix on its own)

Add a batched multi-parameter setter next to `useFilterState` so a filter change and the page reset
land in **one** `setSearchParams` call:

```js
// client/src/features/admin/hooks/useFilterState.js
export function useFilterParams(defaults = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const get = name => searchParams.get(name) ?? defaults[name] ?? '';
  const setMany = useCallback(updates => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      for (const [name, value] of Object.entries(updates)) {
        if (value === null || value === '' || value === defaults[name]) next.delete(name);
        else next.set(name, value);
      }
      return next;
    }, { replace: true });
  }, [setSearchParams, defaults]);
  return { get, setMany };
}
```

`AdminAuditLogPage` then does `setMany({ resource: value, page: null })` — one navigation, nothing
lost. Same for the page-size handler.

Also add an explicit warning to `useFilterState`'s JSDoc ("never call two of these setters in the
same tick — see React Router's `setSearchParams` note") so the trap is not re-entered. `useFilterState`
itself is left untouched; it is correct for the single-parameter usage on every other page.

### 4.2 Replace the dropdowns with checkbox multi-selects

New shared component `client/src/features/admin/components/data-table/filters/FilterMultiSelect.jsx`,
exported from `data-table/index.js` so other admin tables can adopt it:

- Button showing the current state (`All actions`, `Actions: 3 of 8`, `No actions`), with a count badge.
- Popover with a checkbox per option, each showing the **number of matching entries** in the current
  date range, plus a **Select all** / **Select none** pair and (when >10 options) a type-ahead box.
- Accessibility: `role="listbox"`/`aria-multiselectable`, `aria-expanded` on the trigger, arrow-key
  navigation, Space to toggle, Esc to close, click-outside to dismiss, focus returned to the trigger.
  Modelled on the existing `GroupMultiSelect` interaction patterns.

Applied to **Resource**, **Action**, **Result**, **Source** and **Actor**. `From`/`To` stay as date
inputs.

### 4.3 URL encoding — include set minus exclude set

**Resolved 2026-08-24 (see Q2):** both directions are supported, `*` is a wildcard meaning "every
value", and **exclusion wins over inclusion**.

Each filterable field has two parameters:

| Parameter | Meaning | Default when absent |
| --- | --- | --- |
| `<field>` | the include set | `*` (everything) |
| `<field>Exclude` | the exclude set, subtracted from the include set | empty (nothing excluded) |

The matcher is a single rule — **include first, then subtract exclude**:

```js
const matches = value =>
  (include.has('*') || include.has(value)) && !(exclude.has('*') || exclude.has(value));
```

Which gives:

| URL | Result |
| --- | --- |
| *(neither parameter)* | everything — the default |
| `?action=*` | everything — explicit form of the default |
| `?action=create,update` | only those two |
| `?actionExclude=login,logout` | everything except those two |
| `?actionExclude=*` | nothing — the "select none" state |
| `?action=*&actionExclude=login` | everything except login |
| `?resource=app&resourceExclude=app` | nothing — exclusion wins on a value present in both |
| `?resource=app` | unchanged from today — existing links keep working |

**What the UI writes.** The checkbox control emits the **exclusion** form for a partial selection
(`actionExclude=login`), omits both parameters for "all", and writes `<field>Exclude=*` for "none".
Inclusion is fully supported on read, for today's bookmarked links and for anyone hand-writing a URL
or an integration that wants to pin an exact set.

The reason the UI prefers exclusion is that the two forms carry genuinely different intent for
*future* values, and a checkbox row cannot express which the admin meant: a stored inclusion list
means "pin exactly these", so a resource type introduced by a later release (say `resource: 'skill'`)
would be silently invisible in every bookmarked view. Exclusion means "everything but these", so new
values show up by default and only what an admin explicitly hid stays hidden — the right default for
an audit log. Admins who *do* want to pin an exact set can still write the inclusion form by hand.

**Value separators.** `resource`, `action`, `result` and `source` draw from comma-free vocabularies,
so they accept both comma-separated (`?action=a,b`) and repeated (`?action=a&action=b`) forms.
`actor` is free-form and a username can legitimately contain a comma (`Doe, John`), so the actor
filter uses **repeated parameters only** and is never comma-split. The UI emits repeated parameters
for actor accordingly.

**`*` as a literal value.** `*` is always read as the wildcard. No resource, action, result or source
value is `*`, and an actor named `*` is not a realistic case; this is documented rather than escaped.

### 4.4 Facets — real option lists with counts

The hardcoded `RESOURCE_TYPES` list and the page-scoped actor list are both replaced by
server-computed facets over the selected date range.

`queryAuditLog()` gains a `facets: true` option; `GET /api/admin/audit-log?facets=1` returns:

```jsonc
{
  "entries": [ ... ],
  "total": 1234,
  "facets": {
    "actor":    [ { "value": "alice", "count": 812 }, ... ],
    "resource": [ { "value": "auth",  "count": 806 }, ... ],
    "action":   [ { "value": "login", "count": 794 }, ... ],
    "result":   [ { "value": "success", "count": 1201 }, ... ],
    "source":   [ { "value": "web", "count": 900 }, ... ]
  }
}
```

Facets are computed in the **same file scan** as the query (not a separate endpoint) so the request
cost does not double. They are computed over the **date range only**, before the other filters are
applied — so unchecking `login` does not make the `login` checkbox and its count disappear.

Counts are what make the ticket's actual complaint tractable: the admin sees `login — 794` and knows
exactly what to untick.

### 4.5 Server-side filter matching

`queryAuditLog()` filter arguments become "single value or array" for `actor`, `resource`, `action`,
`result`, `source`, with matching `*Exclude` arguments. Route layer parses both repeated query
parameters (`?action=a&action=b`) and comma-separated ones (`?action=a,b`) into arrays, caps the
number of values per field (e.g. 100) so a crafted URL cannot build a huge filter set, and rejects
nothing else — unknown values simply match no rows.

The **CSV export** endpoint takes the exact same parsing path, so an export always matches what is
on screen.

### 4.6 Bounded query-performance improvement

`queryAuditLog()` currently `readFile`s each daily file, splits it, `JSON.parse`s **every** line into
one big array, sorts the whole thing, and only then filters. On a busy installation with the default
7-day window that is the entire log in memory per request — and the new facet pass would traverse it
again.

Change to a single streaming pass per file: parse a line, update the facet counters, apply the
filters, and keep the entry only if it matches. Sort the (much smaller) filtered set at the end.
Same output, one pass, materially less memory. No API change.

### 4.7 Translations and documentation

- Add a complete `admin.auditLog.*` block to `shared/i18n/en.json` **and** `shared/i18n/de.json`,
  covering the existing strings and the new filter controls. Keep the inline defaults as a safety net.
- Update the Audit Log section of `docs/admin-ui.md` to describe multi-select filtering, counts,
  select-all/none and the URL parameters — and correct or remove the row-expansion/diff claim in §3.5.
- Add a changelog entry under `docs/releases/5.5.0/` per the `document-feature` skill: the filter
  regression goes in `fixes.md`, the checkbox filters and facet counts in `features.md`. One entry per
  file, headline-first.

---

## 5. Files Touched

| File | Change |
| --- | --- |
| `client/src/features/admin/hooks/useFilterState.js` | add `useFilterParams` batch setter; document the single-setter-per-tick rule |
| `client/src/features/admin/pages/AdminAuditLogPage.jsx` | batch URL updates; multi-select filters; facet-driven options; remove `RESOURCE_TYPES`/`ACTION_TYPES`/`SOURCE_TYPES` constants and the page-scoped `actorList` |
| `client/src/features/admin/components/data-table/filters/FilterMultiSelect.jsx` | **new** — reusable checkbox filter |
| `client/src/features/admin/components/data-table/index.js` | export `FilterMultiSelect` |
| `server/services/AuditLogService.js` | array + exclude filter matching; facet aggregation; single-pass streaming scan |
| `server/routes/admin/auditLog.js` | shared query-parameter parser for list/query and export; `facets=1` |
| `shared/i18n/en.json`, `shared/i18n/de.json` | new `admin.auditLog.*` keys |
| `docs/admin-ui.md` | rewrite the Audit Log filtering section |
| `docs/releases/5.5.0/fixes.md`, `features.md` | changelog entries |
| `tests/unit/server/auditLogQuery.test.js` | **new** |
| `tests/unit/client/admin-audit-log-filters.test.jsx` | **new** |

Not touched: `server/middleware/auditLogger.js`, `server/validators/auditEntrySchema.js`,
`client/src/features/admin/hooks/useOverviewData.js` (its `/admin/audit-log?limit=8` call is
unaffected), and the other `useFilterState` consumers.

---

## 6. Test Plan

**`tests/unit/server/auditLogQuery.test.js`** (jest, writes JSONL fixtures to a temp contents dir)
- single-value filter still matches (backward compatibility with existing links)
- comma-separated and repeated-parameter inclusion lists
- `actionExclude=login,logout` returns everything else
- `action=*` is identical to omitting the parameter
- `actionExclude=*` returns nothing
- include + exclude combined (`action=*&actionExclude=login`)
- **exclusion wins**: a value present in both the include and the exclude set does not match
- exclusion of an unknown value is a no-op
- `actor` is not comma-split — an actor named `Doe, John` matches as one value
- legacy entries carrying `admin` instead of `actor` still match an actor filter
- facet counts are computed over the date range, unaffected by the other active filters
- `total` reflects the filtered count so pagination stays correct
- per-field value cap is enforced

**`tests/unit/client/admin-audit-log-filters.test.jsx`** (jest + testing-library, memory router)
- **regression test for the reported bug:** toggling a filter puts it in the URL **and** issues a
  refetch whose query string contains it — this test fails against `main` today
- changing a filter resets `page` to 1 in the *same* navigation
- changing page size keeps the new size (second occurrence of the same bug)
- Select all clears the exclusion parameter; Select none excludes every known value
- options and counts render from the facets payload, not from a hardcoded list
- keyboard: Esc closes, arrows move, Space toggles

**Manual**
- Log in as the local admin, generate login noise, untick `login` → the operational entries remain.
- Bookmark a filtered URL, reload, share → same view.
- Export CSV with filters active → the file matches the table.
- German UI → every label translated.

Pre-commit: `npm run lint:fix && npm run format:fix`, then `npm run test:unit`.

---

## 7. Decisions Taken (and why)

| # | Decision | Rationale | Reversible? |
| --- | --- | --- | --- |
| D1 | Fix the batching bug by adding `useFilterParams`, not by rewriting `useFilterState` | Every other page uses `useFilterState` correctly; rewriting it risks 13 working pages to fix one | yes |
| D2 | Support **both** include and exclude parameters, with `*` as a wildcard and exclusion winning over inclusion | Confirmed by @manzke on the ticket. Covers include-all (default) and exclude-all in one consistent rule, and lets an integration pin an exact set while the checkbox UI expresses "everything but these" | costly later — it is the URL contract |
| D3 | Keep the existing single-value inclusion parameters working | Bookmarked/shared filter links and `useOverviewData` keep working; purely additive API | yes |
| D2a | The **UI** writes the exclusion form for a partial selection; inclusion stays fully supported on read | The two forms differ in intent for values added by later releases, and a checkbox row cannot express which was meant — exclusion is the safe default for an audit log | yes, UI-only |
| D2b | `actor` uses repeated parameters only, never comma-split | A username can legitimately contain a comma; the other four fields cannot | yes |
| D4 | Facets folded into `GET /api/admin/audit-log?facets=1`, not a separate endpoint | One file scan instead of two per page load | yes |
| D5 | Facets computed over the date range only, **not** cross-filtered | Options and counts stay stable while ticking boxes; a cross-filtered facet would make the checkbox you just unticked vanish | yes |
| D6 | Show a count next to every option | The ticket's real pain is "a lot of logins" — counts are what tell the admin what to hide | yes |
| D7 | Drop the hardcoded `RESOURCE_TYPES` list entirely | It is provably wrong (§3.1) and cannot be kept correct, since middleware-derived resources are open-ended | yes |
| D8 | Single-pass streaming scan in `queryAuditLog` | Facets would otherwise double an already O(entire log) request | yes |
| D9 | Date inputs stay single-value | A date range is not a set; checkboxes add nothing | yes |
| D10 | No new config, no migration | Nothing here is admin-configurable; per CLAUDE.md a migration is only for config schema changes | yes |

---

## 8. Assumptions

1. The reported symptom is exactly the `setSearchParams` overwrite. This is proven from the React
   Router source and docs plus the code path, but has **not** been reproduced against a running
   instance in this environment (`node_modules` is not installed here). First implementation step is
   to reproduce it locally and confirm the failing client test goes red before the fix.
2. Audit volume per installation is "large but not enormous" — tens of MB per day at worst. The
   single-pass scan is enough; no index or database is warranted. If installations exist with far
   more, §9-Q6 applies.
3. Admins want *events*, not *sessions* — filtering, not aggregating. No grouping/rollup is planned.
4. `de` and `en` are the only locales that need keys (`shared/i18n/` contains only these two).
5. Nothing outside the admin UI consumes `/api/admin/audit-log` (verified: only
   `useOverviewData.js` and the page itself).
6. Changelog target is `docs/releases/5.5.0/` — `server/package.json` says `5.4.13` but `5.5.0` is
   the highest existing release directory.

---

## 9. Open Questions

**Q1 — Scope split.** Ship the bug fix (§4.1) as its own small PR first, then the multi-select
redesign? The fix is ~15 lines and restores working single-select filtering immediately; the redesign
is a few hundred lines and a UI review. *Recommendation: one PR, since the redesign replaces exactly
the code the fix touches and a two-step lands the same UI twice. Happy to split if you want the fix
out today.*

**Q2 — Exclusion vs inclusion in the URL (D2). ✅ RESOLVED 2026-08-24 by @manzke:** support both,
`*` matches all, exclusion overrides inclusion. Specified in §4.3. Two follow-on details were not
covered by the answer and are decided as D2a/D2b — say so if either should go the other way:
- **D2a** — for a *partial* selection the checkbox UI emits the exclusion form, not the inclusion
  form, so values added by a later release stay visible in bookmarked views. Both remain readable.
- **D2b** — `actor` is matched from repeated parameters only and never comma-split, because a
  username can contain a comma.

**Q3 — Free-text search.** Not in the ticket, but the log has no way to search `summary`,
`resourceId`, `ip` or `requestId`. A `q=` box would often beat any combination of checkboxes. In
scope?

**Q4 — Quick presets.** Worth a "Hide login/logout" one-click toggle and/or "Failures only" and
"Last 24h" chips above the filter row? Cheap, and aimed squarely at the ticket's "cumbersome"
complaint.

**Q5 — Row detail view.** `docs/admin-ui.md` already promises row expansion with a diff (§3.5) and it
does not exist. Do we build it (expand row → actor, ip, requestId, source, full summary), or correct
the documentation? *Recommendation: correct the docs now, file the detail view separately.*

**Q6 — Largest realistic audit volume.** If any installation writes millions of entries per week, a
per-day facet cache (or a rolling index file) would be needed instead of a live scan. What is the
worst case you know of?

**Q7 — The `mcp` source (§3.3).** Offered in the UI and allowed by the schema, but never written.
Wire `source: 'mcp'` into the MCP request path, or remove it from the UI? *Recommendation: remove it
from the UI now; wire it up when MCP auditing is actually specified.*

**Q8 — Default date range.** Still 7 days. With working filters, is a shorter default (24h) better
for load, or does 7 days match how you use it?

**Q9 — Orphaned tests (§3.6).** `server/tests/*.test.js` do not run in CI. Fix the jest `testMatch`
in this PR, or file it separately? *Recommendation: separately — it may surface unrelated failures
and would derail this PR.*

**Q10 — Retention badge placement.** Untouched by this plan, but it sits in the header next to
Export while the filters live in their own card. Any preference before the header gets a new
"active filters / clear all" affordance?

---

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| The URL contract changes; old shared links must not break | Inclusion parameters remain supported and tested (D3) |
| A crafted URL with thousands of filter values | Per-field value cap in the route parser (§4.5) |
| Facet computation slows down a large-range query | Same single pass as the query (D4/D8); facets only when `facets=1` |
| Rewriting `queryAuditLog`'s scan introduces a filtering regression | Filter behaviour pinned by server unit tests written **before** the rewrite |
| Multi-select popover regresses keyboard/screen-reader access | Explicit a11y test cases; `npm run test:a11y` covers the admin area |
