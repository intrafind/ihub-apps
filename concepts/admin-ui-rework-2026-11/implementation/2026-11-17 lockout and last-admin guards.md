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
| `server/utils/adminInvariantLock.js` | `withAdminInvariantLock(fn)`: one in-process lock around every guarded write (see "Concurrency"). |
| `shared/apiErrors.js` (`ADMIN_GUARD_ERROR_CODES`) | `AUTH_LOCKOUT`, `LAST_ADMIN`, `SELF_LOCKOUT`, `GROUP_IN_USE` (409), `ADMIN_CHECK_FAILED` (503). i18n under `apiErrors.*`. |

Where each guard is called (always inside the `updateJson` / `updatePlatform` mutator, on the body
held under the lock):

- `assertPlatformChangeKeepsAccess(req.user, stored, next)`: `POST /api/admin/configs/platform`,
  `PATCH /api/admin/configs/platform` (both through `applyPlatformChange`), platform rollback
  (`routes/admin/changes.js`). It does nothing unless an auth block (`AUTH_CONFIG_KEYS`) changed.
- `assertUserChangeKeepsAdmin(req.user, before, after, { userId, action })`: user PUT and DELETE.
- `assertGroupChangeKeepsAdmin(before, after)`: group PUT, group DELETE and group rollback.
  DELETE also keeps the older 400 "only group with administrative access" rule, which counts
  flags; the new check counts administrators who can sign in (a custom admin group every admin is
  in can otherwise be deleted while `admins` keeps the flag but has no members).
- `assertGroupsResolvable(body, before)`: every groups.json writer. `assertGroupNotInherited`:
  group DELETE.

Wrap a new guarded writer in `withAdminInvariantLock(() => configStore.updateJson(...))`.
`updatePlatform` already does it for every platform write.

## A stored groups.json that does not resolve

A hand edit can leave a cycle or a missing parent on disk. The cache then keeps the last groups
that resolved (and records `configRefreshErrors`), and that is what the runtime enforces. The
guards evaluate admins against the same thing (`resolveGroupsAsEnforced`): the stored body if it
resolves, otherwise `configCache.getGroups().data`. Consequences:

- A group PUT that removes the looping `inherits` entry resolves after the change, so it is
  checked normally and saved. Creating the missing parent (POST) works the same way.
- Platform auth saves and user edits are evaluated against the groups in force, not refused with
  503 because of an unrelated broken file.
- Other group writes whose result still does not resolve get 400 with a message that the
  *stored* file is broken and must be fixed first, instead of blaming the admin's edit.
- Still 503 `ADMIN_CHECK_FAILED`: the stored body does not resolve and there is no cached copy
  (nothing resolved since start), or a file is present but unreadable. That state genuinely
  cannot be evaluated.

## Rules in one paragraph

A caller keeps their route when the method (and OIDC/LDAP provider, from `authProvider`, which
`jwtAuth.js` now copies onto `req.user`) stays enabled in the effective config; an unknown route
is refused. "An administrator can sign in" means an active users.json record with an admin group
(resolved, so inheritance counts) and an enabled method, or LDAP/NTLM default groups with admin
access; IdP group mappings are not counted (same as the rescue). Refusals are relative: a change
is refused only when it makes things worse (the caller's route or the admin count was fine before).

Details that are easy to get wrong:

- A method is on when its `enabled` is truthy (`isMethodEnabled`), exactly as every sign-in path
  tests it. `=== true` made a `"true"` string (a `${VAR}` placeholder, `IHUB_PLATFORM__…=True`)
  count as off, which made the relative checks fail open. The rescue shares the helper, so it no
  longer fires while such a method still lets its admins sign in.
- The caller's record is found like `tokenUser.findRecord` does (`callerRecordId`): by id, or by
  `<mode>Data.subject` for an OIDC/LDAP/NTLM/Teams token minted before the id became the subject.
  So SELF_LOCKOUT also holds for those legacy tokens.
- The platform and group guards read the users file sign-in reads (`localAuth.usersFile`, via
  `locateConfigFile`), not a hard-coded `config/users.json`. The admin user routes still write
  `config/users.json` only (pre-existing).
- The noAdminSignIn refusal says what is usually missing: an admin group on the new
  administrator's user record (mapping-only admins are not counted).

## Concurrency

Same-file races are serialized by `configStore.updateJson`. Cross-file skew (a platform save and
a user edit, each checked against the other's old file, together leaving no admin) is closed in
by `withAdminInvariantLock`: lock order is always invariant lock, then file lock, and nothing
takes the invariant lock while holding a file lock. It is an in-process queue plus a lease file,
`contents/config/.admin-invariants.lock` (`withFileLock`, the same lease the per-file config locks
use), so the cluster workers of one installation (`WORKERS`, four by default) are serialized too.
The lease is taken once per call chain (reentrant via `AsyncLocalStorage`) and waits up to 30 s,
then fails with `LockTimeoutError` instead of writing unguarded. **Known limitation:** separate
installations (pods) that do not share `contents/` are not coordinated; that would need a lock
the document store backends share (the storage provider's `locks` facet once a distributed
provider exists).

## Verified facts

- `auth.mode` gates nothing; only the per-method `enabled` flags do.
- Local tokens die on the next request when local sign-in is off; OIDC/LDAP/NTLM/Teams tokens live
  until expiry, but nobody can sign in again.
- `PROXY_AUTH_ENABLED=true` (env) turns proxy sign-in on regardless of the file.

## Not done here (follow-ups)

- Proxy: changing `userHeader`, `trustedProxies` or removing the caller's `jwtProviders[]` entry is
  not detected (proxy sessions carry no provider name).
- The admin rescue's behaviour is unchanged (brief), apart from reading `enabled` as the runtime
  does (see above) and counting proxy sign-in switched on by `PROXY_AUTH_ENABLED` (requester
  decision after review, `applySignInEnvFlags`), so guard and rescue see the same admins. Its
  escalation risk remains for on-disk edits.
- Out of scope on purpose:
  - **Backup import** (`POST /api/admin/backup/_import`) replaces platform, users and groups
    wholesale. A restore is deliberate; the archive may come from another installation where the
    caller has no record, so "the caller keeps access" is not evaluable, and refusing would block
    disaster recovery onto a fresh install. Documented in `docs/AUTHENTICATION_QUICK_START.md`.
  - **Migrations** (`server/migrations/V*`) are code, reviewed per release, not admin actions.
- Client preflight on `/admin/auth` ("you're signed in with this") belongs to the AdminAuthPage
  rewrite.
- `configRefreshErrors` is exposed on `GET /api/admin/overview/stats` but not rendered yet.

## Tests

`server/tests/authInvariants.test.js`, `admin-auth-config-lockout.test.js`,
`admin-users-last-admin-guard.test.js`, `admin-groups-delete-inherited.test.js`,
`config-cache-refresh-errors.test.js`; client `tests/unit/client/admin-user-edit-active.test.jsx`,
`admin-groups-delete-refusal.test.jsx`; e2e `tests/e2e/admin-safety-guards.spec.js`
(`npm run test:e2e:admin-safety`, own server on ports 3083/5183, contents `contents-e2e-safety`).
