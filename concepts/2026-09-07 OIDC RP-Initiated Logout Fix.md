# OIDC RP-Initiated Logout Fix

Status: Implemented (branch `fix/oidc-rp-initiated-logout`)
Date: 2026-09-07

## Summary

Logging out of iHub while authenticated via an OIDC provider (Keycloak,
tested end-to-end; Entra ID / Auth0 / ADFS by design, untested live) only
cleared iHub's own auth cookie. The provider's own SSO session stayed
active in the browser, so the next login attempt - by the same user, or by
a different person on a shared/kiosk device - was silently re-authenticated
by the provider without ever showing a login form.

## Bug

### Current behavior (before this fix)

- `server/middleware/oidcAuth.js`: the ID token returned by the provider is
  decoded once (to read a `groups` claim some IdPs only put there), then
  discarded. It is never persisted anywhere - not in the JWT, not in a
  session, not in a cookie.
- `POST /api/auth/logout` (`server/routes/auth.js`) only clears the local
  `authToken` cookie. No call to the provider's `end_session_endpoint`, no
  `id_token_hint`, no redirect to the IdP.
- `client/src/shared/contexts/AuthContext.jsx` (`logout()`) redirects the
  browser straight back to iHub's own home page, never to the provider.
- `oidcProviderSchema` (`server/validators/platformConfigSchema.js`) has no
  field for a logout/`end_session_endpoint` URL at all.

### Root cause classification

Investigated whether this was a deliberate design choice (e.g. "local
logout only" to preserve a shared SSO session across other apps on
purpose) versus an oversight. Evidence points to oversight:

- `docs/ADFS-AUTHENTICATION-GUIDE.md` already documented a `logoutURL`
  provider field for exactly this purpose - it was never wired up in any
  code path (confirmed via full-repo grep). Doc/code drift, not a
  documented trade-off.
- iHub's own OIDC **Identity Provider** side (`server/routes/oauth.js`,
  `/api/oauth/logout`) already implements RP-Initiated Logout correctly to
  spec (`id_token_hint`, `post_logout_redirect_uri`, `state`,
  `postLogoutRedirectUris` allowlist) - the team clearly knows the pattern
  and applies it correctly elsewhere; it was simply never mirrored on
  iHub's own relying-party (client-of-an-external-IdP) side.
- No code comment, config toggle, or doc anywhere discusses a deliberate
  choice to keep OIDC logout local-only.

### Impact

