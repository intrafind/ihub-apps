# Admin load gating — implementation notes (2026-11-16)

Epic intrafind/ihub-apps#3739, "Now" row 1: *A config page that failed to load offers no Save*.
Findings: ID-B1 (client half), IN-B1, IN-B6, OB-B1, OB-B2, PL-B3, CU-B5 / UX-N4, SH-B2, ID-B11 (auth page only).
Background: `concepts/admin-ui-review-2026-11/`.

## The rule

A settings page renders its form **only** after every *required* GET succeeded. Until then it
shows the page chrome plus `AdminLoadError` ("Couldn't load {resource}. {detail} Nothing was
changed." + Retry). Not a disabled form: no form at all. Every save handler also starts with
`if (!ready) return;` as a second line of defence.

## Building blocks

| File | What it does |
| --- | --- |
| `client/src/features/admin/hooks/useAdminConfigLoad.js` | `useAdminConfigLoad({ sources: { key: { load, required, onLoad } } })` → `{ status, sourceStatus, data, errors, error, retry, retrying, retryAfterSeconds }`. Required failure → `failed`; optional failure → still `ready`, in `errors`. `retry()` re-runs failed sources only, in place. Stale and post-unmount responses are dropped (generation counter per source). 429 → `Retry-After` (header, then problem+json `retryAfter`, else 10 s), counted down once a second. `describeAdminLoadError(err)` is exported. |
| `client/src/features/admin/components/AdminLoadGate.jsx` | Renders spinner / `AdminLoadError` / children (children may be a function). `sources` prop gates one section of a multi-section page. |
| `client/src/features/admin/components/AdminLoadError.jsx` | Additive props `resourceLabel`, `status` (403 → "You can't view …", no Retry; 404 → not found), `onRetry` (in place; reload stays only as fallback), `retryAfterSeconds` (disabled "Retry in N s"), `retrying`. Real button with focus ring. |
| `client/src/features/admin/hooks/useAdminResourceEditor.js` | Adds `loadError` + `retryLoad`; `save()` throws while `loadError` is set. |
| `client/src/shared/components/AdminEditPageShell.jsx` | New props `loadError`, `onRetry`, `resourceLabel`, `notFoundAction`: breadcrumb + error instead of the form. Wired on the Model and App editors (Group/Prompt/User already returned an error view). |

## Pages converted

Auth (defaults removed; groups + schema optional; `useUnsavedChanges` with the loaded config as
baseline), MCP gateway, Office / browser extension / Copilot / Nextcloud, Telemetry, Logging (3
required GETs), Security cards (SSL, Cookies, CORS, Rate limits, SSRF, Tool approval, Proxy — each
card gates itself), UI customization (title + Retry instead of red text), Voice input, OAuth
server, Feedback settings tab, LLM timeouts card. Overview: a failed apps request yields
`loadError` + `retry`, never `isFreshInstance` (checklist ticks untouched, that is SH-B3).

## How to add a new settings page

1. `const load = useAdminConfigLoad({ sources: { x: { load: async () => (await makeAdminApiCall(url)).data, onLoad: setForm } } });`
2. `const ready = load.status === 'ready';` and `if (!ready) return;` at the top of every save.
3. Render `<AdminLoadGate load={load} resourceLabel={t('…resource', '… settings')}>{() => form}</AdminLoadGate>`.
4. Add the `…resource` key to `shared/i18n/en.json` and `de.json`.

The ratchet `tests/unit/client/admin-load-gate-coverage.test.jsx` fails for a new config writer
that does neither; its `KNOWN_UNGATED` list (with reasons) may only shrink.

## Tests

- Unit: `admin-config-load.test.jsx` (hook + gate), `admin-auth-page-load-failure.test.jsx`,
  `admin-overview-load-failure.test.jsx`, `admin-load-gate-coverage.test.jsx`.
- E2E (not run in the parallel worktree; run sequentially): `tests/e2e/admin-load-gating.spec.js`.

## Open points

- Security page has no "n of m sections couldn't load · Retry all" summary banner (ux.md §2 PR1
  item 6); each card has its own Retry.
- Focus is not moved to the H1 after a successful Retry (ux.md item 4).
- The Overview error banner has no Retry-After countdown.
