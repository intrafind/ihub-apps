# 04 — Host Foundation (Word, Excel, PowerPoint)

**Phase:** P3 (needs P1; can run in parallel with P2)
**Parent:** [README](README.md)

## Goal

The existing task pane runs in Word, Excel and PowerPoint as well as Outlook. This doc covers everything those hosts need before their own tools ([05](05-word.md), [06](06-excel.md), [07](07-powerpoint.md)):
- the manifests
- the host adapter
- the ribbon commands
- the context types
- the admin settings

## Manifests: one XML manifest per host

A MailApp (Outlook) and a TaskPaneApp (Word, Excel, PowerPoint) cannot share one XML manifest. Each host therefore gets its own add-in, with its own GUID and manifest URL.

| Host | Root | `<Host Name>` | Permission | Requirement set (base) | Ribbon |
|---|---|---|---|---|---|
| Outlook | `MailApp` | `Mailbox` | `ReadWriteItem` | Mailbox 1.3 / 1.5 | unchanged |
| Word | `TaskPaneApp` | `Document` | `ReadWriteDocument` | WordApi 1.3 (tools check 1.4/1.5 at runtime) | `PrimaryCommandSurface` (Home tab group) |
| Excel | `TaskPaneApp` | `Workbook` | `ReadWriteDocument` | ExcelApi 1.9 | `PrimaryCommandSurface` |
| PowerPoint | `TaskPaneApp` | `Presentation` | `ReadWriteDocument` | PowerPointApi 1.4 | `PrimaryCommandSurface` |

**Generator.** `server/routes/integrations/officeAddin.js` has one hard-coded MailApp template in `generateManifest`. Split it:
- `server/utils/officeManifests/` gets `outlook.js` (the current template, moved) and `taskpane.js` (one template parameterized by host).
- The common parts (icons, `escapeXml`, localized display name, `AppDomains`, `officeManifestVersion`) live in one shared helper.

**Routes:**
- The existing `GET /api/integrations/office-addin/manifest.xml` keeps serving the **Outlook** manifest, so deployed tenants are untouched.
- New: `GET /api/integrations/office-addin/:host/manifest.xml` for `host ∈ {outlook, word, excel, powerpoint}`. It returns 404 when that host is disabled.

**GUIDs.**
- `resolveOfficeAddinId(cfg, host)` in `server/utils/officeAddinManifest.js` reads `officeIntegration.hosts.<host>.addinId`.
- Outlook falls back to the existing `officeIntegration.addinId`, then to `LEGACY_OFFICE_ADDIN_ID`.
- Word, Excel and PowerPoint get a fresh GUID when the admin enables the host. They never fall back to the Outlook id.

**Pages.** All hosts use the same `/office/taskpane.html`, `/office/commands.html` and `/office/callback.html` (`server/routes/office.js`, `renderOfficeHtml`). No new top-level client routes are needed, so the `KNOWN_ROUTES` / `index.html` rule in CLAUDE.md is not affected.

## Host adapter

- **Current state.** `client/office/taskpane-entry.jsx` builds `buildOutlookHost(officeHost, popout)` and already reads `Office.context.host`. `EmbeddedHostContext` (`client/src/features/office/contexts/EmbeddedHostContext.jsx`) has kinds `office | extension | nextcloud`.
- **New adapter fields:**
  - `officeHost: 'outlook' | 'word' | 'excel' | 'powerpoint'`
  - `capabilities()` returns the client tool names available now
  - `executeClientTool(name, args)` runs a tool from `client/src/features/office/tools/<host>/`
  - `readMessageContext()` returns the host's `hostContext` (below)
  - `contextToggles`, for example *Include selection* or *Include whole document*
  - `insertAction` (*Insert into document*, *Insert at selection*)
- **Entry dispatch.** `taskpane-entry.jsx` switches on `Office.context.host` to `buildOutlookHost`, `buildWordHost`, `buildExcelHost` or `buildPowerPointHost`. Each lives in `client/src/features/office/hosts/<host>.js`.
- **Outlook-only parts** of `client/src/features/office/components/OfficeChatPanel.jsx` and `OfficeStartPage.jsx` are guarded by `officeHost === 'outlook'`:
  - `useOutlookMailActions`
  - `useOutlookMailContextSnapshot`
  - pinned emails (`usePinnedEmails`)
  - the `ItemChanged` registration
  - the appointment banners
  - iFinder **Add to email**
- **Answer actions for documents.** One action, **Insert**, which replaces the selection or inserts at the cursor. In Word it follows the tracked-changes setting.
- **Pop-out.** The bridge (`officePopout.js`) gains the generic `runClientTool` and `readHostContext` handlers. The Outlook-specific handlers stay.

## Ribbon commands

- **Current state.** `client/office/commands-entry.js` registers a placeholder (`Office.actions.associate('action', …)`).
- **Per-host buttons:**
  - Word: *Improve*, *Translate*, *Summarize*.
  - Excel: *Explain formula*, *Summarize sheet*.
  - PowerPoint: *Summarize presentation*, *Speaker notes*.
- **Pane handoff.** Each button writes a pending action `{ host, action, ts }` to `localStorage` (`ihub.office.pending-action.v1`), shows the task pane (`Office.addin.showAsTaskpane()` where supported), and completes the event.
  - The pane claims the action on start and runs the configured starter prompt for it, through the normal chat with tools and approvals.
  - If the pane does not claim it within ~3 s, a small dialog tells the user to open the assistant.
- **No token** is read in the commands page, and **no write** happens without the pane.
- **Configuration.** The prompts are per host and per action, under `officeIntegration.hosts.<host>.ribbonActions`, so admins can localize or adjust them.