- Deviates from [OIDC RP-Initiated Logout 1.0](https://openid.net/specs/openid-connect-rpinitiated-1_0.html)
  and from session-termination expectations in NIST SP 800-63B ("Session
  tokens SHALL be erased or invalidated by the session subject when the
  subscriber logs out").
- Shared/kiosk devices: a user clicking "Log out" so a colleague can log in
  can result in the colleague being silently authenticated as the first
  user - no credential prompt, full account access (chat history, any
  admin rights) transferred without anyone entering credentials. Confirmed
  as the concrete, reproducible failure mode driving this fix.
- Users are shown a "logged out" state that is misleading with respect to
  the IdP session.

## Solution

### Mechanism

Opt-in [OIDC RP-Initiated Logout 1.0](https://openid.net/specs/openid-connect-rpinitiated-1_0.html)
per provider, via a new optional `endSessionURL` field. No behavior change
for any provider that leaves it unset - fully backward compatible, no
config migration needed.

1. **Login** (`server/middleware/oidcAuth.js`): when the provider has
   `endSessionURL` configured, the ID token is passed out of the Passport
   verify callback via `done(null, user, { idToken })` - Passport's
   existing `info` argument, not the user object (which flows into
   `validateAndPersistExternalUser()` and can be persisted to
   `contents/config/users.json`; the ID token must never end up there). The
   callback handler stores it in a new httpOnly `oidcLogoutHint` cookie
   (`{ provider, idToken }`, same cookie options as the existing
   `authToken`).
2. **Logout, step 1** (`POST /api/auth/logout`): clears `authToken` as
   before, unconditionally. Additionally checks whether the *current*
   session is OIDC-authenticated and `oidcLogoutHint` is present (never
   reads/parses its content here), and returns that as
   `oidcLogoutRequired: true|false`. Only clears `oidcLogoutHint` itself
   when that's `false` - when it's `true`, step 3 below is the one that
   reads and clears it (see Bug 4 for why clearing it here too would break
   step 3).
3. **Logout, step 2** (new `GET /api/auth/oidc-logout`): if the client
   received `oidcLogoutRequired: true`, it navigates the whole page here
   (not a fetch/XHR call). This endpoint reads and parses the
   `oidcLogoutHint` cookie, looks up the provider, and - if it has
   `endSessionURL` - 302-redirects the browser to
   `{endSessionURL}?id_token_hint=...&post_logout_redirect_uri=...&client_id=...`.
   Any missing/malformed/stale hint falls back safely to the plain
   `/?logout=true` landing page. The `oidcLogoutHint` cookie is cleared
   either way.
4. **Client** (`AuthContext.jsx`): `logout()` now branches on
   `oidcLogoutRequired` to decide between the two landing targets above.

### Security review finding (addressed)

First draft had `/api/auth/logout` return the fully-built provider logout
URL - including the raw `id_token` as `id_token_hint` - as a JSON field,
read by the client via `fetch`/axios. That puts a sensitive token into a
JS-readable API response body: exposed to CORS misconfiguration
(`cors.credentials: true` + an overly broad `ALLOWED_ORIGINS`), browser
extensions with network access, or client-side error/analytics tooling
that logs responses.

Fixed by keeping the token server-side end to end: `/api/auth/logout`
returns only a boolean, never the token or URL. The actual provider
redirect happens through the dedicated `GET /api/auth/oidc-logout`
endpoint, reached via a real top-level browser navigation. The raw ID
token now only ever exists in the httpOnly cookie and the `Location`
header of a 302 - never in a JS-readable response body. Mirrors how OIDC
reference implementations (e.g. Spring's
`OidcClientInitiatedLogoutSuccessHandler`) do it, and the existing
`createOidcAuthHandler` pattern already in this codebase (a GET route
whose whole job is redirecting the browser into an external OIDC flow).

### Dev-environment regression found and fixed during manual testing

`post_logout_redirect_uri` was built from `req.get('host')` directly. In
this project's dev setup, Vite proxies `/api/*` to the backend with
`changeOrigin: true` (`client/vite.config.js`), which rewrites `Host` to
the backend's own port - not the SPA's port the browser actually needs to
land back on. Vite already compensates by setting `X-Forwarded-Host` to
the real browser host for exactly this reason. Fixed by reusing the
already-existing, already-tested `buildPublicBaseUrl()` helper
(`server/utils/publicBaseUrl.js`, also used by the Office 365 callback URL
builder and the browser-extension download endpoint) instead of reading
`req.get('host')` directly. Works unchanged in production, where there is
no separate Vite process.

### Provider coverage

The redirect-building code has no provider-specific branching - it is a
generic `id_token_hint` / `post_logout_redirect_uri` / `client_id` query
builder against whatever `endSessionURL` is configured.

| Provider | End-session endpoint | Status |
| --- | --- | --- |
| Keycloak | `{issuer}/protocol/openid-connect/logout` | Verified end-to-end (real login + logout + re-login round trip) |
| Microsoft Entra ID | `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/logout` | Spec-compliant, code path exercised by tests, not verified against a live tenant |
| Auth0 | `https://{domain}/oidc/logout` (the OIDC-compliant endpoint - not the legacy `/v2/logout`) | Same as above |
| ADFS | `https://{adfs-server}/adfs/oauth2/logout` | Same as above; no practical way to run ADFS locally (needs a full Windows Server + AD domain controller) |
| Custom/generic OIDC | Admin-supplied | Covered by the same generic path as Keycloak |
| Google | No `end_session_endpoint` exists at all | Explicitly out of scope - `endSessionURL` simply stays unset; would need a different, login-side mitigation (forcing `prompt=select_account`), not a logout-time fix |

### Admin UI

Added an **End Session URL** field to Admin → Authentication (next to
Callback URL), including a live-computed hint showing the exact
`{origin}/*` value to register at the provider as a "valid post logout
redirect URI" - the single operational step most likely to be missed
otherwise (it was, during our own manual testing of this fix). Not
strictly required for the feature to work - the field was already
settable via Admin → Authentication → JSON mode or by editing
`platform.json` directly, since `platformConfigSchema` is not enforced as
a save-time validation gate - but added for discoverability and to reduce
the exact setup mistake found during testing.

### Operational requirement (not code)

The provider's client must allow-list iHub's own URL as a valid
post-logout redirect target (in Keycloak: client → **Valid post logout
redirect URIs**). Without it, the provider will refuse the redirect back
to iHub after logout - iHub's own local session is still cleared either
way; only the bounce-back fails, and the failure is visible (an error page
at the provider), not a silent hang. A startup-time warning log
(`server/middleware/oidcAuth.js`) now flags any provider with
`endSessionURL` set, naming the requirement, so this is caught during
setup rather than by an end user.

## Testing performed

- `server/tests/oidc-logout.test.js` (15 tests, Jest + Supertest):
  `oidcLogoutRequired` signaling tied to the current session's `authMode`,
  never touching the token; the cookie is cleared in `POST /api/auth/logout`
  only when it won't be consumed downstream, and left alone otherwise (the
  bug 4 regression test); safe fallback on missing/malformed/unknown
  -provider/no-endSessionURL/malformed-URL hints; correct
  `id_token_hint`/`post_logout_redirect_uri`/`client_id` construction;
  explicit regression test for the `X-Forwarded-Host` dev-proxy fix.
- Manual end-to-end against a real local Keycloak (Docker), repeated after
  each fix: login, logout, re-login. First two attempts still reproduced the
  bug (bug 4, above) despite the code review's earlier sign-off - only the
  third attempt, after the premature-clear fix, actually showed Keycloak's
  own login form on re-login instead of silently re-authenticating.
- Verified via DevTools Network tab that the raw `id_token` never appears
  in any XHR/fetch response body - only in the `Location` header of the
  302 from `/api/auth/oidc-logout`.
- Regression check: providers without `endSessionURL` behave identically
  to before (`oidcLogoutRequired: false`, direct redirect, no
  `oidcLogoutHint` cookie ever set).
- Full repo test suite run for comparison: pre-existing, environment-level
  failures (worker process crashes, likely missing services such as Redis
  in this sandbox) exist identically with and without this change (129/189
  suites failing on a clean baseline vs. 130/190 with this change, the
  only difference being this change's own new, passing suite) - not caused
  by this fix, but should be confirmed against real CI before merge.

## Pre-PR review findings (fixed)

A full security review (dedicated agent) and an 8-angle code review (correctness,
removed-behavior, cross-file, reuse, simplification, efficiency, altitude,
CLAUDE.md conventions - each independently verified) were run against this
diff before opening the PR.

**Security review**: no CONFIRMED/PLAUSIBLE findings at HIGH/MEDIUM severity.
Candidates considered and ruled out with concrete reasoning: the
`post_logout_redirect_uri` built from `buildPublicBaseUrl()` (trusts
`X-Forwarded-Host`) is not an open redirect within iHub's trust boundary -
it's only ever consumed by the external, admin-configured IdP, which is
expected to validate it against its own allowlist; the unsigned
`oidcLogoutHint` cookie is httpOnly (no direct JS read/write) and host-only
scoped (no `domain` attribute), so forging it requires an existing XSS or
network MITM - preconditions that already grant far more powerful primitives
than this cookie; the unauthenticated, CSRF-unprotected `GET
/api/auth/oidc-logout` matches the existing pattern of every other OIDC GET
route and its worst case is a self-targeting forced logout, not unauthorized
access.

**Code review found and fixed 3 real bugs**:

1. **Stale `oidcLogoutHint` cookie could redirect a non-OIDC logout through an
   unrelated provider.** `oidcLogoutRequired` was computed from cookie
   presence alone; nothing cleared it on a subsequent local/LDAP/NTLM/Teams
   login (a supported dual-auth configuration). Fixed by additionally
   requiring `req.user?.authMode === 'oidc'` (from the current session's
   verified JWT, not a separately-lived cookie), and by clearing
   `oidcLogoutHint` in `POST /api/auth/logout` **only when it won't be used**
   (`oidcLogoutRequired === false`) - see finding 4 below for why clearing it
   unconditionally there is itself a bug, not the fix.
2. **Unguarded `new URL(provider.endSessionURL)`** could throw an uncaught
   exception (500) if an admin saved a malformed URL - `oidcProviderSchema`'s
   `endSessionURL: z.string().url()` is only used for schema export, not
   actually enforced by the admin config save route. Fixed: wrapped in
   try/catch as another graceful-fallback branch, consistent with the other
   invalid-state checks in the same handler.
3. **Admin UI's "register this URL" hint ignored subpath deployments** -
   built from `window.location.origin` alone, while the server's actual
   `post_logout_redirect_uri` (via `buildPublicBaseUrl()`) includes the
   `X-Forwarded-Prefix`-derived base path too. Fixed: hint now also uses
   `getBasePath()` from `client/src/utils/runtimeBasePath.js`.

Regression tests added for all three (`server/tests/oidc-logout.test.js`,
now 15 tests). Two lower-severity suggestions (collapsing five near-identical
guard-clause branches into a table/helper; reusing `safeParseJsonAsync` for
the cookie's JSON parsing) were considered and deliberately not applied - see
inline reasoning in the corresponding code-review findings.

## Bug 4: fix #1 above regressed the happy path (found via live testing, not by review)

The unconditional `res.clearCookie('oidcLogoutHint', ...)` that fix #1's own
first draft added to `POST /api/auth/logout` (to close the stale-cookie gap)
deleted the cookie in *that* response - before the client's follow-up
navigation to `GET /api/auth/oidc-logout` ever got a chance to read it. Every
OIDC logout was silently downgraded to local-only: iHub's own session ended,
but the provider's SSO session never did, so the very next login
re-authenticated without a credential prompt - reproducing the original bug
this whole feature exists to fix, immediately after "fixing" it.

Neither the security review nor the 8-angle code review (including its own
cross-file/removed-behavior angles) caught this - it only surfaced through
manual end-to-end testing against a real Keycloak instance, diagnosed via:
`platform.json`'s `auth.debug.enabled` flag turned on temporarily to trace
the token exchange (confirmed Keycloak really does return `id_token` and the
cookie-set condition was true), the audit log (`GET /api/admin/audit-log`,
confirmed real OIDC logins were completing each cycle), and finally the
browser's own Network tab request headers (confirmed the cookie *was* being
sent correctly on `POST /api/auth/logout` - proving the bug was server-side,
in the unconditional clear, not a browser/cookie-transport issue).

**Fix:** `POST /api/auth/logout` now only clears `oidcLogoutHint` when
`oidcLogoutRequired` is `false` (i.e. when `GET /api/auth/oidc-logout` will
never be called) - see `server/routes/auth.js:565-574`. Regression test:
"does NOT clear the oidcLogoutHint cookie here when it WILL be used (OIDC
session)" (`server/tests/oidc-logout.test.js`).

**Lesson for next time:** a static/agent-based review, however thorough,
does not substitute for one real end-to-end run of a multi-request flow
against real infrastructure before calling a fix like this done - test
coverage for this exact regression now exists, but didn't at review time
because the review (correctly, given what it was shown) reasoned about the
two endpoints' cookie-clearing calls in isolation rather than tracing the
cookie's full lifecycle across both requests in sequence.

**Follow-up items noted but not addressed (low severity, not blockers):**
- If the client's `POST /api/auth/logout` succeeds with
  `oidcLogoutRequired: true` but the follow-up navigation to
  `GET /api/auth/oidc-logout` never happens (network failure, closed tab, JS
  error), the hint cookie is left un-consumed until it naturally expires.
  Not a security issue (httpOnly, single consumer), but silently reproduces
  the user-visible symptom (provider session stays alive) via a client-side
  gap rather than a server-side one. Not currently tested.
- A narrow two-tab race exists: logging out from two tabs in quick
  succession could have the second (non-OIDC-flagged, since `authToken` was
  already cleared by the first) request's conditional clear win before the
  first tab's `GET /api/auth/oidc-logout` reads the cookie. Requires
  deliberate concurrent logout attempts to trigger; not currently tested.

## Out of scope / follow-ups

- Google-specific mitigation (`prompt=select_account` on the login
  request) - no `end_session_endpoint` exists for Google, so this needs a
  different, login-side mechanism.
- Live verification against a real Entra ID / Auth0 / ADFS tenant.
- The unrelated, pre-existing `logoutURL` doc/code mismatch in
  `docs/ADFS-AUTHENTICATION-GUIDE.md` has been corrected to reference the
  real `endSessionURL` field as part of this change.
