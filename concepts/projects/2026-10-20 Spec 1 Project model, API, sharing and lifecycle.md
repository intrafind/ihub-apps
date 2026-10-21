# Spec 1: Project model, API, sharing, lifecycle, item kind registry and the sources migration

Resolves [#2903](https://github.com/intrafind/ihub-apps/issues/2903) · Part of
[#1036](https://github.com/intrafind/ihub-apps/issues/1036) · Phase 1 (iHub tier only) ·
2026-10-20

A **project** is one container with documents, instructions and chats. It comes in two
ownerships behind one model: **user projects** (created and shared by users, stored as runtime
data) and **admin projects** (created in the admin UI, linked to apps, workflows and agents,
stored as configuration, the successor of `sources.json`). Phase 1 implements the iHub tier:
extracted text per item, encrypted per object, BM25 search and load-all, no originals kept.

## 1. Decisions carried in from the epic

Taken on 2026-10-20 and not reopened here: the name *Project*; two stores, one per tier; the
tier policy with three values of which phase 1 implements `ihub`; limits 25 files, 20 MB per
file, 200 MB per project, 20 projects per user, 50 files hard ceiling, all admin-configurable;
text-only storage in the iHub tier; load-all, iterate, search, read and write as the access
modes; sources fold into projects as a clean break with no aliases; the open item kind registry
with a picker per kind; picked documents snapshotted as text at pick time.

Resolved here:

| Open item in the epic | Decision |
| --- | --- |
| One container or two (#2315) | **One.** A project without items is the folder. #2315 shrinks to "move a chat into a project" (this spec, §6.4) plus chat search. No separate chat folders. |
| Confirmation of decision 17 (credentials for picked items) | **Confirmed as proposed.** iHub tier: snapshot at pick time with the picking user's token; `snapshotAt` shown; refresh by any editor who has a connected token for that integration. iFinder items stay references and are fetched with the reading user's rights. |
| Default key provider | Local master key file (`contents/.encryption-key`) wrapping per-object data keys. Spec 3 §6. |
| Admin policy (who may create and share) | Two booleans in `groups.json`: `projects` (create user projects) and `projectSharing` (share them). §7.2. |
| Where the shared crypto spec lives | Out of phase 1; the Node.js format implementation and its vectors live in `server/services/projects/crypto/` and move to the shared repository when #2906 opens it. |

## 2. The entity

One JSON document per project. The same shape serves both ownerships; the fields that differ are
marked.

```js
{
  version: 1,
  id: 'prj_8Zt1aq...'        // user projects: 'prj_' + 22 url-safe chars (minted);
                              // admin projects: an admin-chosen zSafeId (max 50), e.g. 'faq'
  ownership: 'user' | 'admin',
  tier: 'ihub',               // 'ifinder' reserved for phase 2; a project never changes tier
  name: 'Case 2026-114',      // user projects: string (max 200)
                              // admin projects: localized record { en, de } (as apps do)
  description: '',            // same rule as name; optional
  instructions: '',           // plain text, max 20 000 chars, injected into the system prompt
                              // of chats that run inside this project (§6.3)
  enabled: true,              // admin projects only; a disabled admin project is skipped by
                              // apps that link it, exactly as a disabled source was
  category: '', tags: [],     // admin projects only (carried over from sources)
  owner: { id: 'u_17', name: 'Dana Weber' },     // user projects; null on admin projects
  members: [                  // user projects only; the owner is never listed here
    { type: 'user',  id: 'u_42',  role: 'editor' },
    { type: 'group', id: 'legal', role: 'user' },
    { type: 'everyone',          role: 'user' }
  ],
  items: [ /* ProjectItem, §3; at most limits.maxFiles */ ],
  usage: { items: 7, bytes: 18_300_112 },         // denormalised, recomputed on every write
  createdAt, updatedAt,                            // ISO
  createdBy: { id, name },                         // actor; migration writes { id: 'migration' }
  lastActivityAt: '2026-10-20T10:00:00Z'           // last item change or chat turn; retention reads it
}
```

Roles on user projects (the three roles of the epic):

| Capability | Owner | Editor | User |
| --- | --- | --- | --- |
| See the project, its items, instructions and members; chat inside it; use it in the chat-input picker; search and read through the tools | ✓ | ✓ | ✓ |
| Read any chat inside the project (read-only for chats of others) and start own chats in it | ✓ | ✓ | ✓ |
| Remove own chats from the project | ✓ | ✓ | ✓ |
| Add, refresh, pin, rename and remove items; edit name, description and instructions; let a workflow write into it | ✓ | ✓ | — |
| Change members | ✓ | ✓ | — |
| Delete the project, transfer ownership | ✓ | — | — |

`owner` is one user. A group can be editor or user, never owner. `everyone` means every signed-in
user (the `anonymous` group is unshareable, as for prompts). The strongest matching role wins,
inheritance resolved (`effectiveGroups`). Admin projects have no members: whoever may use an
app, workflow or agent that links the project may use the project through it (§7.1).

## 3. The item model

```js
{
  id: 'itm_k3Fq...',           // 'itm_' + 22 url-safe chars
  kind: 'upload',              // registry id, §4
  name: 'Mietvertrag.pdf',     // display label; two items may share a name, the id is the identity
  ref: { /* kind-specific reference, validated by the kind's refSchema, §4 */ },
  storage: 'text' | 'link',    // text: iHub holds the extracted text (encrypted blob)
                               // link: fetched at use time with a TTL cache (url, page, iFinder)
  pinned: false,               // always in context, even when the project is searched (spec 2 §6)
  status: 'pending' | 'extracting' | 'ready' | 'failed' | 'stale',
  error: { code: 'NO_TEXT', message: 'The PDF has no text layer' } | null,
  text: {                      // storage === 'text' only
    blobKey: 'prj_8Zt1aq__itm_k3Fq__01JB4R2...',   // project-files blob, version id inside (spec 3 §5) gitleaks:allow
    bytes: 182_204,            // ciphertext bytes stored
    chars: 171_880, tokens: 41_200,                 // of the extracted text
    sha256: '…',               // of the plaintext
    format: 'tink-aes-gcm-hkdf-v1', segmentBytes: 1_048_576,
    key: { provider: 'local-file', keyId: 'c81e728d', wrapped: '<base64>' },   // spec 3 §6
    extractedAt: '2026-10-20T10:00:00Z',
    original: { contentType: 'application/pdf', bytes: 2_104_221, pages: 14 }  // metadata only; bytes gone
  },
  cache: { ttlSeconds: 7200 }, // storage === 'link' only
  provenance: {
    origin: 'uploaded' | 'picked' | 'linked' | 'written' | 'migrated',
    by: { id: 'u_17', name: 'Dana Weber' },
    at: '2026-10-20T10:00:00Z',
    run: { type: 'chat' | 'workflow' | 'agent', id: 'run_…', nodeId: 'summarise' } | null,
    source: { site: 'SharePoint', url: 'https://…', lastModified: '…' } | null   // what the picker saw
  },
  snapshotAt: '2026-10-20T10:00:00Z' | null,   // picked items: when the text was taken; === text.extractedAt
  managedFile: 'sources/ihub-documentation.md' | undefined,   // admin projects only, §8.4
  createdAt, updatedAt
}
```

Status semantics: `pending` the item exists but the content has not arrived (upload received,
pick queued); `extracting` a worker is extracting and encrypting; `ready` usable; `failed`
permanent, with `error.code` from spec 3 §9, retry by re-adding; `stale` the snapshot is older
than the source (a refresh saw a newer `lastModified`, or a refresh failed with `SOURCE_GONE` or
`SOURCE_FORBIDDEN`), the old text stays usable and the UI offers refresh. Link items are `ready`
as soon as the reference validates; a fetch failure at use time is reported in the tool result
and on the item (`stale` + `error`), never as a failed chat turn.

`provenance.origin` is what the citation panel shows as the "uploaded" or "picked" marker (spec 2
§5): `uploaded` and `written` render as *uploaded*, `picked` as *picked from <site>*, `linked`
and `migrated` as *linked*.

## 4. The item kind registry

`server/services/projects/kinds/registry.js` holds one `ItemKind` per id. Integrations register
at startup; the client reads the enabled kinds with their picker descriptors from
`GET /api/projects/_config`.

```js
registerItemKind({
  id: 'office365',
  name: { en: 'OneDrive / SharePoint', de: 'OneDrive / SharePoint' },
  icon: 'cloud',
  storage: { ihub: 'text' },          // storage rule per tier; 'ifinder' added in phase 2
  credentials: 'picking-user',        // 'none' | 'picking-user' (snapshot, refresh needs a token)
                                      // | 'reading-user' (fetched with the reader's rights every time)
  picker: { type: 'cloud', providerType: 'office365' },   // what the client renders, §4.1
  refSchema: z.object({ providerId, driveId, fileId, name, webUrl?, mimeType?, size?, lastModified? }).strict(),
  enabled: ({ platform, features }) => cloudStorageEnabled(platform, 'office365'),
  describe: (ref, lang) => ({ name, url, site }),          // display without a fetch
  fetch: async (item, ctx) => ({ bytes | text, contentType, name, lastModified, url }),
  // ctx = { user, chatId, language, purpose: 'pick' | 'refresh' | 'use' }
  test: async (ref, ctx) => ({ accessible, …}) | undefined   // admin "test" button
});
```

| Kind | Storage | Credentials | Picker | `ref` | Phase 1 |
| --- | --- | --- | --- | --- | --- |
| `upload` | text | none | `upload` (file dialog, drag and drop) | `{ contentType }` | ✓ |
| `url` | link | none | `url` (paste) | `{ url, maxContentLength? }` | ✓ (today's `URLHandler`) |
| `page` | link | none | `page` (list of `contents/pages`) | `{ pageId, language }` | ✓ (today's `PageHandler`) |
| `ifinder-document` | link | reading-user | `ifinder` (search in a search profile, or paste an id) | `{ documentId, searchProfile?, maxLength? }` | ✓ (today's `IFinderHandler`, single document) |
| `ifinder-query` | link | reading-user | `ifinder` (search profile plus query) | `{ query, searchProfile?, maxResults?, maxLength? }` | ✓ (today's `IFinderHandler`, query mode; an empty `query` means the model supplies it) |
| `office365` | text | picking-user | `cloud` (existing `Office365FileBrowser`) | `{ providerId, driveId, fileId, name, webUrl, … }` | ✓ |
| `google-drive` | text | picking-user | `cloud` (existing `GoogleDriveFileBrowser`) | `{ providerId, fileId, name, webUrl, … }` | ✓ |
| `nextcloud` | text | picking-user | `cloud` (existing `NextcloudFileBrowser`) | `{ providerId, filePath, name, … }` | ✓ |
| `jira`, `confluence`, `mcp-resource` | text | picking-user | the integration's own search | — | later, through the same registry |

The three cloud kinds fetch server-side through the services that already exist
(`Office365Service.downloadFile(userId, fileId, driveId, providerId)` and the Google Drive and
Nextcloud equivalents, all returning `{ name, mimeType, size, content: Buffer }`), not through
the browser. The pick returns a reference; the server fetches, extracts and encrypts (spec 3 §4).
Today's cloud pickers extract in the browser; the project add-items dialog reuses the browser
components with an `onPick(refs)` callback instead of `onFilesProcessed`.

`ifinder-document`, `ifinder-query`, `url` and `page` wrap today's handlers. The handlers keep
their TTL caches; the kind's `fetch` calls `handler.getCachedContent(ref + ctx)`. The iFinder
cache stays per user (its key already includes the user).

### 4.1 Picker descriptors

The client has one picker component per `picker.type`: `upload`, `url`, `page`, `ifinder`,
`cloud`. A kind only names the type and its parameters, so a later kind with the same gesture
needs no client change. The add-items dialog shows one tab per enabled kind (spec 7 owns the
layout). Pickers call the user-facing helper endpoints in §5.1 (`/api/projects/pickers/…`); the
admin project editor uses the same dialog and the same endpoints.

## 5. REST surface

All routes under `buildServerPath`. Errors are `{ error, code }`; codes in §5.4. Every user route
runs `requireFeature('projects')` then `authenticatedOnly` (an anonymous caller never sees a
project, like prompts) then `projectAccessRequired(level)` (§7.1).

### 5.1 User API

| Method and path | Level | Body / query | Response |
| --- | --- | --- | --- |
| `GET /api/projects/_config` | — | — | `{ enabled, userProjects: { enabled, canCreate, canShare, maxProjects, used }, limits, tierPolicy, sharing: { allowUsers, allowGroups, allowEveryone }, kinds: [{ id, name, icon, picker, storage, credentials }] }` |
| `GET /api/projects` | — | `?scope=mine\|shared\|all` (default all), cursor, limit | `{ items: [ProjectSummary], nextCursor }` — owned plus shared with me, plus admin projects linked to apps the caller may use (`ownership: 'admin'`, read-only, for the picker); summary = project without `items`, with `usage`, `role` and `permissions` |
| `POST /api/projects` | create (§7.2) | `{ name, description?, instructions? }` | `201 Project` |
| `GET /api/projects/:projectId` | use | — | `Project` with `permissions { canView, canEdit, canShare, canDelete, canTransfer, role }` |
| `PATCH /api/projects/:projectId` | edit | `{ name?, description?, instructions? }` | `Project` |
| `DELETE /api/projects/:projectId` | own | — | `204`; cascade §9.1 |
| `GET /api/projects/:projectId/items` | use | — | `{ items: [ProjectItem] }` (the `text.key` block is never returned) |
| `POST /api/projects/:projectId/items` | edit | multipart `file` (kind `upload`) **or** JSON `{ kind, ref, name?, pinned? }` (every other kind) | `202 { item }` with status `pending`/`extracting` for text kinds, `201 { item }` ready for link kinds. Quotas checked first (§5.4) |
| `GET /api/projects/:projectId/items/:itemId` | use | — | `ProjectItem` (poll while extracting) |
| `PATCH /api/projects/:projectId/items/:itemId` | edit | `{ name?, pinned? }` | `ProjectItem` |
| `POST /api/projects/:projectId/items/:itemId/refresh` | edit | — | `202 { item }`; re-fetches with the caller's credentials; `SOURCE_FORBIDDEN` when the caller has no token for the kind |
| `DELETE /api/projects/:projectId/items/:itemId` | edit | — | `204` |
| `GET /api/projects/:projectId/items/:itemId/text` | use | `?maxChars=` | `text/plain` of the stored or fetched text (preview and download); audited as `read` |
| `GET /api/projects/:projectId/search` | use | `?q=&limit=` | `{ hits: [KnowledgePassage] }` (spec 2 §2) — the project page's search box |
| `PUT /api/projects/:projectId/members` | share | `{ members: [{ type, id?, role }] }` (complete list, ≤ 100) | `Project`; targets validated as `resolveShares` does for prompts |
| `GET /api/projects/share-targets` | — | `?q=` | `{ allowed: { user, group, everyone }, users, groups }` (same shape as prompts) |
| `POST /api/projects/:projectId/transfer` | own | `{ ownerId }` | `Project` |
| `GET /api/projects/:projectId/chats` | use | `?filter=all\|mine\|others`, cursor | `{ items: [ChatSummary + owner] }` |
| `PATCH /api/chats/:chatId` (existing route, new field) | chat owner, `use` on the target | `{ projectId: string \| null }` | moves the chat into or out of a project |

Picker helpers, under `/api/projects/pickers/`, `authenticatedOnly`, no project needed:

| Method and path | Purpose |
| --- | --- |
| `POST /api/projects/pickers/ifinder/search` `{ query, searchProfile?, maxResults? }` | iFinder search with the caller's JWT; replaces `POST /api/admin/sources/_ifinder/search` |
| `POST /api/projects/pickers/ifinder/metadata` `{ documentId, searchProfile? }` | replaces `POST /api/admin/sources/_ifinder/metadata` |
| `GET /api/projects/pickers/pages` | pages of `contents/pages` with their languages |
| `POST /api/projects/pickers/url/check` `{ url }` | HEAD-style check (status, content type, size) before adding |
| cloud kinds | the existing `/api/integrations/{office365,googledrive,nextcloud}/*` listing routes, unchanged |

### 5.2 Chat request

The chat request body (`POST /api/apps/:appId/chat/:chatId`) gains two optional fields:

- `projectId` — the container the chat runs in. Accepted on the first turn; the chat document
  records it (§6.4). A later turn with a different `projectId` is rejected (`PROJECT_MISMATCH`);
  moving a chat is `PATCH /api/chats/:chatId`.
- `projects: [id]` — projects attached from the chat-input picker for this chat. The union over
  turns is persisted on the chat as `attachedProjectIds`. Each id must pass `use`.

Both are ignored (with a warning in the run log) when the `projects` feature is off, when the
user is anonymous, or when the app sets `features.userProjects: false` (§6.1).

### 5.3 Admin API

`/api/admin/projects` replaces `/api/admin/sources`. Gate: `requireFeature('projects')`, then
`contentAdminAuth` (admin projects) or `adminAuth` (the compliance listing of user projects).

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /api/admin/projects` | `?ownership=admin` (default) `\| user`, cursor, limit | `[Project]` for admin projects (disabled included, `ETag`); `{ items, nextCursor }` of summaries with owner for user projects — `adminAuth` only, for compliance |
| `GET /api/admin/projects/_stats` | — | `{ admin: { total, enabled, disabled, byKind }, user: { total, items, bytes, owners } }` |
| `GET /api/admin/projects/_tokens` | — | `{ loadAllBudgetTokens, toolResultBudgetTokens, projects: { [id]: { tokens, items, bytes } } }` — the sizes the app editor shows beside a linked project (replaces `_tokens` on sources) |
| `GET /api/admin/projects/_kinds` | — | the registry with `enabled` per kind and the default `ref` per kind (replaces `_types`) |
| `GET /api/admin/projects/_dependencies/:id` | — | `{ projectId, dependencies: [{ type: 'app' \| 'workflow' \| 'agent', id, name }] }` — scans apps, workflows (top level and nodes) **and** agent profiles, which the sources check did not |
| `POST /api/admin/projects` | `Project` (admin shape) | `201 { project }`; duplicate id → `400 PROJECT_EXISTS`; also refuses an id that collides with a user project id prefix `prj_` |
| `GET /api/admin/projects/:id` | — | `Project` (admin or, for `adminAuth`, any user project) |
| `PUT /api/admin/projects/:id` | `Project` | `{ project }` |
| `DELETE /api/admin/projects/:id` | — | `204`; `400 PROJECT_IN_USE` with `dependencies` when something links it; `adminAuth` may delete a user project (compliance; audited) |
| `POST /api/admin/projects/_toggle` | `{ ids, enabled }` | `{ message }`; audited this time |
| `POST /api/admin/projects/:id/items` and the item routes of §5.1 | same shapes | admin projects: same pipeline; the actor is the admin |
| `POST /api/admin/projects/:id/test` | — | `{ success, items: [{ id, kind, accessible, duration, tokens?, error? }] }` — runs every kind's `test` or a fetch; replaces `/:id/test` on sources |
| `GET /api/admin/projects/:id/items/:itemId/text` | `?limit=` | `{ preview, metadata }` — replaces `/preview` |

Removed with no replacement: the four `/api/admin/sources/:id/files*` routes (free file editing
under `contents/sources/`). Admin projects hold text as items; the editor uploads a file or
pastes text (an `upload` item created from `{ text, name }` JSON, see spec 3 §3.3).

### 5.4 Error codes

Shared between the routes, the provider contract and the client:

`FEATURE_DISABLED`, `USER_PROJECTS_DISABLED`, `PROJECTS_NOT_ALLOWED` (principal may not hold
projects), `PERMISSION_DENIED` (groups flag), `PROJECT_NOT_FOUND` (also answers "no access", as
`loadUserPrompt` does), `PROJECT_ACCESS_CHANGED` (409-style re-check under the lock failed),
`PROJECT_EXISTS`, `PROJECT_IN_USE`, `PROJECT_MISMATCH`, `QUOTA_PROJECTS`, `QUOTA_FILES`,
`QUOTA_FILE_BYTES`, `QUOTA_PROJECT_BYTES`, `KIND_DISABLED`, `KIND_UNKNOWN`, `INVALID_REF`,
`UNSUPPORTED_TYPE`, `EXTRACTION_FAILED`, `NO_TEXT`, `SCAN_REJECTED`, `SOURCE_FORBIDDEN`,
`SOURCE_GONE`, `SHARE_TARGET_INVALID`, `STORAGE_UNAVAILABLE`.

## 6. Where a project attaches

Three gestures, each with its own place in the config.

### 6.1 Apps (admin pinning) — `appConfigSchema.js`

```js
projects: z.array(z.union([
  zSafeId,                                        // shorthand: { id, mode: 'auto' }
  z.object({
    id: zSafeId,
    mode: z.enum(['auto', 'context', 'tools']).prefault('auto'),
    write: z.boolean().prefault(false)            // may a workflow/agent run of this app write back
  }).strict()
])).optional()
```

`mode` decides how the project reaches the model (spec 2 §6): `context` always injects every
ready item (the old `exposeAs: prompt`); `tools` never injects, the model searches, lists and
reads (the old `exposeAs: tool`); `auto` injects when the project's text fits the load-all
budget and offers the tools when it does not. Pinned items are injected in every mode.

`features.userProjects: boolean` (default `true`) on an app says whether the chat-input picker
and container-first chats are offered in this app. An app that runs on a fixed knowledge set
(the support bot) can turn it off.

### 6.2 Workflows and agent profiles

- Workflow top level: `projects` with the same shape as apps (replaces `sources`); prompt,
  planner and verifier nodes: `config.projects`, node wins over workflow, as `sources` did.
- New node types for iteration and write-back are spec 2 §8 (`project-items`, `project-write`).
- Workflow inputs: an input of `type: 'project'` lets the run dialog pick a project the running
  user may use; the engine exposes it as `$.input.<name>` = project id and adds it to the scope.
- Agent profile: `projects` (replaces `sources`), copied into the generated prompt nodes by
  `profileWorkflowSerializer.basePromptConfig` where `sources` is copied today.

### 6.3 Container first

Opening a project and starting a chat sends `projectId` on the first turn. The chat inherits:
the project's instructions (appended to the app's system prompt inside
`<project-instructions>…</project-instructions>` after the app's own prompt and before the
knowledge block, so the app prompt keeps precedence), and the project's items in mode `auto`.
Instructions of admin projects linked to the app apply the same way. Projects attached from the
chat-input picker contribute knowledge only, never instructions.

### 6.4 Chat document

`chats/<chatId>` gains `projectId: string|null` and `attachedProjectIds: string[]`. A new
runtime namespace `project-chats` holds one marker `<projectId>__<chatId>` with `ownerId =
projectId` per chat in a container, so `GET /api/projects/:id/chats` is an owner-index read, as
the share markers are for prompts. The chat's own `projectId` is the authority; a marker whose
chat disagrees is pruned. `chatAccess` grants **read** on a chat to every member of its project
(the project page lists members' chats; a member opens another's chat read-only). Deleting a
project clears `projectId` on its chats and removes the markers; the chats survive.

## 7. Authorization

### 7.1 `projectAccessRequired(level)`

`server/middleware/projectAccess.js`, modelled on `userPromptPermissions`. Levels: `use`,
`edit`, `share`, `own`. It loads the project (`req.project`), computes `req.projectPermissions`
and answers **404** when the caller may not even view it.

```
admin project:
  use   → contentAdmin, or the project is linked by an app, workflow or agent the caller may
          use (canUserAccessResource on apps, allowedGroups on workflows, groups on agents),
          or the project id is in the request's `projects`/`projectId` and the same rule holds
  edit, share, own → contentAdmin (interactive, admin-eligible principal)
user project:
  owner → everything
  editor (direct, via group with inheritance, or everyone) → use, edit, share
  user   → use
  full admin (adminAccess, interactive) → use and own for compliance; never edit
  owner deactivated or deleted → read-only for members until an admin transfers it
anonymous, OAuth clients, agents, delegated tokens (oauth_authorization_code) → nothing
(a personal API key acts as its owner)
```

Every mutation re-runs the same check under the repository lock (`authorize` callback), as
`UserPromptRepository.assertAuthorized` does; a failed re-check is `PROJECT_ACCESS_CHANGED`.

### 7.2 Groups permissions

`groups.json` gets two booleans, following the `scheduledTasks` precedent (schema, inheritance,
`loadGroupPermissions`, `getPermissionsForUser`, the OAuth and delegated branches, the admin
group editor, i18n):

| Permission | Meaning | Default (admins, users, authenticated / anonymous) |
| --- | --- | --- |
| `projects` | may create user projects | true / false |
| `projectSharing` | may add members to own projects | true / false |

### 7.3 Feature flags and platform settings

Two registry entries in `server/featureRegistry.js`:

- `projects` (category `ai`, default `true`) — replaces `sources`; gates the admin pages, the
  admin API, and the picker endpoints. The migration carries the value an installation set for
  `sources` over to `projects`. Admin projects linked to apps keep working at runtime whatever the
  flag says, as sources did (the flag hides the pages, it does not unload the knowledge).
- `userProjects` (category `preview`, `preview: true`, default `false`) — user-created projects,
  the project pages, the chat-input picker, container-first chats. This is the phase 1 feature
  flag of the epic.

`platform.json`:

```json
"projects": {
  "tierPolicy": "ihub",
  "limits": {
    "maxFiles": 25,
    "maxFileBytes": 20971520,
    "maxProjectBytes": 209715200,
    "maxProjectsPerUser": 20
  },
  "sharing": { "allowUsers": true, "allowGroups": true, "allowEveryone": false },
  "retentionDays": 0,
  "loadAllMaxTokens": 50000,
  "kinds": {},
  "encryption": { "keyProvider": "local-file" }
}
```

`maxFiles` is schema-bounded to 50 (the hard ceiling). `tierPolicy` accepts `ihub`, `both`,
`ifinder`; phase 1 validates the value and the admin UI shows it, but any value other than
`ihub` is reported as "not available in this version" and behaves as `ihub`. `kinds` is a sparse
map `{ [kindId]: false }` to switch a kind off; a kind whose integration is not configured is off
regardless. `retentionDays` 0 keeps user projects until deleted. `GET /api/configs/platform`
sends a resolved `projects` block (the pattern of `userPrompts`), folding in storage
availability.

## 8. Storage

### 8.1 Namespaces

| Namespace | Facet | Key | Owner id | Holds |
| --- | --- | --- | --- | --- |
| `projects` | documents, **raw** (`contents/projects/<id>.json`) | admin project id | — | admin projects: configuration, seeded from `server/defaults/projects/`, written by migrations and the admin API |
| `user-projects` | documents | `prj_…` | the owner's user id | user projects |
| `user-project-shares` | documents | `<projectId>.<sha24(targetKey)>` | `user:<id>`, `group:<name>`, `everyone` | share markers, an index never the authority (prompt pattern) |
| `project-chats` | documents | `<projectId>__<chatId>` | project id | which chats live in a project (§6.4) |
| `project-files` | blobs | `<projectId>__<itemId>__<versionId>` | — | encrypted extracted text, both ownerships; a re-upload or refresh mints a new version id and deletes the old blob after the metadata write succeeded |

Admin projects are configuration for the same reason sources were: hand-edited, git-tracked,
backed up with `contents/`, seeded from defaults and rewritten by versioned migrations. Their item
*text* is not configuration and lives in `project-files` like every other item's.

Locks: `project:<id>` for every read-modify-write, `project-import` for the startup import of
pending admin items (§8.4). Repository: `server/services/projects/ProjectRepository.js` (both
ownerships behind one class, routing on `ownership`), `ProjectService.js` (quotas, kinds,
pipeline calls), `projectAccess.js` (§7.1).

### 8.2 What the iFinder-backed variant stores locally (phase 2)

A project with `tier: 'ifinder'` keeps the same document minus items: `ifinder: { collectionId,
searchProfile }`. Items, text and search live in iFinder; iHub lists the collection through the
iFinder provider (spec 2 §9). Nothing in phase 1 writes `tier: 'ifinder'`; the field exists so
phase 2 is additive.

### 8.3 Multi-instance

The filesystem `BlobStore` needs a shared volume for `project-files` until the S3 adapter of
#2906 exists (documented in `docs/projects.md` with the `TOKEN_ENCRYPTION_KEY` requirement). The
extraction job of an upload runs on the worker that received the file (spec 3 §2).

### 8.4 Default and managed admin projects

`server/defaults/projects/` ships the admin projects that `server/defaults/config/sources.json`
shipped as sources (§10.2). An `upload` item in a default project carries `import: { file:
'sources/faq.md' }` pointing into `server/defaults/`; on startup `ProjectService.importPending()`
extracts, encrypts and stores every admin item that is `pending` with an `import` pointer and
clears the pointer. `ihub-documentation` keeps `managedFile: 'sources/ihub-documentation.md'`
and is re-imported whenever the sha256 of the managed default changes (this replaces the
`MANAGED_DEFAULT_FILES` copy of that file into `contents/sources/`). The import runs once per
boot under the `project-import` lock, after storage and the encryption key are up.

## 9. Lifecycle

### 9.1 Delete cascade

`DELETE` on a project, in this order, each step best-effort after the document is gone (the
`deleteChatWithCascade` pattern): the project document; every `project-files` blob with the
project's prefix (the wrapped keys go with the item metadata, so the ciphertext is unreadable
from the first step on); share markers; `project-chats` markers, with `projectId` and the
project's id in `attachedProjectIds` cleared on each chat; the per-process BM25 index and link
caches for the project. Admin projects additionally refuse deletion while linked (§5.3).

### 9.2 User deletion

A `userProjects` step in `server/services/userDeletion.js` (kind `content`): delete every project
the user owns with the cascade above, remove the `user:<id>` member from every project that
shares with them, and drop their `project-chats` markers (the chats step already removes the
chats). Deactivation leaves the projects read-only (§7.1).

### 9.3 Retention

`projects.retentionDays > 0` makes the daily sweep (beside `chatRetention`) delete user
projects whose `lastActivityAt` is older than the limit, with the cascade. Admin projects have
no retention. The sweep audits each deletion with actor `system`.

### 9.4 Quotas

Checked in `ProjectService` before any write, counted against the project document (no scan):
projects per user (owned user projects, `QUOTA_PROJECTS`), items per project (every item,
whatever its kind, `QUOTA_FILES`), bytes per file (`original.bytes` of an upload or pick,
`QUOTA_FILE_BYTES`, also enforced by the multipart limit), bytes per project (sum of
`original.bytes` over text items, `QUOTA_PROJECT_BYTES`). Admin projects are exempt from the
per-user count only.

## 10. The sources migration and the breaking change

### 10.1 Migration `V172__sources_to_projects.js`

Precondition: `config/sources.json` exists or any app, workflow or agent profile carries
`sources`. Steps, in order:

1. **Sources become admin projects.** For every entry of `config/sources.json`, write
   `projects/<id>.json`:

   | Source | Project |
   | --- | --- |
   | `id`, `name`, `description`, `enabled`, `category`, `tags`, `created`, `updated` | same fields (`createdAt`/`updatedAt`) |
   | `type: filesystem`, `config.path` | one `upload` item, `status: pending`, `import: { file: <path>, encoding }` resolved against `contents/` (not `server/defaults/`), `provenance.origin: migrated`; `ihub-documentation` gets `managedFile` instead |
   | `type: url`, `config.url`, `caching.ttl` | one `url` item, `storage: link`, `ref: { url, maxContentLength }`, `cache.ttlSeconds` |
   | `type: ifinder` with `documentId` | one `ifinder-document` item |
   | `type: ifinder` with `query` or neither | one `ifinder-query` item (`query` may be empty) |
   | `type: page` | one `page` item |
   | `exposeAs` | not stored on the project; it becomes the link `mode` (step 2) |

   The item id is `itm_` + a digest of the source id, so the migration is deterministic.
2. **Links are renamed and keep their behaviour.** For every app, workflow (top level and every
   node `config.sources`) and agent profile: `sources: ['faq', 'docs']` becomes
   `projects: [{ id: 'faq', mode: 'context' }, { id: 'docs', mode: 'tools' }]` where `mode` is
   `context` for a source with `exposeAs: prompt` and `tools` for `exposeAs: tool`; an id with no
   source becomes `{ id, mode: 'auto' }` with a warning. `sources` is removed. Legacy
   `sourceSupplements` entries are dropped with a warning.
3. **Placeholders.** `{{sources}}` and `{{source}}` in app `system.*`, workflow node
   `config.system` / `config.prompt` / `config.instructions`, and agent profile `system` become
   `{{projects}}`.
4. **Tool lists.** `source_<id>` entries in any `tools` array (apps, workflow nodes, agent
   profiles) are removed; the knowledge tools are added automatically at runtime (spec 2 §4).
   `tools/knowledge.json` is copied from `server/defaults/tools/` when missing.
5. **Flags and pages.** `features.json`: a stored `sources` value is written to `projects` and
   removed. `platform.json`: `admin.pages.sources` is renamed to `admin.pages.projects`; the
   `projects` block of §7.3 is seeded with `setDefault`. `groups.json`: `projects` and
   `projectSharing` set on the built-in groups where undefined (§7.2).
6. **Retire the file.** `config/sources.json` is moved to `config/sources.json.migrated` so
   nothing loads it and the admin can still read what was there. `contents/sources/*.md` is left
   in place; the breaking-change note says it can be removed once the admin has checked the
   projects.

Idempotent per file: a project file that already exists is not overwritten; an app that has
`projects` and no `sources` is skipped. Tested in `server/tests/migration-v172.test.js` with the
shipped defaults and with a hand-built installation that has every source type, a workflow with
node sources and an agent profile.

### 10.2 Shipped defaults

`server/defaults/config/sources.json` and `server/defaults/sources/` are replaced by
`server/defaults/projects/` (`faq`, `meeting-knowledge-base`, `ihub-documentation`, the six
`intrafind-website-*` entries, `faq-page-source`) and the default apps, workflows and profiles
are rewritten to `projects` with the modes above. The support bot links
`[{ id: 'faq', mode: 'context' }, { id: 'ihub-documentation', mode: 'tools' }]`, its system
prompt uses `{{projects}}` and names the tools `knowledge_search` and `knowledge_read` instead
of "its tool" and `section`; a migration (`V173__support_bot_knowledge_prompt.js`) replaces the
prompt only while it still equals the shipped text, as V133 did. `scripts/export-docs-markdown.js`
keeps writing `server/defaults/sources/ihub-documentation.md`; only the consumer changes.

### 10.3 Breaking-change note (`docs/releases/next/breaking-changes.md`)

```markdown
## Sources are now Projects

Admin-configured sources have become **admin projects**. Every entry of `config/sources.json`
is migrated to `contents/projects/<id>.json` with the same id and one item of the source's kind,
so apps, workflows and agents keep their knowledge. The admin pages are now **Projects**.

- The `sources` list on apps, workflows, workflow nodes and agent profiles is renamed to
  `projects`. A prompt source becomes `{ "id": "...", "mode": "context" }`, a tool source
  `{ "id": "...", "mode": "tools" }`. There are no aliases: a configuration file that still
  says `sources` is rejected by validation.
- The `source_<id>` tools are gone. Apps that link a project in `tools` or `auto` mode get the
  tools `knowledge_search`, `knowledge_read` and `knowledge_list` automatically. System prompts
  that told the model to call "the source tool" or to pass `section` should be reworded; the
  shipped support bot prompt is updated by migration when it was not customised.
- The `{{sources}}` and `{{source}}` placeholders are renamed to `{{projects}}` by migration.
- The admin API `/api/admin/sources*` is replaced by `/api/admin/projects*`; the file-editing
  routes under `/api/admin/sources/:id/files` have no replacement (edit the item instead).
- The MCP gateway exposes `ihub://project/<id>` resources instead of `ihub://source/<id>`.
- The feature flag `sources` is renamed to `projects`; its value is carried over.
- Files under `contents/sources/` are imported into encrypted project storage at the first
  start; the originals are left in place and can be deleted once the projects show as ready.

**Before upgrading:** back up `contents/`. The migration is forward-only. If you deploy several
instances, every instance needs the same `TOKEN_ENCRYPTION_KEY` and a shared volume (or the
same storage provider) for `contents/data/blobs/project-files`.
```

## 11. Audit events

`logAudit({ req, action, resource: 'project', resourceId: projectId, summary })` with the
existing action enum, which gains `read` and `share` (`auditEntrySchema.js`). Summaries never
contain item text.

| Event | `action` | `resource` | Summary |
| --- | --- | --- | --- |
| Project created / updated / deleted | `create` / `update` / `delete` | `project` | name, ownership |
| Item added | `create` | `projectItem` | kind, origin (`uploaded`, `picked from <site>`, `written by <run>`), name, bytes |
| Item refreshed | `update` | `projectItem` | kind, outcome (`ready`, `stale`, error code) |
| Item removed | `delete` | `projectItem` | kind, name |
| Text read (preview, download, source content action) | `read` | `projectItem` | name, format; written with `verbosity: metadata` only when `audit.logReads` is on (new option, default `false`, because every citation preview would otherwise be an event) |
| Members changed / transferred | `share` / `update` | `projectShare` | added, removed, new owner |
| Chat moved into or out of a project | `update` | `project` | chat id |
| Admin toggled, deleted a user project, or ran retention | `toggle` / `delete` | `project` | actor `admin` or `system` |
| Key events (rotation, unwrap denied) | `update` / failure | `projectKey` | key id; phase 3 for rotation, the denied-unwrap failure event ships in phase 1 |

The resource id of item events is the project id; the item id is in the summary, so one filter
shows a project's whole history.

## 12. Estimates and implementation slices

| Slice (one draft PR each) | Contents of this spec | Size |
| --- | --- | --- |
| 1 Project core | §2, §3 (metadata only), §5.1 without items' pipeline, §5.3 shell, §6.4, §7, §8.1, §9, §11 | L (about a week) |
| 3 Items and pipeline | §3 text block, §4 registry and the eight kinds, §5.1 item routes, §9.4, spec 3 | L |
| 4 Migration and admin pages | §10, admin pages replacing Sources, §8.4 | M |
| 5 User UI | §5.1 from the client side, §6.3, §6.4 UI, sharing dialog | L |
| 6 Workflows and agents | §6.2 | M |

## 13. Decisions a reviewer may want to challenge

1. **Admin projects are configuration** (`contents/projects/`), user projects are runtime data.
   The alternative, one runtime namespace for both with a sentinel owner, would take admin
   projects out of `contents/`, backups and migrations that every other admin-managed object is in.
2. **The link carries the mode, not the project.** `exposeAs` lived on the source; moving it to
   the app, workflow or profile lets one project be loaded by one app and searched by another,
   and gives `auto` a place.
3. **Instructions only from the container project and admin links**, never from picker
   attachments: a user attaching a colleague's project mid-chat should not have the chat's
   behaviour rewritten by it.
4. **Two feature flags**: `projects` (the renamed `sources` flag) and `userProjects` (the phase 1
   gate). One flag would either hide migrated knowledge pages behind a preview flag or make
   user projects GA on day one.
5. **No archive state** in v1; delete is the only end. Retention is the switch for abandoned
   projects.
6. **`everyone` sharing is off by default** (`sharing.allowEveryone: false`), unlike prompts,
   because a project carries uploaded documents.