## Context types (`hostContext`)

`renderUserMessage` in `shared/promptContext.js` already renders `type="email" | "meeting" | "page" | "document"`. Add three more:

| Type | Fields | Limits |
|---|---|---|
| `document` (Word, origin `open`) | `<title>`, `<selection>`, `<outline>` (headings), optionally `<body>` | Body capped (default 50,000 characters); selection preferred |
| `sheet` (Excel) | `<workbook>`, `<sheet>`, `<address>`, `<header>`, `<rows>` as CSV | Hard cell cap (default 2,000 cells), stated as `cells="n of m"` |
| `slide` (PowerPoint) | `<presentation>`, `<slide index>`, `<title>`, `<text>`, `<notes>` | Current slide only |

All of these use the existing tag escaping.

Validate `hostContext` on the server for the first time:
- a Zod schema in `server/validators/` used by `chatPostSchema` (`server/validators/index.js`) instead of `z.any()`
- per-type length caps
- unknown fields stripped

## Admin and config

- **Config shape.** `officeIntegration.hosts`:
  ```json
  {
    "outlook":    { "enabled": true,  "tools": { "enabled": false, "allowed": ["*"], "requireApproval": [], "recipientDomainAllowlist": [] } },
    "word":       { "enabled": false, "addinId": "", "starterPrompts": [], "ribbonActions": {}, "trackChanges": "on",
                    "tools": { "enabled": false, "allowed": ["*"], "requireApproval": [] } },
    "excel":      { "enabled": false, "addinId": "", "starterPrompts": [], "ribbonActions": {}, "maxCells": 2000,
                    "tools": { "enabled": false, "allowed": ["*"], "requireApproval": [] } },
    "powerpoint": { "enabled": false, "addinId": "", "starterPrompts": [], "ribbonActions": {},
                    "tools": { "enabled": false, "allowed": ["*"], "requireApproval": [] } }
  }
  ```
  - `officeIntegration.enabled`, the OAuth client, the "Available Apps" list (on the OAuth client, `server/utils/officeAppAccess.js`), Office.js mode, start page and display name stay **shared**.
  - `hosts.outlook.enabled` mirrors today's behavior: on whenever the integration is on.
- **Migration V208** (`server/migrations/V208__office_integration_hosts.js`, via the create-migration skill):
  - seeds `hosts` only where `officeIntegration` exists
  - keeps Outlook enabled
  - leaves the other hosts and all tools off
  - also adds the missing defaults to `server/defaults/config/platform.json`: `hosts`, `defaultMailAction`, `addinId`
  - test: `server/tests/migration-v208.test.js`, listed in the `test:migrations` script
- **Validation.**
  - New `server/validators/officeIntegrationSchema.js` (Zod), used by `PUT /api/admin/office-integration/config` in `server/routes/admin/officeIntegration.js`.
  - Its existing inline validators (`validateOfficeStartPage`, `validateOfficeMailAction`, `validateOfficeAllowedApps`, `validateOfficeJsUrl`) are wrapped, not rewritten.
  - Register the schema in `server/validators/platformConfigSchema.js` for `officeIntegration`; today that key is not validated at all.
- **Admin routes.**
  - `POST /api/admin/office-integration/hosts/:host/enable` and `/disable`. Enable creates the host's GUID.
  - `GET /status` returns per-host manifest URLs.
- **Admin UI.** `client/src/features/admin/pages/AdminOfficeIntegrationPage.jsx` (1,600 lines) gets host tabs (Outlook, Word, Excel, PowerPoint).
  - Each tab holds Status/Enable, Manifest (URL, download, GUID), Starter prompts, Ribbon actions and Model tools.
  - The shared sections stay above the tabs.
  - Split the tabs into components under `client/src/features/admin/components/office/` so the page file does not grow further.
- **Integrations overview card.** `client/src/features/admin/components/integrations/inboundChannels.js` (`INBOUND_INTEGRATIONS`): the Outlook card becomes *Microsoft Office add-ins*, showing which hosts are on.

## Deployment docs

- Rename `docs/outlook-add-in.md` to `docs/office-add-ins.md`, with redirect text in the old file, or keep the name and add one section per host.
- Steps per host: enable it, copy its manifest URL, then in the M365 admin center go to Integrated apps → Upload custom apps → Office Add-in, once per host.
- Keep `docs/SUMMARY.md` in sync.

## Tests

- **Manifests.**
  - Snapshot each host's manifest.
  - Validate against the Office add-in XML schema with `office-addin-manifest validate` in CI, if feasible.
  - Check that the legacy URL still serves the Outlook manifest.
- **Add-in ids.** `resolveOfficeAddinId(cfg, host)`: Outlook gets legacy and configured ids; the other hosts get their own and never Outlook's. Register `server/tests/office-addin-manifest-id.test.js`, which exists but is in no npm script today.
- **Validation.** `hostContext` Zod rejects oversized and unknown fields; `renderUserMessage` produces the new types with escaping.
- **Ribbon handoff.** The pane claims a pending action; an unclaimed action shows the hint.
- **Admin.** Host tabs render, enabling a host creates a GUID, and the axe baseline holds.

## Acceptance criteria

- The Word, Excel and PowerPoint manifests can be uploaded in the M365 admin center, and the pane signs in with the existing OAuth client.
- In each host the pane opens, shows the start page and chats with the host's `hostContext` (selection, range, slide), without tools.
- Existing Outlook deployments are unchanged (same manifest URL and GUID).
