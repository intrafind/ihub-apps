# User projects client (slice 5 of #1036)

Status: implemented on the `claude/projects-migration` line, client only. The server (slices
1–4) was not changed. Read this together with the specs in this folder (Spec 1 §2–§9, Spec 2
§4.3–§6, Spec 3 §3 and §9) and the slice 4 note (`2026-10-21 Admin projects client (slice 4).md`).

## What users get

- **`/projects`** — the viewer's projects: owned, shared with them, and admin projects their apps
  bring along ("From apps", read-only). Filters (all / mine / shared / from apps), search, "New
  project" (name, description, instructions). The button follows `_config.userProjects`
  (`canCreate`, `maxProjects`, `used`).
- **`/projects/:projectId`** — one project:
  - documents table (status, provenance, pin, preview, retry, refresh, rename, remove) with the
    usage bars against `_config.limits`;
  - "Add documents" dialog: upload (several files, one request each, drag and drop), text, URL
    (with `/pickers/url/check`), iHub page, iFinder document / search, and the three cloud kinds
    through the existing cloud file browsers (`/pickers/cloud` lists the connections);
  - settings card (name, description, instructions) for owner and editors, plain text for others;
  - chats in the project (`filter=all|mine`), "New chat" (pick an app → `/apps/<app>?project=<id>`);
  - members: owner, member list (or count), Share (the prompt share dialog, reused), Transfer
    ownership, Leave; Delete with confirmation; the read-only banner when the owner is gone.
- **Chat**: `AppChat` sends `projectId` (from `?project=` or the stored chat) on every turn; a bar
  under the header shows "In project: X" (link) and "Move to project" / "Change project" for a
  stored chat. The chat history page shows a project chip per chat and a "Move to project" button.
- **Answers**: the `knowledge/scope` badge names a single project and links a user project (a
  project the viewer may not see by name reads "Private project"); source cards and the details
  dialog show _Uploaded_ / _Picked from … · text taken …_ / _Linked_; the document preview opens
  text-only project documents (uploads, picked cloud files, web and iHub pages) directly in
  **text mode** (`format=text`, passages highlighted, match navigation), asks for the PDF for
  everything else (an iFinder item of a project is served through the iFinder provider) and falls
  back to the text on `410 ORIGINAL_DISCARDED`. Download (panel and preview) and "attach to mail"
  go through `downloadSource` / `fetchDownloadableContent` with the same rule and save text as
  `.txt`.
- **Navigation**: "Projects" in the sidebar (expanded and rail), document title, full-bleed layout.
  `projects` is in `KNOWN_ROUTES` and in the inline list of `client/index.html`.

Everything is gated by `platformConfig.projects.enabled && .userProjects` and a signed-in,
non-anonymous viewer (`useProjectsAvailability`). Nothing is requested while the gate is closed.

## Where the code is

| Concern | File |
| --- | --- |
| API helpers (`/api/projects`, pickers, `PATCH /api/chats`) | `client/src/api/endpoints/projects.js` (re-exported from `api/index.js`) |
| Item rules shared with the admin editor | `client/src/features/projects/utils/projectItems.js` |
| User page rules (list, form, quotas, members, chats) | `client/src/features/projects/utils/projectView.js` |
| Error code → message | `client/src/features/projects/utils/projectErrors.js` |
| Provenance chip rules | `client/src/features/projects/utils/projectProvenance.js` |
| Gate, `_config`, project list, one project (polling) | `client/src/features/projects/hooks/useProjects.js`, `usePolledProject.js`, `projectStore.js` |
| Item actions (pin, refresh, rename, remove) | `client/src/features/projects/hooks/useProjectItemActions.js` |
| Pages | `client/src/features/projects/pages/ProjectsPage.jsx`, `ProjectPage.jsx` |
| Shared item components (lifted from admin) | `components/ProjectItemsTable.jsx`, `ProjectItemStatus.jsx`, `ProjectItemTextDialog.jsx`, `AddProjectItemDialog.jsx` + `components/item-dialog/*` |
| Page sections and dialogs | `components/ProjectItemsSection.jsx`, `ProjectChatsSection.jsx`, `ProjectMembersSection.jsx`, `ProjectSettingsCard.jsx`, `CreateProjectDialog.jsx`, `TransferProjectDialog.jsx`, `StartProjectChatDialog.jsx`, `RenameItemDialog.jsx`, `ProjectUsageBar.jsx`, `ProjectRoleBadge.jsx`, `ItemProvenance.jsx` |
| Chat integration | `components/ChatProjectBar.jsx`, `MoveChatToProjectDialog.jsx`; edits in `features/apps/pages/AppChat.jsx`, `features/chat/pages/ChatHistoryPage.jsx` |
| Text mode of the preview | `features/documentPreview/components/TextPassageViewer.jsx` (the only text viewer), `utils/textPreview.js` (`ORIGINAL_DISCARDED`, `previewFormatFor`, `downloadFormatFor`, `splitByPassages`), `DocumentPreviewModal.jsx`; `ORIGINAL_DISCARDED` is also exported from `chat/sources/sourceActions.js` |
| Cloud browser `onPick` | `features/upload/components/CloudFileBrowserShell.jsx` (`onPick`, `pickLabel`) |
| Translations | `shared/i18n/{en,de}.json` → `projects.*`, plus `sidebar.projects`, `documentTitle.projects`, `chatHistory.{inProject,moveToProject,moved}`, `sources.project`, `documentPreview.textOnly`, `chatMessage.knowledgeScope.openProject` |
| Tests | `tests/unit/client/project-user-utils`, `projects-api`, `projects-page`, `project-page`, `project-chat-integration` (`.test.jsx`), one case in `app-chat-hydration.test.jsx` |

