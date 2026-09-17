# Sidebar and Home Redirect Refresh Fix

Issue: [#2320](https://github.com/intrafind/ihub-apps/issues/2320) — "Sidebar does not refresh as well as home redirect"

## Symptoms

Three reports, one page:

1. Changing which apps the sidebar shows (**UI Customization → Start Page**) did
   nothing until a full browser reload.
2. With app shortcuts set to rank **by recent use**, the sidebar's Apps section
   kept its boot order no matter how many apps were opened.
3. Changing what "/" opens — from a specific app to "All apps" or the start
   page — kept redirecting to the old target until a full reload.

## Root causes

### 1 and 3: the refresh after an admin save was answered from the client cache

`handleApiResponse` keeps every cacheable API response in an in-memory `Cache`
for its TTL — `DEFAULT_CACHE_TTL.LONG`, 30 minutes, for the UI config.

`AdminUICustomization.handleSave()` already called `refreshUIConfig()` after a
successful save, and `UIConfigContext` already refetched. But it refetched with
`fetchUIConfig()`, i.e. *with* the cache key, so the request never left the
browser: the context set state to the very same object it already held, React
bailed out of the re-render, and every consumer — `AppSidebar`'s app shortcuts,
`HomeRoute`'s `resolveHomePath(uiConfig)` — kept the configuration the page had
booted with.

Two details made it look stranger than it was:

- Reproducing it showed the *previous* save applying on the next save. With the
  30-minute TTL, whatever full page load happened in between seeded the cache,
  so each save was one step behind.
- `PlatformConfigContext` did refetch on refresh (`skipCache: true`), but
  `skipCache` sets the cache key to `null`, which suppresses the *write* as
  well as the read. So its refresh left the stale entries in place for every
  other consumer instead of replacing them.

### 2: the sidebar is mounted once and read `localStorage` once

`AppSidebar` lives in `Layout`, above the router outlet, so it mounts once per
page load. Its recent-app ranking came from `useMemo(() => getRecentAppIds(),
[mode])` — a single read, deliberately, to avoid reshuffling the list under the
user's cursor. `recordAppUsage()` (called from `AppChat`) wrote to
`localStorage` and told nobody, so nothing re-read it.

The start page was never affected: it is a route, so it remounts on every visit
and re-reads the list.

## The fix

**Invalidate, then refetch through the cache.** `Cache` gained the
`invalidateByPattern()` it always advertised in its class docs (and that
`api/utils/cache.js → invalidateCacheByPattern` already called — it threw,
because the method did not exist). A string matches by prefix, so one call
drops a resource together with its `buildCacheKey` variants
(`ui-config`, `ui-config?language=de`, …).

`invalidateUIConfigCache()`, `invalidatePlatformConfigCache()` and
`invalidateAuthStatusCache()` sit next to the fetchers that own those keys.
`UIConfigContext.refreshUIConfig()` and `PlatformConfigContext.refreshConfig()`
call them and then fetch *normally*, so the fresh response repopulates the
cache for everyone rather than bypassing it.

A refresh also no longer flips `isLoading`. With a config already on screen,
flipping it swapped live UI for a loading state (`LanguageSelector` renders
"Loading…", `HomeRoute` renders a spinner) while an answer was already
available.

**Subscribe to recent-app usage.** `createRecentItemHelpers` now dispatches an
`ihub:recent-items-changed` event on write and exposes `subscribe()`, matching
the `ihub:favorites-changed` pattern favorites already use — same-tab custom
event plus the native `storage` event for other tabs. `useRecentAppIds` wraps
it in `useSyncExternalStore` with a cached snapshot, so the sidebar re-renders
only when the order actually moved. The original concern (reshuffling under the
cursor) does not apply: usage is recorded on navigation *into* an app, when the
user has already left the list.

`import.meta.env.DEV` moved out of `client/src/utils/cache.js` into
`client/src/index.jsx` (`exposeCacheForDebugging()`). The Jest transform cannot
parse `import.meta`, so that one line was all that kept the cache untestable.

## Files

| File | Change |
| --- | --- |
| `client/src/utils/cache.js` | `invalidateByPattern()`; dev hook moved out |
| `client/src/index.jsx` | calls `exposeCacheForDebugging()` in dev |
| `client/src/api/endpoints/config.js` | `invalidateUIConfigCache`, `invalidatePlatformConfigCache` |
| `client/src/api/endpoints/misc.js` | `invalidateAuthStatusCache` |
| `client/src/shared/contexts/UIConfigContext.jsx` | refresh invalidates first; no loading flip |
| `client/src/shared/contexts/PlatformConfigContext.jsx` | refresh invalidates instead of bypassing |
| `client/src/utils/recentItems.js` | change event + `subscribe()` |
| `client/src/utils/recentApps.js` | exports `subscribeToRecentApps` |
| `client/src/shared/hooks/useRecentAppIds.js` | new — live recent-app ids |
| `client/src/shared/components/AppSidebar.jsx` | uses the hook |

## Verification

Unit tests (`npm run test:unit`, 68 suites / 794 tests):

- `tests/unit/client/api-cache-invalidation.test.jsx` — prefix and RegExp
  matching, parameterized-key families, empty pattern is not a full flush.
- `tests/unit/client/ui-config-refresh.test.jsx` — a refresh invalidates before
  it fetches, the saved config reaches `resolveHomePath` and
  `readAppShortcutConfig`, `isLoading` stays false mid-refresh, a failed
  refresh keeps the last good config.
- `tests/unit/client/recent-apps-live-order.test.jsx` — notification on write,
  per-list isolation, cross-tab `storage` events, stable snapshot when the
  order did not change.

End-to-end, against a booted dev server logged in as the bundled local admin,
driving the real admin UI and leaving it through the admin sidebar's "Back to
iHub" link (a client-side navigation — a full reload would hide the bug). Every
row failed before the change and passes after it:

| Scenario | Before | After |
| --- | --- | --- |
| `sidebarAppsCount` 5 → 2, then leave admin | 5 apps | 2 apps |
| "/" target: specific app → All apps | `/apps/{app}` | `/apps` |
| "/" target: All apps → start page | `/apps` (the previous save) | `/start` |
| `appsMode: recent`, open the last app in the list | order unchanged | that app first |
