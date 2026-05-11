# Cloud Storage Provider Security Parity

**Date:** 2026-05-11
**Status:** Proposed
**Related PR:** [#1416 — Nextcloud cloud-storage provider](https://github.com/intrafind/ihub-apps/pull/1416)
**Related security review:** Internal review of PR #1416 (Nextcloud) by the security agent
**Owner:** TBD

## Problem Statement

While adding Nextcloud as a third cloud-storage provider (PR #1416), a parallel security review surfaced **eight hardening gaps** in the existing Office 365 and Google Drive code paths. The Nextcloud PR addressed every one of them in the new code, but to keep the PR diff manageable the same fixes were **not** ported back to the two pre-existing providers. The result is the same vulnerability/limitation existing unchanged in 4–6 files across `office365.js`, `googledrive.js`, `Office365Service.js`, and `GoogleDriveService.js`.

This concept is the punch-list to bring Office 365 and Google Drive up to the Nextcloud baseline, plus one cross-cutting limitation that affects all three providers and was explicitly deferred at maintainer agreement.

### Why this isn't already done

PR #1416 was already large (15 files, ~2300 net lines). Touching Office 365 and Google Drive in the same PR would have:

- Expanded the review surface beyond what a single reviewer can hold in their head.
- Mixed feature work (Nextcloud) with hardening work (parity fixes) in a way that makes the diff hard to bisect.
- Pulled the multi-provider token-scoping refactor (which touches `TokenStorageService` + all three services + all three routes + three client hooks) into a PR whose stated scope was a single new provider.

So everything was either fixed for Nextcloud only or explicitly deferred to this follow-up.

## Concrete Findings to Port

Each finding lists the Nextcloud commit that introduced the fix, then the equivalent change required for Office 365 and Google Drive.

### 1. `isValidReturnUrl` accepts non-http(s) schemes (open redirect / pseudo-XSS)

**Severity:** Medium

**The bug:** Each callback route file defines `isValidReturnUrl(returnUrl, req)` that parses the URL and only checks `url.hostname === req.hostname`. `URL.hostname` happily parses `javascript://ihub.example.com/...` and reports `ihub.example.com` as the hostname, so the value passes validation and is then handed straight to `res.redirect()`. Major browsers strip JS-scheme `Location` headers, but defense-in-depth says we should never emit them.

**Affected files (Nextcloud is fixed):**

- `server/routes/integrations/office365.js` (function defined inline around line 24)
- `server/routes/integrations/googledrive.js` (function defined inline around the same line)
- `server/routes/integrations/jira.js` (same pattern — verify and fix if applicable)

**The fix** (already landed in `server/routes/integrations/nextcloud.js`):

```js
function isValidReturnUrl(returnUrl, req) {
  if (!returnUrl) return false;
  if (returnUrl.startsWith('/') && !returnUrl.startsWith('//')) return true;
  try {
    const url = new URL(returnUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.hostname === req.hostname;
  } catch {
    return false;
  }
}
```

While doing this, extract the function to a shared `server/utils/oauthReturnUrl.js` so the three (or four, with Jira) callback handlers can import the same implementation — otherwise the same drift problem repeats next time.

### 2. `Content-Disposition` filename injection on downloads

**Severity:** Medium

**The bug:** Both `office365.js` and `googledrive.js` build the response with `res.setHeader('Content-Disposition', \`attachment; filename="${file.name}"\`)`. The filename comes from the user-controlled `filePath` query parameter (after `isValidGraphId` validation, which permits a generous character set). A filename containing `"` or backslashes can break out of the quoted value or even inject a second header field; browsers pick the second `filename=` value, so the served file can be silently renamed.

**Affected files (Nextcloud is fixed):**

- `server/routes/integrations/office365.js` around line 629
- `server/routes/integrations/googledrive.js` (similar line — verify exact line)

**The fix** (already in `nextcloud.js`):

```js
const asciiFallback = (file.name || 'download')
  .replace(/[^\x20-\x7E]/g, '_')
  .replace(/["\\\r\n]/g, '_');
const utf8Encoded = encodeURIComponent(file.name || 'download');
res.setHeader(
  'Content-Disposition',
  `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`
);
```

Same extraction opportunity: pull this into `server/utils/safeContentDisposition.js`.

### 3. No server-side cap on download body size

**Severity:** Medium (DoS)

**The bug:** Both Office 365 and Google Drive services do `Buffer.from(await response.arrayBuffer())`. The client picker enforces a per-file upload cap (`uploadConfig.maxFileSizeMB`), but the server has no such guard — a logged-in attacker can hit `/download?fileId=huge.bin&driveId=...` directly with `curl` and OOM the worker. Multiple concurrent calls can take down the cluster.

**Affected files (Nextcloud is fixed):**

- `server/services/integrations/Office365Service.js` (`downloadFile`, around line 1027)
- `server/services/integrations/GoogleDriveService.js` (`downloadFile`, around the equivalent location)

**The fix** (already in `NextcloudService.js`):

```js
async function readBoundedBody(response, maxBytes, label) {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
  }
  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (received > maxBytes) {
      try { response.body.destroy(); } catch { /* ignore */ }
      throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
```

Extraction target: `server/utils/boundedBodyReader.js` so all three services use the same helper and the cap can be tuned in one place (current default: `MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024`).

### 4. `req.user.id` fallback to a shared sentinel

**Severity:** Low

**The bug:** Each provider's `/auth` route stores `userId: req.user?.id || 'fallback-user'` (Office 365) / `userId: req.user?.id || 'anonymous'` (Google Drive — verify) in the session. `authRequired` only rejects `req.user === null/undefined` and `req.user.id === 'anonymous'`; it does not guarantee `req.user.id` is truthy in other shapes. If a future auth provider emits `{ id: '' }` or `{ id: null }`, the OAuth flow lands in a shared bucket where the next visitor inherits the connection.

**Affected files (Nextcloud is fixed):**

- `server/routes/integrations/office365.js` around line 104
- `server/routes/integrations/googledrive.js` around the equivalent line

**The fix** (already in `nextcloud.js`):

```js
if (!req.user?.id) {
  return sendAuthRequired(res);
}
// then drop the `|| 'fallback-user'` fallback below
```

### 5. Callback `catch` redirect echoes raw error messages

**Severity:** Low

**The bug:** The catch block at the bottom of each callback handler does:

```js
res.redirect(`${returnUrl}?...?_error=${encodeURIComponent(error.message)}`);
```

Most upstream `throw new Error(...)` calls are safe strings, but a few interpolate user-influenced segments (e.g. file paths). Putting them in the redirect URL is needless disclosure.

**Affected files (Nextcloud is fixed):**

- `server/routes/integrations/office365.js` around line 240
- `server/routes/integrations/googledrive.js` around the equivalent line

**The fix** (already in `nextcloud.js`):

```js
res.redirect(`${catchReturnUrl}${catchSeparator}office365_error=callback_failed`);
```

(Use stable per-provider error codes; the existing client error handlers already key off the prefix.)

### 6. Force `application/octet-stream` on download Content-Type

**Severity:** Low (defense-in-depth)

**The bug:** Both providers set `res.setHeader('Content-Type', file.mimeType || 'application/octet-stream')`. The mimeType comes from the upstream Microsoft Graph / Google Drive API. Combined with `Content-Disposition: attachment` it's currently safe, but reflecting upstream MIMEs means a future refactor that drops the attachment disposition would open an XSS vector. Cheap fix today.

**Affected files (Nextcloud is fixed):**

- `server/routes/integrations/office365.js` around line 627
- `server/routes/integrations/googledrive.js`

**The fix** (already in `nextcloud.js`):

```js
res.setHeader('Content-Type', 'application/octet-stream');
```

### 7. Missing `code` validation on OAuth callback

**Severity:** Low

**The bug:** Each callback destructures `const { code, state, error } = req.query;` and only validates `error`. If `code` is missing (manual hit on the callback URL, or some IdP edge cases where consent is denied without an `error`), the code falls through to `exchangeCodeForTokens(undefined, ...)`, which throws a confusing 400 that ends up in the URL.

**Affected files (Nextcloud is fixed):**

- `server/routes/integrations/office365.js` around line 131 (also the legacy `/callback` handler around line 252)
- `server/routes/integrations/googledrive.js`

**The fix** (already in `nextcloud.js`):

```js
if (!code) {
  logger.error('OAuth callback missing code', { component, providerId });
  return res.redirect('/settings/integrations?<provider>_error=missing_code');
}
```

### 8. Cross-cutting: Multi-provider token scoping limitation

**Severity:** Functional limitation, not a security bug

**The issue:** `TokenStorageService.storeUserTokens(userId, serviceName, tokens)` keys per-user tokens by `(userId, serviceName)`. The `providerId` is stored *inside* the token payload but is never part of the lookup key. Concretely: if a user connects to "Office 365 — Tenant A" then later to "Office 365 — Tenant B", the second connection silently overwrites the first. Same applies to multiple Google Drive accounts or multiple Nextcloud instances.

**Status:** Explicitly out of scope for PR #1416 per maintainer agreement (https://github.com/intrafind/ihub-apps/pull/1416#discussion_r3217799656). Documented in `docs/nextcloud-integration.md` as a "caveat" callout.

**The fix** (substantial — own commit or own follow-up PR):

1. `server/services/TokenStorageService.js`: thread `providerId` through `storeUserTokens`, `getUserTokens`, `areTokensExpired`, `deleteUserTokens`, `getTokenMetadata`. New on-disk path becomes `contents/integrations/<service>/<userId>__<providerId>.json` (use `__` so the `userId` filename can still contain a `.`). Add a fallback read for the legacy path so existing installations don't lose connections — but **only on read**; new writes always use the new path. After one release, add a migration to rename old files.
2. All three services (`Office365Service`, `GoogleDriveService`, `NextcloudService`): update every `tokenStorage.*` call site to pass `tokens.providerId` / `provider.id`. The token payload already carries this — just thread it.
3. All three route files: every `/status`, `/items`, `/download`, `/disconnect`, `/sources`, `/drives` endpoint needs a `providerId` query param (or path param). The picker is already provider-aware on the client; it just doesn't forward the ID today.
4. All three client hooks (or the shared `useCloudStorageBrowser` factory from the other concept): pass `providerId` on every API call.
5. Update `docs/nextcloud-integration.md`, `docs/office365-integration.md`, `docs/google-drive-integration.md` to drop the "single active connection" caveat.

Estimated effort: **2–3 engineering days**, primarily the TokenStorageService changes, the legacy-path read fallback, and end-to-end testing per provider.

## Recommended Sequencing

Two PRs, in order:

### PR A — "Cloud storage provider hardening parity"

Findings 1–7 above. Extract three shared helpers (`oauthReturnUrl.js`, `safeContentDisposition.js`, `boundedBodyReader.js`) under `server/utils/`, then re-use them across Nextcloud, Office 365, and Google Drive. This PR is mechanical, low-risk, and small (~150 net lines after extraction).

### PR B — "Per-provider token scoping"

Finding 8. Larger, requires a migration window, but touches well-defined files. Done after the browser-shell-extraction concept lands so the client-side changes can plug into a single shared hook.

PR A should land first because it's strictly hardening — no behaviour change for users — whereas PR B changes how connections are persisted and benefits from a release period of stable hardening underneath.

## Test Plan

For PR A:

- Add unit tests for the new utility modules:
  - `server/tests/oauthReturnUrl.test.js` — reject `javascript:`, `data:`, `file:`, `gopher:`, `//evil.com/`, allow `/relative`, allow `https://same.host`.
  - `server/tests/safeContentDisposition.test.js` — quote-injection, control characters, Unicode, fallback ASCII.
  - `server/tests/boundedBodyReader.test.js` — under cap, exact cap, over cap, missing Content-Length, abortive close.
- Smoke-test each provider end-to-end:
  - [ ] Office 365: connect → list a SharePoint folder → download a file with a `"` in its name → verify the browser-suggested filename.
  - [ ] Google Drive: same flow against a Shared Drive folder.
  - [ ] Nextcloud: regression-test the existing fix.
  - [ ] Hit each `/download` endpoint with `curl` against a file larger than the cap; verify a stable error.
- CodeQL re-run should not surface any new alerts.

For PR B:

- Unit tests for `TokenStorageService` covering both new- and legacy-path reads.
- A manual migration test: bring up an iHub with an existing token file at the legacy path, restart with the new code, verify the connection still works without user action, then trigger a token refresh and verify the file lands at the new path.
- Per-provider manual test: connect two different tenants/accounts for the same service, verify both connections are addressable, disconnect one and verify the other remains.

## Open Questions

1. **Should the OAuth callback handlers be unified the same way the browser shell will be?** Each callback handler is ~400 lines with very similar shape (validate state → validate session timeout → exchange code → store tokens → redirect). Tempting to factor, but the differences (PKCE vs no-PKCE, code_verifier handling, scope-rotation invalidation in Office 365 only) make a clean shared abstraction tricky. Recommend keeping them per-provider for now.
2. **For PR B, do we want one bucket file per `(userId, providerId)` or roll everything into a single per-user JSON?** Per-file matches the existing pattern; per-user-per-service would be a bigger schema change. Stick with per-file.
3. **Does the Jira callback handler need the same `isValidReturnUrl` fix?** Probably yes — verify and include in PR A or split off.

## Out of Scope (further follow-ups)

- Migration to a streaming XML parser for PROPFIND. Today's regex parser is bounded and verified ReDoS-safe; a streaming parser is only worth it if a user reports a real parse bug.
- Server-side `HEAD` pre-flight before downloads to fail fast on oversized files. Current bounded reader is fine; HEAD adds latency and most provider APIs already return `Content-Length` in the GET response so the cheap check fires anyway.

## Reference Material

- PR #1416 — the Nextcloud feature PR where all eight findings were first identified and fixed for Nextcloud only.
- `server/tests/nextcloud-service.test.js` — pattern for the new utility unit tests.
- The security review of PR #1416 (internal, not committed) — original prioritized findings list.
