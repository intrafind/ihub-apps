# Access explanation, access check and "Restrict access" (W3)

Status: implemented on branch `worktree-agent-aa9aa1e3479c4a21f` (not merged).
Source: admin review report, recommendation 5 (AI-PM1, AI-UX1, W3, "Access check").

## What problem this solves

Who may use an app, model or prompt is stored on the **groups** (`permissions.apps`,
`permissions.models`, … in `contents/config/groups.json`), with `*` meaning "all" and
`inherits` passing lists on. The shipped groups hold `*` in `admins`, `users` and
`authenticated`, and `authenticated` inherits `anonymous`. Before this change:

- the only explanation of a wildcard was a hover tooltip on the app's group card;
- models had no access card at all;
- nothing answered "why can't this group/user see this app?";
- restricting one app meant hand-editing `*` in four or more groups.

This change keeps the group-based model. It does **not** add an audience on the item
(that is an open owner decision, see "Open questions").

## What was built

### Server

| File | Role |
| --- | --- |
| `server/utils/contentAccess.js` | `GRANT_LIST_TYPES` (adds `models`, read-only), `collectAncestorPaths`, `describeGrantRoutes`. Every row of `describeContentAccess` now carries `via`: the routes by which the group gets the item (`{ groupId, kind: explicit\|wildcard, path }`). Additive; `/api/admin/content-access` returns it too. |
| `server/utils/accessCheck.js` | Pure logic: `resolveSubject` (group/anonymous/user → groups carried), `checkAccess` (verdict + reasons), `planRestriction` (which wildcard groups, explicit lists, before/after per group), `explicitListWithout`. |
| `server/routes/admin/itemAccess.js` | Four admin-only endpoints (below). Registered in `server/routes/adminRoutes.js`. |

Endpoints (all `adminAuth`, full admins only):

- `GET /api/admin/access/{type}/{id}` — type `apps|models|prompts|skills|workflows`. Every
  group with `via`, `audience`, `wildcardGroups`, `restrictable`.
- `GET /api/admin/access/{type}/{id}/verdict?groupId=…` or `?userId=…` — type `apps|models`.
  Verdict `available|unavailable` and ordered `reasons` (`itemDisabled`, `featureOff`,
  `integrationOff`, `granted` with routes, `notGranted`, `noUsableModel` with a cause per model,
  `preferredModelUnavailable`, `userInactive`, `anonymousAccessOff`).
- `POST /api/admin/access/{type}/{id}/_preview-restrict` — type `apps|models|prompts`. Body
  `{ groupIds?, grantGroupIds? }`. The plan, nothing written.
- `POST /api/admin/access/{type}/{id}/_restrict` — same body. Recomputes the plan under the
  `groups.json` lock, writes, refreshes `configCache`, and writes one change-history snapshot and
  one audit entry per changed group (same services as the group editor and content-access PUT).

Rules reused, not duplicated: the model filter for an app is `filterModelsForApp` from
`server/services/chat/RequestBuilder.js`; required features use `featureRegistry.js`;
integrations use `missingAppIntegrations` from `integrationRegistry.js`.

Subject rules: a group is checked as its members are, i.e. together with the authenticated group;
the anonymous group means "not signed in" (blocked when anonymous access is off); a user is checked
with `internalGroups` from `users.json` plus the authenticated group. Groups an identity provider
sends at sign-in are not known; the verdict carries `notes: ['identityProviderGroupsUnknown']`.

### Client

All under `client/src/features/admin/components/access/`:

- `accessExplanation.js` — pure wording helper (message keys + values). Shared by everything below.
- `WildcardExplanation.jsx` — visible list "Everyone in Users sees this through “all apps”
  (inherited from Authenticated: Users → Authenticated)". Inserted into `ContentAccessSection`
  with one line (so apps, prompts, skills and workflows get it).
- `ItemAccessCard.jsx` — "Who can use this model" on `AdminModelEditPage`.
- `AccessTools.jsx` + `ItemAccessTools.jsx` — "Restrict access…" button (only while a wildcard
  covers the item) and the access check; on `AdminAppEditPage` below the group card (full admins).
- `AccessCheckPanel.jsx` — "Why can't someone see this?" (group select or user text field).
- `RestrictAccessDialog.jsx` — W3: wildcard groups (each convert/keep), optional grant-by-name,
  live preview, warning that new items are no longer visible by default, apply.
- `useItemAccess.js` — loads the access view.
- API functions in `client/src/api/adminApi.js`: `fetchItemAccess`, `fetchAccessVerdict`,
  `previewAccessRestriction`, `restrictItemAccess`.

i18n: new keys only, under `admin.access.*` in `shared/i18n/en.json` and `de.json`.

## Tests

- `server/tests/admin-item-access.test.js` — routes: admin-only (403 for content admin), view with
  chains, verdicts (disabled, feature off, no model, iframe, user, inactive, IdP note, anonymous off,
  400/404), preview, restrict rewrites (all groups, kept wildcard keeps item visible below it,
  explicit extras kept, models, no-op writes nothing), history/audit entries.
- `server/tests/access-check.test.js` — pure helpers (diamond inheritance, cycles, case-insensitive).
- `server/tests/content-access-audience.test.js` — shape test updated for the new `via` field.
- `tests/unit/client/admin-access-explanation.test.jsx`, `tests/unit/client/admin-item-access-card.test.jsx`.

## Known limits / next steps

- Restrict converts **wildcards only**. An explicit grant (shipped: `anonymous` lists `chat` and
  two models, and `authenticated` inherits `anonymous`) keeps the item visible to everyone; the
  preview says so ("Everyone who signs in can still use it:" with the route). Removing explicit
  grants stays in the group editor / content-access card.
- The verdict does not cover OAuth client allow-lists, usage limits, or a model's missing API key.
- After a conversion, new items must be added to those groups by hand. That is the cost the owner
  decision on item-level audience would remove.

## Open questions for the owner

1. Item-level audience ("Everyone signed in" / "Only these groups") — compat vs clean break.
2. Should `anonymous` keep explicit grants that every signed-in user inherits? It makes "only HR"
   impossible for `chat` and the two default models without editing `anonymous` too.
