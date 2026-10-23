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
| **Capability** | What an integration offers: `tools` (model-callable actions), `files` (browse and pick files), `search` (knowledge source), `views` (MCP Apps UI), `triggers` (events), `agent` (A2A). An integration declares one or more. Inbound surfaces are not capabilities; see section 9. | tools vs sources vs cloud storage picker vs MCP Apps |
| **Action** | One model-callable tool of an integration. It carries a **side effect** (`read`, `write`, `destructive`, `unknown`) and a **data flow** (`internal`: stays in systems the customer controls; `external`: leaves for a third party). Taken from MCP annotations, the OpenAPI method or the connector's declaration; the admin can override both. Every tool iHub offers to a model belongs to exactly one integration. | tool, tool function, MCP tool |
| **Built-in integration** | An integration that ships with iHub and cannot be uninstalled, only enabled, disabled and configured: iFinder, iAssistant, Web, iHub (ask the user, tasks, memory, evidence). | `server/defaults/tools/*.json` |
| **Custom integration** | An integration an admin builds on this iHub from an OpenAPI document, an MCP endpoint, an A2A card, an HTTP request or a script. | admin-created tools in `contents/tools/`, `mcpServers.json` entries added by hand |
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

1. **An integration owns its tools.** There is no separate list of tools. iFinder brings search, field discovery, document content and metadata; iAssistant brings chat; Jira brings search, read, comment and transition. The admin finds, configures, tests and documents every tool on its integration's page.
2. **One model, many protocols.** MCP, OpenAPI, native code, A2A and storage pickers are *wiring*. Catalog, install, enable, connect, pick, confirm and audit are shared.
3. **Delegated by default.** Actions run as the signed-in user wherever the system supports it. Shared credentials are explicit, admin-owned, and visible to the user as "runs as service account X".
4. **Admin enables, user connects, user picks.** Three separate decisions with three separate owners. An admin can never consent on a user's behalf; a user can never widen what the admin allowed.
5. **Writes need a human** unless the admin relaxes it per integration. The effect of every action is known before it runs.
6. **Progressive disclosure.** The catalog shows a name, a logo, a one-liner and three facts (sign-in type, read/write, where it runs). Everything else is one click deeper.
7. **Status is observed, not assumed.** Every installed integration has a last health check; every connection has an expiry.
8. **Distributable.** An integration is a file. It can be published in a registry, installed, updated, detached, like an app or a skill today.
9. **Standards first.** MCP authorization (RFC 9728, 8414, 8707, CIMD), MCP registry `server.json`, MCPB `user_config`, MCP Apps. Our own fields only where no standard exists (groups, policy, residency).

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

"MCP servers", "A2A agents", the eight hub cards **and the Tools page under AI Workspace** disappear as separate pages. MCP servers and A2A agents are installed integrations with different protocols; every shipped tool belongs to a built-in integration; every tool an admin created becomes a custom integration (section 6.8). The Installed list groups rows into **Built-in**, **From the catalog** and **Custom**. The OAuth section under Access & Identity keeps clients and CIMD governance (that is identity, not integrations); its "Connections" tab (grants *to* iHub) moves under Inbound as "Connected apps".

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

Rollout can be staged: *pilot groups first* (Microsoft's staged rollout, Glean's test groups), then everyone. Every action is fingerprinted (name, effect, input schema). Actions the server adds later get the instance's *new actions* policy (default *ask*) and a "new" badge in the Actions tab; an existing action whose fingerprint changes (a new effect, a changed schema) drops back to *ask* and is badged "changed" until an admin reviews it. A vendor cannot slip a write tool past the admin either way (Microsoft resets changed tools to *needs approval*).

