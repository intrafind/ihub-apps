# Workflow Executions Overview — Enhancements

**Date:** 2026-05-19
**Status:** Draft — awaiting review
**Scope:** `client/src/features/workflows/pages/MyExecutionsTab.jsx`, `client/src/features/workflows/components/ExecutionCard.jsx`, `client/src/features/workflows/hooks/useMyExecutions.js`, `server/services/workflow/ExecutionRegistry.js`, `server/routes/workflow/workflowRoutes.js`

## Problem

The workflow executions list (the "My Executions" tab on `/workflows`) currently shows only the workflow name, status, started timestamp, and current node. A user cannot tell *what* a given run was about without opening it. There is no way to clean up the list, no way to grab a result without entering the run, and no way to set a run aside without losing it.

## Goals

1. Show the input(s) a user provided when starting a run, on the list card itself.
2. Provide a delete action that removes a finished run and its checkpoint data.
3. Provide a download action that exports a run's result/state directly from the list.
4. Provide an archive/unarchive action that hides a run from the default view, with a "Show archived" toggle to bring archived runs back.
5. When space permits, show which model(s) the workflow uses.

## Non-goals

- Bulk select / multi-delete (future enhancement).
- A retention / auto-archive policy.
- A new "result-only" export format. The existing `/export` endpoint is reused unchanged.
- Changes to the execution detail page (`WorkflowExecutionPage.jsx`).
- Admin-side bulk management UI (`/admin/workflows/executions` view).

## User-facing behavior

### Card content

Each execution card grows from a single line of metadata to:

```
▎ <Workflow Name>  <Status badge>  <Model badge — optional>
  Started: <local datetime>
  Input: key1: value · key2: value      ← clamped to 2 lines
  → Current: <node>                     ← only while running/paused
  ⚑ Awaiting your input                 ← only when pending checkpoint
                       [⇩ Download] [⌫ Delete] [▢ Archive] [Join | View]
```

- **Status badge** — unchanged.
- **Model badge** — small pill, e.g. `gpt-4o` or `gpt-4o +2` when multiple distinct models. Hidden on `< sm` breakpoints. Hidden entirely if the workflow has no resolvable model.
- **Input** — sanitized snippet built from the user-provided initial data (see "Input preview"). Two-line `line-clamp-2`. Hidden if there is no input.
- **Action icons** — only download is shown for active runs; delete is shown only for terminal states (completed/failed/cancelled); archive is always shown.

### Filter bar additions

A new toggle joins the existing status filter pills:

- **Show archived** — off by default. When on, the executions list returns archived runs *in addition to* non-archived runs that match the status filter. Archived rows render with a 60% opacity wrapper and a small `Archived` chip next to the status badge.

### Action semantics

| Action | Allowed when | Behavior |
| --- | --- | --- |
| Download | `status ∈ {completed, failed, cancelled}` | `GET /api/workflows/executions/:id/export` → browser downloads `workflow-<short>.json` (unchanged endpoint) |
| Delete | `status ≠ running` | Opens a `ConfirmDialog` ("Delete this execution? This cannot be undone."). On confirm: `DELETE /api/workflows/executions/:id` → row optimistically removed; refetch on error |
| Archive | always | `PATCH /api/workflows/executions/:id` with `{ archived: true }`. Row is removed from the visible list (or dimmed if "Show archived" is on) |
| Unarchive | when archived | Same endpoint with `{ archived: false }` |

For a running execution, the Delete icon is disabled with tooltip `"Cancel the workflow before deleting"`.

## Server design

### `ExecutionRegistry` (`server/services/workflow/ExecutionRegistry.js`)

New persisted fields on each execution record:

| Field | Type | Notes |
| --- | --- | --- |
| `inputPreview` | `object \| null` | Sanitized initial data — see below |
| `models` | `string[]` | Distinct model IDs referenced by the workflow definition's prompt/agent nodes at registration time |
| `archived` | `boolean` | Default `false` |

These fields are written by `register()` when new metadata is provided, and persist through `saveToDisk()` / `loadFromDisk()` like the existing fields. Records loaded from older registry files will simply not have them and the UI tolerates `undefined`.

#### Input preview

Built in `workflowRoutes.js` when calling `register()` from `/execute`. Algorithm:

1. Start from `initialData` passed by the client.
2. Drop any key that starts with `_` (e.g. `_workflowDefinition`).
3. Drop any value that is `null`, `undefined`, or an empty string.
4. For each remaining value: if it is a string longer than 120 chars, truncate to 117 chars + `…`. If it is an object or array, replace with the literal string `"[object]"` or `"[N items]"`. Numbers and booleans pass through.
5. Cap the result at the first 6 entries (insertion order). If more keys exist, append a synthetic `__more` count for the UI to render as `+N more`.

