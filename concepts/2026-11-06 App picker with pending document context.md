# App picker with pending document context

Issue: intrafind/ihub-apps#3336 · iFinder side: APPS-1655 ("Open in iHub" hit action), spike APPS-1656

## Problem

iFinder wants an "Open in iHub" action on a hit: the user lands in iHub, chooses an app, and the
document is attached to that app's chat. Today `documentId` + `source` (+ `searchProfile`) are only
understood on `/apps/:appId` (`AppChat.jsx`), so the host must already know the target app. The
`/apps` list and `/start` drop the context.

## Decisions

### 1. Carry the context in the URL, not in client state

`/apps?documentId=…&source=ifinder[&searchProfile=…][&prefill=…]` stays the source of truth while
the user browses. Picking an app navigates to `/apps/:appId?<the same four params>`; the existing
`AppChat` consumer attaches the document and strips the params (`replace`).

Why not a store / `sessionStorage`: the URL needs no cleanup protocol. "Cleared once consumed" is
already true on `/apps/:appId` (stripped after the attempt, so a refresh does not re-attach), and a
refresh on `/apps` correctly keeps the pending context because nothing consumed it. It also works
unchanged in a new tab, and after the auth round trip (`AuthContext` stores the full
`window.location.href` as the return URL).

Forwarded: `documentId`, `source`, `searchProfile`, `prefill` — nothing else. In particular **not**
`send`, `model`, `var_*`: `send=true` would auto-send in whichever app the user happens to click.

### 2. One module owns the contract

`client/src/features/apps/utils/pendingDocument.js`:

- `readPendingDocument(searchParams)` → `{ documentId, source, searchProfile, prefill } | null`.
  Validates like the server does (`source` = `^[\w.-]{1,100}$`, id ≤ 1024, scope ≤ 256 chars) so a
  malformed link is treated as "no pending document" rather than producing a failing request.
- `pendingDocumentQuery(doc)` → the query string to forward.
- `stripPendingDocumentParams(searchParams)` → params minus the four (used when the user dismisses).
- `appAcceptsDocuments(app)` → chat app with file upload enabled.

`AppChat` switches to the same constants/validator instead of its inline regex and param names.

### 3. Banner on the picker (`PendingDocumentBanner`)

Modeled on `NextcloudSelectionBanner`. States:

| State | Trigger | UI |
| --- | --- | --- |
| checking | `GET /api/sources/:provider/metadata` in flight | neutral banner, title falls back to `prefill`/id |
| ready | 200 | "Choose an app to open **{title}** in" |
| no access | 401/403 | error banner, `role="alert"` |
| not found | 404 from the provider (not "provider has no details") | error banner |
| unverified | provider has no metadata, 5xx, network | behaves as *ready* (AppChat still reports a real failure) |

In the error states the pending context is dropped: app clicks open the app **without** document
params, and the banner offers "Continue without the document". A **Dismiss** action in the ready
state does the same (removes the params from `/apps`).

### 4. Optional picker restriction

The banner has a checkbox "Only show apps that accept documents", **on** by default. `/api/apps`
already returns each app's `upload` config, so no server change. If no app qualifies the filter is
not applied (an empty picker is worse than an imperfect one) and the checkbox is hidden.

### 5. `/start`

The start page hosts the default app's chat input, which cannot carry a document. With a pending
document `/start` redirects (`replace`) to `/apps` with the params intact, so the picker is the one
place that implements the flow. `/` is not extended — it is an admin-configured pointer and iFinder
links to `/apps` or `/start`.

### 6. Failure in the chat is visible

`AppChat` currently only `console.error`s when the attach fails. It now adds a system message:
no access (401/403), not found (404), generic otherwise. This is the backstop for links that go
straight to `/apps/:appId?documentId=…` and for the "unverified" picker state.

### 7. Embed mode

`AppChat` ignores URL params while `embedded` (no router/URL there) and embedded hosts do not render
`AppsList`, so this change does not alter embed behavior. The helper module keeps the parameter
contract in one place so the embed/mode issue can feed the same shape (e.g. from a postMessage
bridge, like the Nextcloud selection) without a second definition. Opening from iFinder in a new tab
is the plain URL flow and works as described above.

## Out of scope / left as is

- `prefill` keeps its dual role in `AppChat` (prompt text and the file-name fallback).
- No server change, no config migration, no new permission: the document is still fetched through
  `/api/sources/:provider/content` with the user's own rights.
- No backward-compat shim needed: `/apps/:appId?documentId=…` behaves as before.

## Acceptance mapping

| Criterion | Where |
| --- | --- |
| `/apps?documentId&source=ifinder` shows picker + banner; choosing an app attaches | §1, §3 |
| Params cleared once consumed; refresh does not re-attach | §1 (AppChat strip, unchanged) |
| Unauthorized / unknown document → clear error | §3 (picker), §6 (chat) |
| `/start` supported | §5 |
| Optional restriction to document-capable apps | §4 |
| New tab / embed | §7 |

## Tests

- Unit: `pendingDocument.js` (validation, query forwarding, `send` not forwarded, strip, predicate).
- Component: banner states (ready / no access / not found / unverified) and dismiss.
- Component: `AppsList` forwards the params on click and filters when the checkbox is on.