Test connection runs before save (MCP: discovery + `tools/list`; OpenAPI: a read probe; native: the connector's self-test) and reports in the existing `IntegrationTestResults` style. For per-user integrations the admin can "Connect my account" in the same dialog to verify end to end.

### 6.5 Installed integration page

Tabs: **Overview** (status, health history, endpoint, OAuth client, groups, label), **Actions** (toggle per action, effect, confirmation override, usage count), **Connections** (users connected, last used, revoke; shared connections for this integration), **Bindings** (which apps, workflows, scheduled tasks use it; the same `ContentAccessSection` style), **Audit** (filtered audit log), **Settings** (install fields, re-run wizard, update from registry, detach, uninstall).

### 6.5a Action detail: what it does, how to use it, test it

Every action on the **Actions** tab opens a detail drawer. It is the one place where an admin understands a tool before switching it on, and the place to prove it works.

```
Jira (EU) › Actions › add_comment                                   write · external · ask
──────────────────────────────────────────────────────────────────────────────────────
What it does    Adds a comment to a Jira issue.                        [Edit model description]
Parameters      issueKey  string  required   ACME-12
                body      string  required   markdown
Approval        ● Inherit (ask on writes)  ○ Always ask  ○ Never ask      floor: platform default
How to use      Model guidance  "Use after the user asked to comment; quote the issue key."
                Example prompts "Add a comment to ACME-12 that staging passed."
                Used by         Engineering Assistant · Support Desk · Weekly sprint digest
Test            Run as  ● my connection (daniel@…)  ○ shared: support
                issueKey [ACME-12      ]  body [Test from iHub admin ]
                ☑ I understand this writes to Jira (EU)                  [Run test]
                ─ Result ─ 201 Created · 412 ms · 1 source: ACME-12 · request ▸ · response ▸
Usage           61 calls in 7 days · 3 rejected by users · last error: none
```

- **What it does**: the description and parameter schema exactly as the model sees them, with an admin override for the description (vendor descriptions are often written for developers, not models).
- **Side effect, data flow, approval**: badges and the per-action approval mode (section 7.4). An override is shown next to its source (vendor annotation, OpenAPI method, admin).
- **How to use**: model guidance that is added to the system prompt when the integration is active, example prompts that users see in their settings and in the chat picker, and the apps, workflows and scheduled tasks that bind this action.
- **Test**: a form generated from the parameter schema. Runs with the admin's own connection or a chosen shared connection, shows status, duration, the request as sent (secrets redacted), the raw response and the Answer Sources the result produced. A write or destructive test needs an explicit confirmation; every test run is written to the audit log as `action.test`. A test never runs the model; it calls the action directly.
- **Usage**: calls, approvals and rejections, errors, in the last 7 days.

The integration itself has the same three things one level up: **Instructions** (the MCP `instructions` or the connector's guidance, editable), **Test connection** (section 6.4), and a **Try in chat** button that opens a scratch chat with only this integration enabled.

### 6.6 Requests from users

Users can see the catalog entries their admin has not installed and press **Request**. The admin sidebar shows a count; the queue offers *approve* (opens the wizard), *decline*, *decline and hide*. This is what Claude and Microsoft do and it turns the catalog into a demand signal for which integrations to curate next.

### 6.7 Group permissions

`groups.json` gets `permissions.integrations: ["jira-eu", "sharepoint", "*"]`, resolved with inheritance like `apps` and `skills`. The installed-integration wizard writes it; `ContentAccessSection` edits it. An app that binds an integration the user may not use simply does not show it (same as skills today).

### 6.8 Custom integrations replace the Tools page

**Add manually** opens the integration builder. Its actions come from one of these:

| Source | Becomes | Replaces today |
| --- | --- | --- |
| OpenAPI document (URL, file or paste) | one action per selected operation; side effect from the HTTP method | OpenAPI tools (`type: "openapi"`) |
| MCP endpoint (remote) or command (stdio) | one action per tool from `tools/list` | MCP servers added by hand |
| A2A agent card | one action per skill | A2A agents |
| HTTP request | one action: method, URL template, headers, body template, response mapping | nothing today; the simplest way to wrap an internal REST endpoint |
| Script | one or more actions backed by a JavaScript module, edited in the existing script editor | script tools in `contents/tools/` + `server/tools/` |

The builder is Langdock's integration builder in iHub's terms: name, icon, auth, then actions, each with description, parameters, side effect, data flow and a test. A custom integration can be exported as a definition and published to a registry, which turns a one-off internal tool into something another iHub installation can install.

### 6.9 Built-in integrations

Today's shipped tools regroup into a handful of built-in integrations. They are always listed, never uninstalled, and configured like any other integration.

| Built-in integration | Actions (today's tools) | Other capabilities | Data flow |
| --- | --- | --- | --- |
| **iFinder** | search, discover, get content, get metadata, get fields, get facet values, list profiles (`iFinder_*`) | `search` and `files` for projects (`ifinder-document`, `ifinder-query` items), source provider for preview and download | internal |
| **iAssistant** | ask (a conversation turn as a tool) | `model`: iAssistant appears in the model selector as today | internal |
| **Web** | search (Brave, Staan, Qwant or the model's native search, chosen per installation), read page (`read_url`) | — | external |
| **Microsoft 365** | people search (`entraPeopleSearch_*`); later mail, calendar, files as actions | `files` picker for chat and projects (OneDrive, SharePoint, Teams files) | external (Microsoft cloud) |
| **Jira** | search, get issue, comment, transition, attachment (`jira_*`) | — | external or internal (Data Center) |
| **iHub** | ask the user, evidence, scheduled tasks, agent workspace (tasks, memory, inbox, artifacts) | — | internal |

Google Drive and Nextcloud become built-in integrations with the `files` capability on the same pattern. Tools that belong to another feature stay with it: skill tools with skills, `app__` tools with the app, `workflow_` tools with the workflow, `knowledge_*` tools with projects. The model still sees them; they are not configured on the Integrations page.

An action can need a different identity than its siblings, for example Microsoft 365 people search as the app (application permission) while files run as the user. The action declares the connection it needs; section 1.1 of [04 · Architecture](04-architecture.md) has the field.

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

Every integration the user's groups allow is listed, whether or not it needs a sign-in. The status column tells the truth about identity: *connected as you*, *signed in via SSO*, *runs as service account*, *shared key*, *not connected*, *reconnect needed*. Each row opens a detail: what it can do (actions in plain words with read/write badges and the admin's example prompts, "Ask: *what are my open Jira tickets?*"), which apps use it, when it was last used, granted permissions in plain words.

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

- The app decides the candidates (its bindings); the user decides which are on, per chat, with app defaults. Two levels of state, both on the server instead of `localStorage`: a per-user, per-app default (what a new chat starts with) and a per-chat override stored with the chat. A scheduled task or workflow snapshots its own set when it is created and never reads chat state, so switching an integration on in one chat cannot switch it on anywhere else.
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

After connecting, the call is retried automatically only when it failed *before* execution with `INTEGRATION_AUTH_REQUIRED` (no connection, expired, insufficient scope). A call that failed inside the adapter or on the transport is never retried on its own, because a write may already have happened; the model is told what failed and a write is re-run only through a fresh confirmation. For `reconnect needed` (expired, revoked, or a new scope), the card says why and what changes.

### 7.4 Approval card

The rules come from [intrafind/ihub-apps#2945](https://github.com/intrafind/ihub-apps/issues/2945), whose plan and decisions (2026-10-22) this concept adopts. The risk is not only writes: a *read* on an external integration can carry internal information out (search your own documents, then ask an external MCP server with what you found). So approval depends on the side effect **and** the data flow.

```
 ┌─────────────────────────────────────────────────────────────┐
 │ ✎ Jira (EU) · Add comment                  write · external │
 │   issueKey  ACME-12                                         │
 │   body      Tested on staging, works. Moving to review.     │
 │ Runs as daniel@… · Nothing is sent until you choose.        │
 │      [Approve]  [Approve & allow for this chat]  [Reject]   │
 └─────────────────────────────────────────────────────────────┘
```

- **Modes** per action: `never`, `writes` (ask when the side effect is not `read`), `always` (ask for every call, used for external reads that may leak). Resolution: platform default by data flow, then the integration's default, then the action's setting, then the app's binding. **Admin config is the floor; an app can only tighten it.**
- **Upgrade is opt-in.** Nothing changes for existing installations until an admin sets a platform default or a per-integration or per-action mode. The install wizard preselects *ask on writes* for new integrations and *always* for external ones whose actions carry no trusted annotations; the admin confirms or changes it.
- **Grants**: per call, and "allow for this chat". No persistent "always allow" in v1.
- **The card shows the exact arguments** as escaped text, tool and integration name, side effect and data flow. Any justification written by the model is labelled as such. Editing arguments before approving comes later, with schema re-validation.
- **On approve, the server runs the stored call itself.** The model does not re-issue it, so the user approves exactly what is sent. On reject or expiry the model gets `USER_REJECTED` or `APPROVAL_EXPIRED` as the tool result and carries on.
- **No human attached** (inference API, embeds that cannot render the card, workflow and agent nodes): the call is denied with `APPROVAL_REQUIRED_NO_USER`, unless a workflow node names approver groups; then the approval is parked for them. Scheduled tasks keep their existing approval flow.
- Later: taint-based gating that asks only when the chat already holds internal source data, which is the exact scenario #2945 describes.

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
- **Models and providers** stay under AI Workspace. iAssistant becomes a built-in integration that contributes a model (it still appears in the model selector) and an *ask* action.
- **Local stdio MCP servers** remain admin-only and are shown with a "runs on the iHub server" badge; they are never offered in the user catalog.
- **Knowledge** lives in projects, which replaced sources on 2026-10-22 (`docs/projects.md`). Integrations feed projects through their `files` and `search` capabilities (iFinder documents and queries, OneDrive, Google Drive and Nextcloud files); projects keep their own `knowledge_*` tools.

## 10. Decisions this concept asks for

1. **Vocabulary.** "Integration" for all of it, "Connection" for the user's credential, "Action" for a tool. Drop "MCP server" and "tool" from end-user UI. **Decided 2026-10-20 (Daniel Manzke): yes.**
2. **Approval policy.** ~~*Ask* for every write by default.~~ **Superseded 2026-10-22 by the decisions on [#2945](https://github.com/intrafind/ihub-apps/issues/2945):** opt-in at upgrade, modes `never | writes | always` per action with side effect and data flow, admin floor that apps can only tighten, grants per call and per chat, deny when no human is attached unless approver groups are named. The install wizard preselects *ask on writes* for newly installed integrations (section 7.4).
3. **Per-chat enabled state on the server**, not in `localStorage`. **Decided 2026-10-20 (Daniel Manzke): yes.** A per-user default per app, a per-chat override stored with the chat, and a snapshot per scheduled task or workflow (section 7.2).
4. **One nav section** named Integrations with Installed, Catalog, Connections, Inbound. MCP servers, A2A agents and the hub cards fold in.
5. **Marketplace type `integration`**, with the built-in catalog converted and the public MCP registry as an optional community source. **Decided 2026-10-20 (Daniel Manzke): yes.** Whether the public MCP registry is ever shown to customers stays open (roadmap question 6).
6. **Clean break for admin routes** (`/api/admin/mcp/servers`, `/api/admin/a2a/agents`) behind a migration, versus aliases. **Decided 2026-10-20 (Daniel Manzke): clean break, no aliases for the admin routes.** This is the explicit breaking-change call CLAUDE.md asks for; it covers the admin MCP and A2A routes and the `platform.jira` / `platform.cloudStorage` writes through `/api/admin/configs/platform`. User-facing OAuth callback routes stay stable so stored tokens and vendor-registered redirect URIs keep working.
7. **Integrations own their tools; the Tools page folds into Integrations.** Shipped tools regroup into built-in integrations, admin-created tools become custom integrations, every action has a detail with usage guidance and a test (sections 6.5a, 6.8, 6.9). **Direction set 2026-10-23 (Daniel Manzke).**
8. **Clean break for `/api/admin/tools`** (the Tools admin routes and pages) in the same way as decision 6, versus keeping them as an alias of custom integrations. **Open**: CLAUDE.md asks for an explicit call; recommendation is a clean break, since the migration turns every tool file into a custom integration.