Stored as e.g.:

```json
"inputPreview": { "topic": "AI safety", "depth": "brief", "__more": 2 }
```

The full input is **not** stored on the registry — it remains in the execution's checkpoint state. The preview is purely for the list view.

#### Models

Built in `workflowRoutes.js` at register time:

```js
const modelSet = new Set();
for (const node of workflow.nodes || []) {
  if (typeof node.model === 'string' && node.model) modelSet.add(node.model);
}
const models = Array.from(modelSet);
```

If the workflow has no nodes with a `model` field, `models` is `[]` and the UI hides the badge.

#### New methods

```js
// Soft archive / unarchive. Returns updated execution or null.
setArchived(executionId, archived: boolean)

// Hard delete: removes registry entry. Caller is responsible for deleting
// checkpoint files on disk. Returns true if removed, false if not found.
remove(executionId)   // already exists; reused as-is
```

#### `getByUser` changes

Accepts two new filter modes:

- `filters.includeArchived` — `false` (default) returns only `archived !== true`; `true` returns all runs that otherwise match.
- `filters.archived` — when set to `'only'`, returns only archived runs (overrides `includeArchived`). Reserved for a future "Archived" view; not used in this iteration.

Existing `status` and pagination behavior is unchanged.

### Routes (`server/routes/workflow/workflowRoutes.js`)

#### Modified: `POST /api/workflows/:id/execute`

Compute `inputPreview` and `models` and pass them into `registry.register()`:

```js
registry.register(state.executionId, {
  userId,
  workflowId: workflow.id,
  workflowName: workflow.name,
  status: state.status,
  startedAt: state.createdAt,
  inputPreview: buildInputPreview(initialData),
  models: buildModelsList(workflow)
});
```

`buildInputPreview` and `buildModelsList` live in `workflowRoutes.js` (small helpers) — they are not generic enough to extract. Both functions are pure and side-effect-free.

#### Modified: `GET /api/workflows/my-executions`

Accepts new query param `includeArchived` (`'true'` | `'false'`, default `false`). Passes through to `registry.getByUser`. Default behavior (no param) hides archived runs — existing callers see no change.

#### New: `DELETE /api/workflows/executions/:executionId`

- Auth: `authRequired`.
- Lookup execution in registry. 404 if missing.
- 403 if `execution.userId !== currentUser.id` and current user is not admin.
- 409 if `execution.status === 'running'` with body `{ error: 'cannot_delete_running' }`.
- Calls `workflowEngine.deleteExecution(executionId)` (new method, below) which removes the checkpoint directory from disk.
- Removes from registry via `registry.remove(executionId)`.
- Returns `{ success: true }`.

#### New: `PATCH /api/workflows/executions/:executionId`

- Auth: `authRequired`. Same ownership/admin check as DELETE.
- Body: `{ archived?: boolean }`. Any other fields are ignored.
- Calls `registry.setArchived(executionId, body.archived)`.
- Returns updated metadata.

### `WorkflowEngine.deleteExecution(executionId)`

Adds a method that:
1. Refuses if the execution is currently in the in-memory active runs map.
2. Removes `{stateDir}/{executionId}/` recursively (`fs.rm` with `{ recursive: true, force: true }`).

This is the only piece outside the registry that needs to know about checkpoint files. Registry stays disk-aware only via its existing `_scanCheckpointDirectories` path.

## Client design

### `useMyExecutions` hook

Adds one option:

```js
useMyExecutions({ status, includeArchived = false, limit, offset })
```

Appends `&includeArchived=true` when set. Otherwise unchanged.

### `MyExecutionsTab.jsx`

- New piece of state: `showArchived` (boolean, default `false`).
- New element in the filter bar: a checkbox-style toggle button labeled `Show archived`, positioned just left of the refresh button.
- Three new handler callbacks passed to each card:
  - `handleDelete(execution)` — opens `ConfirmDialog`, on confirm calls `apiClient.delete`, optimistic remove on success.
  - `handleArchive(execution, archived)` — calls `apiClient.patch`, optimistic update in local list; refetch on error.
  - `handleDownload(execution)` — triggers a hidden `<a>` to the export URL with `download` attribute.

The page already auto-refreshes every 5s when `runningCount > 0`; that loop is preserved and now also picks up archived-state changes.

### `ExecutionCard.jsx`

New props:

