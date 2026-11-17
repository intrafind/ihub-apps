# Lockout and last-admin guards (ID-B1, ID-B2, ID-B3, ID-B4)

Implementation notes for the "Now" PR of epic #3739 that makes the admin API refuse changes
which lock the signed-in admin, or every admin, out. Read this before adding another writer of
`platform.json`, `users.json` or `groups.json`.

## Why

The admin rescue (`server/utils/adminRescue.js`, `ensureFirstUserIsAdmin`) makes the next person
who signs in an administrator as soon as no administrator can sign in. A lockout is therefore also
a privilege escalation, and the guard has to live on the server, without an override flag.

## Layout

| File | Role |
| --- | --- |
| `server/utils/authInvariants.js` | Pure rules: `signInRouteOf`, `routeSurvives`, `isUsableAdmin`, `countUsableAdmins`, `effectivePlatformConfig` (env overrides), `dependantsOf`, `groupsResolutionError`. No I/O. |
| `server/utils/adminGuards.js` | Reads the other stored files fresh (never the cache), calls the rules, throws the `ServiceError`. Fails closed with 503 `ADMIN_CHECK_FAILED`. |
| `shared/apiErrors.js` (`ADMIN_GUARD_ERROR_CODES`) | `AUTH_LOCKOUT`, `LAST_ADMIN`, `SELF_LOCKOUT`, `GROUP_IN_USE` (409), `ADMIN_CHECK_FAILED` (503). i18n under `apiErrors.*`. |

Where each guard is called (always inside the `updateJson` / `updatePlatform` mutator, on the body
held under the lock):

- `assertPlatformChangeKeepsAccess(req.user, stored, next)`: `POST /api/admin/configs/platform`,
  `PATCH /api/admin/configs/platform` (both through `applyPlatformChange`), platform rollback
  (`routes/admin/changes.js`). It does nothing unless an auth block (`AUTH_CONFIG_KEYS`) changed.
- `assertUserChangeKeepsAdmin(req.user, before, after, { userId, action })`: user PUT and DELETE.
- `assertGroupChangeKeepsAdmin(before, after)`: group PUT and group rollback.
- `assertGroupsResolvable(body)`: every groups.json writer. `assertGroupNotInherited`: group DELETE.

## Rules in one paragraph

A caller keeps their route when the method (and OIDC/LDAP provider, from `authProvider`, which
`jwtAuth.js` now copies onto `req.user`) stays enabled in the effective config; an unknown route
is refused. "An administrator can sign in" means an active users.json record with an admin group
(resolved, so inheritance counts) and an enabled method, or LDAP/NTLM default groups with admin
access; IdP group mappings are not counted (same as the rescue). Refusals are relative: a change
is refused only when it makes things worse (the caller's route or the admin count was fine before).

## Verified facts

- `auth.mode` gates nothing; only the per-method `enabled` flags do.
- Local tokens die on the next request when local sign-in is off; OIDC/LDAP/NTLM/Teams tokens live
  until expiry, but nobody can sign in again.
- `PROXY_AUTH_ENABLED=true` (env) turns proxy sign-in on regardless of the file.

## Not done here (follow-ups)

- Proxy: changing `userHeader`, `trustedProxies` or removing the caller's `jwtProviders[]` entry is
  not detected (proxy sessions carry no provider name).
- Group DELETE of an admin-granting group that leaves no usable admin is only covered by the
  existing "last adminAccess group" rule, not by the usable-admin count.
- The admin rescue itself is unchanged (brief). Its escalation risk remains for on-disk edits.
- Client preflight on `/admin/auth` ("you're signed in with this") belongs to the AdminAuthPage
  rewrite.
- `configRefreshErrors` is exposed on `GET /api/admin/overview/stats` but not rendered yet.

## Tests

`server/tests/authInvariants.test.js`, `admin-auth-config-lockout.test.js`,
`admin-users-last-admin-guard.test.js`, `admin-groups-delete-inherited.test.js`,
`config-cache-refresh-errors.test.js`; client `tests/unit/client/admin-user-edit-active.test.jsx`,
`admin-groups-delete-refusal.test.jsx`; e2e `tests/e2e/admin-safety-guards.spec.js`
(`npm run test:e2e:admin-safety`, own server on ports 3083/5183, contents `contents-e2e-safety`).
