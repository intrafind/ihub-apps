# Consent Store

**Date:** 2026-02-25
**Feature:** OAuth Authorization Code Flow — Task 9
**Status:** Completed

---

## Overview

The consent store gives users a "remember my decision" experience when authorising OAuth clients.
After a user clicks "Allow" on the consent screen, their decision is persisted to disk.
On the next authorization request for the **same client + same (or narrower) scope set**, the
consent screen is skipped and an authorization code is issued immediately.

This improves UX while remaining opt-out by default (consent is still shown for new scope combinations
or after the TTL expires).

---

## Files Changed

| File | Role |
|---|---|
| `server/utils/consentStore.js` | New: file-backed consent memory module |
| `server/routes/oauthAuthorize.js` | Modified: reads and writes consent in the authorize flow |

The consent data is stored at `contents/config/oauth-consent.json` (auto-created on first write).
This file should be treated like a session store — it is safe to delete; users will simply be
prompted for consent again.

---

## How It Works

### Storage Format

`contents/config/oauth-consent.json`:

```json
{
  "consents": {
    "my-app:user-123": {
      "clientId": "my-app",
      "userId": "user-123",
      "scopes": ["openid", "email"],
      "grantedAt": "2026-02-25T12:00:00.000Z",
      "expiresAt": "2026-05-26T12:00:00.000Z"
    }
  }
}
```

The key is `<clientId>:<userId>`.  Expired entries are pruned automatically on every write, so
the file never grows unboundedly.

### TTL Configuration

The TTL (time-to-live) for stored consents is controlled by:

```json
// contents/config/platform.json  (oauth section)
{
  "oauth": {
    "consentMemoryDays": 90
  }
}
```

The default is **90 days** when the key is absent.

---

## Decision Logic in the Authorize Endpoint

The GET `/api/oauth/authorize` handler now has three fast-exit paths before it falls through to the
consent screen:

1. **Trusted client** (`client.trusted === true` or `client.consentRequired === false`): code issued immediately, no consent stored.
2. **Remembered consent** (`hasConsent()` returns true): code issued immediately.
3. **Standard flow**: consent screen shown; on POST `/decision` with `decision=allow`, consent is
   stored via `grantConsent()` (fire-and-forget, so a disk failure never blocks the response).

A "deny" decision does **not** clear any existing stored consent — the user must explicitly revoke
via an admin endpoint (to be added in a later task).

---

## Public API of `consentStore.js`

### `hasConsent(clientId, userId, scopes, _ttlDays?)`

Returns `true` if a non-expired consent record exists for the client–user pair and every scope in
`scopes` is covered by the stored grant.

```js
import { hasConsent } from '../utils/consentStore.js';

if (hasConsent('my-app', 'user-123', ['openid', 'email'])) {
  // skip consent screen
}
```

### `grantConsent(clientId, userId, scopes, ttlDays?)`

Writes (or overwrites) a consent record.  Expired records across the entire store are pruned on
each write.

```js
import { grantConsent } from '../utils/consentStore.js';

await grantConsent('my-app', 'user-123', ['openid', 'email'], 90);
```

### `revokeConsent(clientId, userId)`

Deletes the consent record for the given pair, forcing the user to see the consent screen again on
their next request.  Returns `true` if a record existed, `false` otherwise.

```js
import { revokeConsent } from '../utils/consentStore.js';

const wasRevoked = await revokeConsent('my-app', 'user-123');
```

---

## Testing Notes for a Junior Developer

1. **Happy path — first consent**
   - Start a fresh authorization flow for a standard (non-trusted) client.
   - Confirm the consent screen appears.
   - Click "Allow".
   - Check that `contents/config/oauth-consent.json` now contains an entry for the client+user.

2. **Happy path — remembered consent**
   - Immediately repeat the same authorization request.
   - Confirm the consent screen is **not** shown; you should be redirected with a `code` parameter.

3. **Scope expansion**
   - Repeat the authorization request but add a new scope (e.g. `profile`).
   - Confirm the consent screen **is** shown again because the stored grant does not cover `profile`.

4. **Expiry**
   - Manually edit `oauth-consent.json`, set `expiresAt` to a date in the past.
   - Confirm the consent screen is shown on the next request.

5. **Revoke**
   - Call `revokeConsent('clientId', 'userId')` in a test script.
   - Confirm the entry is removed from the JSON file and the consent screen appears on the next request.

6. **Disk failure**
   - Make the `contents/config/` directory read-only (`chmod 555`).
   - Grant consent — confirm the authorization code is still returned (fire-and-forget).
   - A warning log entry `[OAuth Authorize] Failed to store consent:` should appear.
   - Restore directory permissions afterwards.

---

## Dependencies

- `server/utils/atomicWrite.js` — provides `atomicWriteJSON` for crash-safe writes.
- `server/utils/logger.js` — structured logging.
- No new npm packages required.