| Prop | Type |
| --- | --- |
| `onDelete` | `(execution) => void` |
| `onArchive` | `(execution, nextArchived) => void` |
| `onDownload` | `(execution) => void` |

- Renders the new `Input:` block when `execution.inputPreview` has at least one non-`__more` key. Format: `key1: value · key2: value` joined by middle-dot. If `__more` is set, append ` · +N more`.
- Renders the model badge when `execution.models?.length > 0`. Shows `models[0]`; if `models.length > 1` shows `${models[0]} +${models.length - 1}`. Uses a neutral gray pill style.
- Renders action icons (`download`, `trash`, `archive` / `archive-box`) between the existing content and the Join/View button. Each is a 32×32 button with `aria-label` and tooltip. Disabled icons use `opacity-50 cursor-not-allowed`.
- When `execution.archived === true`, the outer card wrapper gets `opacity-60` and an `Archived` chip renders next to the status badge.

### Icons

Reuses Heroicons already registered in `Icon`:
- `arrow-down-tray` → download
- `trash` → delete
- `archive-box` → archive
- `archive-box-arrow-down` → unarchive (or reuse `archive-box` with different tooltip if the second variant is not registered — the implementation step will verify)

## Permissions & security

- Delete and archive are restricted to the execution owner OR users with `adminAccess` permission. Other users get 403.
- Hard delete is **irreversible** by design. The confirm dialog states this. Backups are out of scope.
- The export endpoint is reused with no permission changes (it already requires `authRequired` and is owner-scoped via the registry).

## Backward compatibility

- The registry's new fields (`inputPreview`, `models`, `archived`) are optional. Old registry files load fine — fields just come up `undefined` / `false` and the UI shows the same content it does today for those runs.
- The `my-executions` endpoint defaults to `includeArchived=false`, which matches today's behavior (no archived runs exist yet anyway).
- No migration script is required.

## Error handling

- Delete failure: toast/inline error, list is refetched to undo the optimistic removal.
- Archive failure: same.
- Download failure: browser handles 4xx/5xx from the export endpoint; no client-side success indicator beyond the download itself.
- Attempt to delete a running execution: server returns 409, client surfaces a translatable error message (`workflows.errors.cannotDeleteRunning`).

## Testing

- **Unit (server):** `ExecutionRegistry` — new fields persist round-trip; `setArchived` toggles; `getByUser` excludes archived by default and includes when asked.
- **Unit (server):** `buildInputPreview` — strips `_`-prefixed keys, truncates long strings, caps at 6 entries, marks `__more`.
- **Integration (server):** `DELETE` returns 409 for running, 403 for wrong user, 200 for owner.
- **Integration (server):** `PATCH archived` round-trips.
- **Manual UI:** start two workflows with different inputs; verify input preview shows; archive one, toggle filter; delete a completed one; download a completed one's JSON.

## Follow-up: documentation review

After this lands, the `docs/` content covering workflows (and likely the wider admin area) needs a pass. Two related problems are surfacing in practice:

1. **People edit JSON config files directly** — `contents/apps/*.json`, `contents/workflows/*.json`, `contents/config/groups.json`, etc. — even though almost everything is now manageable through the admin UI.
2. **The docs don't describe the admin UI.** Today they focus on file schemas and CLI/server behavior. That makes the JSON the path of least resistance for new users, which is more error-prone, bypasses validation, and means changes don't show up consistently across sessions.

What this work touches that the docs should now reflect:

- New per-run actions on the **My Executions** page: input preview, model badge, download result, archive/unarchive (with the *Show archived* toggle), and delete.
- The fact that a workflow's **primary output** (`chatIntegration.primaryOutput`) drives the user-facing download. Authors choosing or renaming output keys should know this.
- Archive is a soft hide; delete is permanent and refuses while running — call this out so admins/users don't expect a recycle bin.

What to audit beyond this feature:

- For each area that has an admin UI (apps, prompts, models, sources, tools, groups, workflows, pages, UI/branding), the docs should lead with **"use the admin UI under `/admin/…`"** and treat the JSON schema as the reference for what the UI configures, not as the recommended workflow.
- Add screenshots or short flows for the common tasks people currently solve by hand-editing JSON: creating an app, granting a group access, adding a model, publishing a workflow, etc.
- Cross-link from the JSON schema sections back to the corresponding admin page, so people who land in the schema docs see that there is a UI for it.

This is intentionally not part of this PR — it's its own task. Track it as a separate doc-revision pass.

## Open questions

None at this time. The owner-vs-admin permission split, hard-delete semantics, and model-derivation strategy were called out in brainstorming and confirmed.
