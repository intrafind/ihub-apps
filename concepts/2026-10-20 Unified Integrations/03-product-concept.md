# 03 · Product concept: one integrations platform

**Date:** 2026-10-20 · **Status:** Proposal · Part of [Unified Integrations](README.md)

## 1. The idea in one paragraph

Every way iHub reaches another system becomes an **integration**: a catalog entry that an admin **installs** from a marketplace registry (or adds by hand), **configures and enables** once for groups, and that a user then **connects** (if it needs their own sign-in) and **uses** in chat through one picker. MCP servers, native connectors (Jira, Microsoft 365, SAP, d.velop, …), OpenAPI tools, A2A agents, cloud storage, web search and iFinder all fit this model; they differ only in *how they are wired* (protocol) and *what they offer* (capabilities), not in how they are found, installed, enabled, connected or picked. The output side (sources, citations, preview, download) already has one contract; this concept gives the input side one too.

## 2. Vocabulary

| Term | Meaning | Today's equivalents |
| --- | --- | --- |
| **Integration** | A catalog entry: who it talks to, how it is wired, how it authenticates, what it offers. Immutable, versioned, distributable through a registry. | MCP catalog entry, connector module, OpenAPI tool JSON, a2a agent, cloud storage provider, web search provider |
| **Installed integration** (instance) | An integration set up on this iHub: endpoint and install fields filled, OAuth client chosen, groups allowed, policies set, enabled or not. An integration can be installed more than once (two Jira sites, EU and US tenants). | an entry in `mcpServers.json`, `platform.jira`, a provider in `platform.cloudStorage` |
| **Connection** | One principal's credential for one installed integration. **Personal** (a user's OAuth grant, PAT or API key) or **shared** (an admin-owned secret, offered to groups). | `TokenStorageService` files, `credentials.json` profiles |
| **Capability** | What an integration offers: `tools` (model-callable actions), `files` (browse and pick files), `search` (knowledge source), `views` (MCP Apps UI), `triggers` (events), `agent` (A2A), `channel` (inbound surface). An integration declares one or more. | tools vs sources vs cloud storage picker vs MCP Apps |
| **Action** | One model-callable tool of an integration, with an **effect**: `read`, `write`, `destructive`. From MCP annotations, OpenAPI method, or the connector's declaration. | tool function, MCP tool |
| **Binding** | How an app (or workflow, agent, scheduled task) uses an integration: which actions, and *whose connection* (each user's own, or a pre-selected shared one). | `app.tools`, `app.sources`, `app.upload.cloudStorageUpload`, `app.websearch` |
| **Registry** | A `catalog.json` source the marketplace reads. Gains the item type `integration`. | marketplace registries |

Two words we stop using in the UI: "MCP server" as a top-level thing a user has to understand (it becomes the *protocol* field of an integration), and "tool" as the thing a user enables (users enable *integrations*; the model sees *actions*).

## 3. Who we design for

| Persona | Goal | Today's friction |
| --- | --- | --- |
| **Platform admin** (IT, one per customer) | Roll out "the systems our people use" safely: SharePoint, Confluence, Jira, SAP, the DMS. Control who gets what, which actions may write, where data goes. | Five places to look, no group scoping, no live status, hand-written JSON for Jira |
| **Content admin / power user** (department) | Build an app that uses two integrations with a shared service account, without IT. | Needs IT for every secret, cannot see what is available |
| **End user** | "Ask about my tickets", "find the contract in SharePoint", "put this in the DMS". Connect once, forget about it, be asked before anything is written. | Three connect cards, connections scattered, no view of what is available, silent writes |
| **Solution architect / partner** (IntraFind, integrators) | Ship a tested integration (e.g. enaio, SAP) to many customers; update it later. | Every integration is code in the product; nothing installable |
| **Security officer** | Know which systems are reachable, by whom, with which identity, and that writes are confirmed and audited. | Audit exists for OAuth grants only |

## 4. Principles

1. **One model, many protocols.** MCP, OpenAPI, native code, A2A and storage pickers are *wiring*. Catalog, install, enable, connect, pick, confirm and audit are shared.
2. **Delegated by default.** Actions run as the signed-in user wherever the system supports it. Shared credentials are explicit, admin-owned, and visible to the user as "runs as service account X".
3. **Admin enables, user connects, user picks.** Three separate decisions with three separate owners. An admin can never consent on a user's behalf; a user can never widen what the admin allowed.
4. **Writes need a human** unless the admin relaxes it per integration. The effect of every action is known before it runs.
5. **Progressive disclosure.** The catalog shows a name, a logo, a one-liner and three facts (sign-in type, read/write, where it runs). Everything else is one click deeper.
6. **Status is observed, not assumed.** Every installed integration has a last health check; every connection has an expiry.
7. **Distributable.** An integration is a file. It can be published in a registry, installed, updated, detached, like an app or a skill today.
8. **Standards first.** MCP authorization (RFC 9728, 8414, 8707, CIMD), MCP registry `server.json`, MCPB `user_config`, MCP Apps. Our own fields only where no standard exists (groups, policy, residency).

## 5. The three-layer model

```
┌────────────────────────────── Catalog (registry) ──────────────────────────────┐
│  Integration  "Atlassian Jira & Confluence"  v2.1   publisher: Atlassian         │
│  protocol: mcp-remote   auth: oauth-user   capabilities: tools, views           │
│  install fields: region (EU|US)   categories: productivity, ticketing           │
└──────────────────────────────────┬────────────────────────────────────────────┘
                                   │ install
┌──────────────────────────────────▼────────────────────────────────────────────┐
│  Installed integration  "Jira (EU)"   enabled   groups: engineering, support   │
│  endpoint: https://mcp.atlassian.com/v2/mcp   oauth client: CIMD (default)     │
│  actions: 21 (14 read · 6 write · 1 destructive)   policy: confirm writes      │
│  health: ok · 2 min ago     connected users: 37                                │
└──────────────────────────────────┬────────────────────────────────────────────┘
                                   │ connect
┌──────────────────────────────────▼────────────────────────────────────────────┐
│  Connection   user: d.manzke   status: active   scopes: read:jira, write:jira  │
│  expires: 2026-11-19   last used: today                                        │
└───────────────────────────────────────────────────────────────────────────────┘
```

**Apps bind to installed integrations**, never to catalog entries or connections:

```jsonc
"integrations": [
  { "id": "jira-eu" },                                   // each user's own connection, all enabled actions
  { "id": "jira-eu", "actions": ["search", "get"] },     // subset
  { "id": "deepl", "connection": "shared:deepl-pro" },   // pre-selected shared connection
  { "id": "sharepoint", "capabilities": ["files"] }      // only the file picker, no model tools
]
```

`tools`, `sources`, `upload.cloudStorageUpload`, `websearch` keep working through a migration that rewrites them into `integrations` (see [04 · Architecture](04-architecture.md)).

## 6. Admin experience

### 6.1 Navigation

The sidebar section **Integrations** becomes the single home. Its items:

| Item | Route | Contents |
| --- | --- | --- |
| **Integrations** | `/admin/integrations` | Installed integrations (default tab) and **Catalog** tab (marketplace registries filtered to type `integration` + built-in catalog) |
| **Connections** | `/admin/integrations/connections` | All personal and shared connections, filter by user / integration; revoke; shared-connection CRUD |
| **Credentials** | `/admin/credentials` | unchanged (shared secrets), linked from shared connections |
| **Inbound** | `/admin/integrations/inbound` | MCP gateway, A2A card, Outlook add-in, browser extension, Copilot agent, Nextcloud embed, Teams: what connects *to* iHub |

"MCP servers", "A2A agents" and the eight hub cards disappear as separate pages; they are installed integrations with different protocols. The OAuth section under Access & Identity keeps clients and CIMD governance (that is identity, not integrations); its "Connections" tab (grants *to* iHub) moves under Inbound as "Connected apps".

### 6.2 Installed integrations (list)

```
Integrations                                              [Catalog]  [+ Add manually ▾]
──────────────────────────────────────────────────────────────────────────────────────
Search…            Protocol ▾   Auth ▾   Status ▾   Group ▾                   24 installed

 ●  Atlassian Jira & Confluence (EU)   MCP · per-user sign-in   engineering, support   ok · 2m   37 users   ⋯
 ●  SharePoint Online                  Native · per-user         all users              ok · 5m  412 users   ⋯
 ●  iFinder                            Native · SSO (JWT)        all users              ok · 1m      –      ⋯
 ◐  enaio DMS                          OpenAPI · service acct    legal                  degraded  –         ⋯
 ○  HubSpot                            MCP · per-user sign-in    –                      disabled  0 users   ⋯
 !  DeepL                              OpenAPI · shared key      all users              key expired         ⋯
```

Columns: status dot, name (+ instance label), protocol and auth type, allowed groups, health (last check), connected users, actions. Status values: `ok`, `degraded`, `error`, `auth required (admin)`, `disabled`. The same `DataTable` as Tools and Apps (`text-2xl` header, indigo accent), not another list style.

### 6.3 Catalog

```
Catalog                                                      Registries: iHub Official ✓  Examples ✓  Own ✓
──────────────────────────────────────────────────────────────────────────────────────
Search 1,034 integrations…        Category ▾   Sign-in ▾   Protocol ▾   Runs ▾   Verified ▾

Productivity (212)        Knowledge & DMS (48)        ERP & CRM (37)        Developer (190) …

┌──────────────────────────┐ ┌──────────────────────────┐ ┌──────────────────────────┐
│ [logo] Microsoft 365     │ │ [logo] d.velop documents │ │ [logo] Notion            │
│ Microsoft · verified     │ │ IntraFind · verified     │ │ Notion · partner         │
│ Mail, calendar, files,   │ │ Search, read, file-in    │ │ Pages and databases      │
│ Teams chat               │ │ into the e-Akte          │ │                          │
│ 🔑 per-user  📖 read+write│ │ 🔑 service  📖 read+write │ │ 🔑 per-user  📖 read+write│
│ ☁ cloud · 7 actions      │ │ 🏢 on-prem · 9 actions   │ │ ☁ cloud · 13 actions     │
│                 [Install]│ │             [Installed ✓]│ │                 [Install]│
└──────────────────────────┘ └──────────────────────────┘ └──────────────────────────┘
```

Card facts, always the same four: sign-in type (per-user / service account / none), effect (read / read+write), where it runs (cloud / on-prem / local), action count. Badges: verified (publisher verification from the registry), partner, community, **installed**, **update available**. Sources of the catalog: marketplace registries (`type: integration`), the built-in catalog shipped with iHub (today's `serverCatalog.js`, converted to the same format), and optionally the **public MCP registry** through a sub-registry adapter (read-only, flagged "community, not reviewed").

### 6.4 Detail and install

The detail panel (same slide-over as the marketplace) has tabs **Overview** (description, publisher, docs link, privacy policy, categories, screenshots), **Actions** (every action with effect badge and description; for MCP, from a live `tools/list` where possible, else from the catalog), **Setup** (what the admin will need: OAuth app in the vendor tenant, API key, URL), **Permissions** (declared scopes, data types touched), **Changelog**.

**Install** opens a wizard generated from the integration's install fields (the `ConfigField` type shared with MCPB `user_config`, registry input objects and elicitation forms):

```
Install  Atlassian Jira & Confluence                                        step 2 of 4
──────────────────────────────────────────────────────────────────────────────────────
1 Where     ● Cloud (EU)  ○ Cloud (US)  ○ Data Center  https://jira.example.com
2 Sign-in   ● Each user signs in with their Atlassian account (recommended)
            ○ Shared service account   credential: [select ▾]
            OAuth client: ● iHub default (CIMD)  ○ Our own app   client id ___  secret [ref ▾]
            ○ Enterprise-managed (no consent, via Okta/Entra)   [not available for this server]
3 Who       Groups: [engineering ×] [support ×] [+]          ☐ everyone
4 Policy    Actions: ☑ all 21   or pick…
            Writes:  ● ask the user each time  ○ allow  ○ block write and destructive actions
            Label:   Jira (EU)
                                                      [Test connection]  [Back]  [Install]
```

Rollout can be staged: *pilot groups first* (Microsoft's staged rollout, Glean's test groups), then everyone. Actions the server adds later get the instance's *new actions* policy (default *ask*) and a "new" badge in the Actions tab, so a vendor cannot slip a write tool past the admin (Microsoft resets changed tools to *needs approval*).

Test connection runs before save (MCP: discovery + `tools/list`; OpenAPI: a read probe; native: the connector's self-test) and reports in the existing `IntegrationTestResults` style. For per-user integrations the admin can "Connect my account" in the same dialog to verify end to end.

### 6.5 Installed integration page

Tabs: **Overview** (status, health history, endpoint, OAuth client, groups, label), **Actions** (toggle per action, effect, confirmation override, usage count), **Connections** (users connected, last used, revoke; shared connections for this integration), **Bindings** (which apps, workflows, scheduled tasks use it; the same `ContentAccessSection` style), **Audit** (filtered audit log), **Settings** (install fields, re-run wizard, update from registry, detach, uninstall).

### 6.6 Requests from users

Users can see the catalog entries their admin has not installed and press **Request**. The admin sidebar shows a count; the queue offers *approve* (opens the wizard), *decline*, *decline and hide*. This is what Claude and Microsoft do and it turns the catalog into a demand signal for which integrations to curate next.

### 6.7 Group permissions

`groups.json` gets `permissions.integrations: ["jira-eu", "sharepoint", "*"]`, resolved with inheritance like `apps` and `skills`. The installed-integration wizard writes it; `ContentAccessSection` edits it. An app that binds an integration the user may not use simply does not show it (same as skills today).

## 7. User experience

### 7.1 One place: Settings → Integrations

```
Integrations
──────────────────────────────────────────────────────────────────────────────────────
Available to you (9)                                              Search…   Category ▾

 [logo] Atlassian Jira & Confluence (EU)     ● Connected as daniel@…   expires in 29 days   [Disconnect]
 [logo] SharePoint Online                    ● Connected               files, search        [Disconnect]
 [logo] iFinder                              ● Signed in via SSO       nothing to do
 [logo] enaio DMS                            ● Service account         legal team · read+write
 [logo] HubSpot                              ○ Not connected           [Connect]
 [logo] DeepL                                ● Shared key              translate
 [logo] Microsoft 365                        ! Reconnect needed        new permission: mail   [Reconnect]

Access to iHub                                                            (unchanged section)
 Personal API keys · Connected apps · Outlook add-in
```

Every integration the user's groups allow is listed, whether or not it needs a sign-in. The status column tells the truth about identity: *connected as you*, *signed in via SSO*, *runs as service account*, *shared key*, *not connected*, *reconnect needed*. Each row opens a detail: what it can do (actions with effect badges), which apps use it, when it was last used, granted permissions in plain words.

### 7.2 In chat: the "+" menu becomes the integrations picker

```
 ┌──────────────────────────────────────────────┐
 │ 🔍 Search integrations…                      │
 ├──────────────────────────────────────────────┤
 │ Attach                                       │
 │   📎 Upload file     📁 SharePoint   📁 Drive │
 ├──────────────────────────────────────────────┤
 │ Use in this chat                             │
 │   ☑ Web search                               │
 │   ☑ iFinder                     read         │
 │   ☑ Jira & Confluence (EU)      read · write │
 │   ☐ enaio DMS                   read · write │
 │   ○ HubSpot          Connect →               │
 │   ☐ Image generation                         │
 ├──────────────────────────────────────────────┤
 │ Manage integrations…                         │
 └──────────────────────────────────────────────┘
```

Rules:

- The app decides the candidates (its bindings); the user decides which are on, per chat, with app defaults. The state moves from `localStorage` to the server (per user, per app) so it follows the user across devices and into scheduled tasks.
- A row shows one integration, never its 21 tools. The effect summary (`read · write`) is derived from the enabled actions.
- A not-connected per-user integration shows **Connect →** inline. Connecting opens the vendor consent in a new tab, returns to the *same chat*, and the row turns on. (Open WebUI's "return to a new chat" is the pitfall to avoid.)
- Active integrations show as small chips under the composer (logo + name), so the user sees what the model can reach before sending. Langdock's "blue = connected" cue, LibreChat's status icons.
- `@` in the composer searches the same list (and workflows, skills, prompts) for people who prefer typing.
- Apps with many integrations can run in **on-demand** mode (Claude's recommendation above ten connectors): deferred actions appear by name only and the model fetches and runs them through `search_tools` / `call_tool`, as proposed in [intrafind/ihub-apps#2889](https://github.com/intrafind/ihub-apps/issues/2889), instead of carrying every definition in every prompt.

### 7.3 Connect card

One component, one look, for every protocol. It replaces `IntegrationConnectionCard`, `McpConnectCard` and the Jira hook.

```
 ┌─────────────────────────────────────────────────────────────┐
 │ [logo] Connect Atlassian Jira & Confluence                   │
 │ To answer "what are my open tickets", iHub needs to act as   │
 │ you in Jira. You will sign in at atlassian.com.              │
 │ Permissions: read issues and pages · write comments          │
 │                              [Connect]   [Not now]           │
 └─────────────────────────────────────────────────────────────┘
```

After connecting, the failed call is retried automatically. For `reconnect needed` (expired, revoked, or a new scope), the card says why and what changes.

### 7.4 Confirmation card for writes

```
 ┌─────────────────────────────────────────────────────────────┐
 │ ✎ Jira · Add comment to ACME-12                   write      │
 │ ┌─────────────────────────────────────────────────────────┐ │
 │ │ Tested on staging, works. Moving to review.            │ │  ← editable
 │ └─────────────────────────────────────────────────────────┘ │
 │ Runs as daniel@… · in Jira (EU)                              │
 │              [Run]   [Edit]   [Skip]   ☐ Don't ask again for this chat │
 └─────────────────────────────────────────────────────────────┘
```

- Appears for `write` and `destructive` actions when the installed integration's policy says *ask* (the default). Memory is scoped: *once*, *for this chat*, and *always* only if the platform allows it (`allowAlways`, off by default). `destructive` never offers "don't ask again". Read actions never ask, which is what keeps approval fatigue away.
- The payload is shown as the user would understand it (rendered fields, not raw JSON), editable before running. Langdock's Preview/Source tabs for rich text.
- Admin policy per integration: *ask*, *allow*, *block writes*. Plus platform-wide glob rules like LibreChat's `deny: ["*:delete_*"]` for security officers.
- Headless runs (scheduled tasks, workflows) turn the card into a durable approval the owner answers in the task inbox, which `InteractionService` already supports.

### 7.5 Results

Unchanged: Answer Sources, citations, preview and download already come from one contract. MCP Apps views render inline as today. New: every tool activity row shows the integration logo and the effect it had ("read 3 issues", "commented on ACME-12").

## 8. Marketplace: integrations as a content type

- Catalog item `type: "integration"` next to app, model, prompt, skill, workflow. The content is one JSON (or a folder with icon and README) in the integration definition format ([04 · Architecture](04-architecture.md)).
- Install writes to `contents/integrations/<id>.json` (definition) and launches the install wizard for the instance; update, detach, uninstall work as for other types.
- The built-in catalog (`serverCatalog.js`) becomes a shipped registry file in the same format, so the two catalogs merge in the UI.
- Public MCP registry: an optional sub-registry adapter that maps `server.json` to our format on read, labelled community. Admins can turn it off (Dify's "restrict to marketplace" pattern).
- IntraFind's own registry carries the differentiating integrations: SharePoint on-prem, Confluence/Jira Data Center, iFinder MCP, d.velop, enaio, nscale, ELO, M-Files, Nextcloud, openDesk, SAP, DATEV, Personio. These are the ones no public directory has.

## 9. What stays special, on purpose

- **Inbound surfaces** (Outlook add-in, browser extension, Copilot agent, Nextcloud embed, Teams, MCP gateway, A2A card) are not integrations in this sense: nothing is installed or connected outbound. They get their own tab, "Inbound", with the same card layout, so admins still find them in one place.
- **Models and providers** stay under AI Workspace. iAssistant is a model adapter and stays a model.
- **Local stdio MCP servers** remain admin-only and are shown with a "runs on the iHub server" badge; they are never offered in the user catalog.
- **Sources** (filesystem, url, page) remain a knowledge feature. The `ifinder` source type and future "search" capabilities of integrations converge later (see [05 · Roadmap](05-roadmap.md)).

## 10. Decisions this concept asks for

1. **Vocabulary.** "Integration" for all of it, "Connection" for the user's credential, "Action" for a tool. Drop "MCP server" and "tool" from end-user UI.
2. **Default write policy.** *Ask* for everything with a write or destructive effect, for MCP and native alike. No exception for MCP (Langdock's inconsistency).
3. **Per-chat enabled state on the server**, not in `localStorage`.
4. **One nav section** named Integrations with Installed, Catalog, Connections, Inbound. MCP servers, A2A agents and the hub cards fold in.
5. **Marketplace type `integration`**, with the built-in catalog converted and the public MCP registry as an optional community source.
6. **Clean break for admin routes** (`/api/admin/mcp/servers`, `/api/admin/a2a/agents`) behind a migration, versus aliases: to decide with the team before implementation, per CLAUDE.md's breaking-change rule. User-facing OAuth callback routes stay stable so stored tokens keep working.
