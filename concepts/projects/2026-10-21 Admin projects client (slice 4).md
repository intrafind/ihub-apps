# Admin projects client (slice 4 of #1036)

Status: implemented on the `claude/projects-migration` line (client side only).
The server side of slice 4 (`/api/admin/projects`, the `sources` → `projects`
migration) is built in parallel; this note covers what the client does and
where to continue.

## What changed for admins

- **Admin → Projects** replaces **Admin → Sources** (`/admin/projects`,
  `/admin/projects/new`, `/admin/projects/:id`). The routes are gated by
  `showAdminPage('projects')`; the sidebar entry also needs the `projects`
  feature flag (default on).
- Apps, workflow prompt nodes and agent profiles link projects instead of
  sources: `app.projects`, node `config.projects`, `profile.projects`. The
  value is a link list `[{ id, mode, write }]`.
- The overview counts projects; the command palette lists "Projects" and
  routes `project` search hits to `/admin/projects/<id>`; the keyboard
  shortcut is `g j` (proJects; `g p` is Prompts).

## Where the code is

| Concern | File |
| --- | --- |
| API helpers (admin projects, items, pickers) | `client/src/api/adminApi.js` (section "Projects API functions") |
| Business rules (pure, unit tested) | `client/src/features/admin/utils/projectAdmin.js` |
| Load + poll one project | `client/src/features/admin/hooks/useAdminProject.js` |
| List page | `client/src/features/admin/pages/AdminProjectsPage.jsx` |
| Edit/create page | `client/src/features/admin/pages/AdminProjectEditPage.jsx` |
| Items table + status badge | `client/src/features/admin/components/ProjectItemsTable.jsx` |
| "Add item" dialog (one tab per kind) | `client/src/features/admin/components/AddProjectItemDialog.jsx` |
| Text preview / test results / delete refusal | `ProjectItemTextDialog.jsx`, `ProjectTestResults.jsx`, `ProjectDependenciesDialog.jsx` |
| Link picker + size hint | `ProjectPicker.jsx`, `ProjectTokenCount.jsx` |
| App editor card | `components/app-form/ProjectsConfigSection.jsx` |
| Translations | `shared/i18n/{en,de}.json` → `admin.projects.*` |
| Tests | `tests/unit/client/admin-project-utils`, `admin-projects-api`, `admin-projects-page`, `admin-project-edit-page`, `project-picker` (`.test.jsx`) |

Rule of thumb: components render and call the API; every decision (what a
tab sends, whether an id is valid, which links exist, when to poll) is a
function in `projectAdmin.js`. Add new rules there and test them in
`admin-project-utils.test.jsx`.

## How the pages behave

**List.** `GET /api/admin/projects` plus, in parallel and allowed to fail,
`_stats` (header tiles) and `_kinds` (kind names). Delete first asks
`_dependencies/:id`; any dependency opens `ProjectDependenciesDialog` and no
delete is sent. If the server still answers `400 PROJECT_IN_USE`, the same
dialog shows `details.dependencies`.

**Edit.** Creating posts the settings, then navigates to `/admin/projects/<id>`
(items need an existing project). Editing sends `PUT` with the whole project
minus `items` (`buildProjectPayload`: empty languages and an empty
description are dropped, because the schema only accepts localized records).
Items are changed one by one (`PATCH`/`DELETE`/`refresh` per item) and never
through the `PUT`.

**Polling.** `useAdminProject` re-reads the project every 2 s while an item
is `pending` or `extracting` (`ITEM_POLL_INTERVAL_MS`). The form is filled
only once per project, so polling never overwrites unsaved edits.

**Add item tabs.** `buildItemDialogTabs(kinds, config)` decides the tabs:
`upload` (multipart, field `file`, plus `name`, `pinned`), `text` (JSON
`{ kind: 'upload', ref: {}, name, text }`), `url`, `page`,
`ifinder-document`, `ifinder-query`; `office365`, `google-drive` and
`nextcloud` are always disabled ("coming in a later release"). Upload and
text are disabled when `_config.upload.available` is false (both need the
project blob storage).

**Link modes.** `auto` (server loads the text while it fits
`loadAllBudgetTokens`, otherwise searches), `context` (always in the
prompt), `tools` (search tools only). `ProjectTokenCount` explains the size
against these budgets from `GET /api/admin/projects/_tokens`. The `write`
flag is preserved but not editable yet.

## Open points / next steps

1. **Write access UI.** Links carry `write`, but no control sets it yet;
   add a checkbox in `ProjectPicker` once the server uses it.
2. **Cloud kinds.** Enable the tabs in `buildItemDialogTabs` and add a
   picker (the cloud browser in `features/upload` is the starting point).
3. **User projects (compliance view).** `GET /api/admin/projects?ownership=user`
   is not shown yet; only the count appears in the header.
4. **Workflow template variables.** `workflowEditorUtils.js` still lists
   `{{sources}}`/`{{source}}` as prompt variables; change them when the
   server renames the placeholder.
5. Release note in `docs/releases/next/` (outside the client slice; use the
   `/document-feature` skill when the slice is merged).