Rule of thumb, as in slice 4: components render and call the API; decisions are pure functions in
`utils/` with tests in `project-user-utils.test.jsx`.

### What moved from the admin slice

`ProjectItemsTable`, `AddProjectItemDialog`, `ProjectItemTextDialog` moved from
`features/admin/components/` to `features/projects/components/`; the admin edit page passes its
own API object (`ADMIN_ITEM_API`) and text loader. The item helpers moved from
`features/admin/utils/projectAdmin.js` to `features/projects/utils/projectItems.js` (no
re-export; imports and the admin test were updated). `useAdminProject` is now a thin wrapper of
`usePolledProject`. The translations `admin.projects.{addItem,preview}` and the item table keys of
`admin.projects.items` moved to `projects.*`. The admin dialog keeps the cloud tabs as "coming in
a later release" (`buildItemDialogTabs(kinds, config, { cloud })`); the user dialog sets
`cloud` and hides kinds the installation does not offer (`hideUnavailable`).

### Reconciled with the review round on the base branch (c68e305)

The base branch added its own 410 fallback (`TextPassageView.jsx` with `segmentText`, a `.txt`
fallback inside `downloadSource`, `ORIGINAL_DISCARDED` in `sourceActions.js`). After the merge
there is one viewer (`TextPassageViewer`, which also navigates between highlights and finds a
passage by its start when it is not verbatim; segments are keyed by their offset as in the base
version), one constant (`textPreview.js`, re-exported from `sourceActions.js`), and one download
path (`fetchDownloadableContent` → `downloadSource`, used by the preview's Download button too).
The base's `privateProject` label is used by the single-project badge and the tooltip.

## What the API lacked (no server change was made)

1. **Leave.** There is no "leave" call. An editor listed by name leaves by writing the member list
   without themselves (`PUT …/members`). A *user* member, or anyone who is a member through a group
   or "everyone", cannot leave; the button is hidden for them. Suggestion:
   `DELETE /api/projects/:id/members/me`.
2. **Transfer target lookup.** The transfer dialog searches users through `share-targets`, which
   returns users only when the caller may share with users (`projectSharing` and
   `sharing.allowUsers`). An owner without sharing rights cannot find a new owner.
3. **Project search** (`GET /api/projects/:id/search`, spec 1 §5.1) does not exist on the server,
   so the page has no search box.
4. **`410 ORIGINAL_DISCARDED`** from `/api/sources/project/content` carries no `code` in the body
   (`sendErrorResponse` without details); the client keys off the status 410.
5. **Chat ownership.** `GET /api/chats/:id` does not say whether the viewer owns the chat, so the
   chat bar offers "Move to project" on a member's read-only chat too; the server refuses with 404
   and the dialog shows the message. `GET …/chats` gives `owner.name` only from `chat.ownerName`,
   which is often empty ("by another member").
6. **Admin projects on the user page** are read-only: `PATCH /api/projects/:id` validates plain
   strings, admin projects have localized names. Content admins edit them under Admin → Projects.
7. The iFinder picker routes are `GET` with `q`/`profile`/`limit` (spec says `POST`); the client
   follows the server.

## Left out / next steps

- **Chat-input project picker** (`projects: [id]` on the chat request, `attachedProjectIds`) is not
  built; only the container (`projectId`) is wired.
- **Workflow inputs of `type: 'project'`** (spec 1 §6.2) and the admin compliance listing of user
  projects (`?ownership=user`) are not built.
- **User documentation** (`docs/projects.md` does not exist yet); a release note was added to
  `docs/releases/next/features.md` ("Projects for users (preview)").
- Google Drive items: the cloud browser's link field is taken from `webUrl` or `webViewLink`;
  check the Drive listing if picked items show no "Open" link.
- Starting a chat inside a project from the **start page** (instead of the project page) is not
  offered; `projectChatStartPath(appId, projectId)` is the helper to reuse.
