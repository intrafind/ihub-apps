# Features — Unreleased

## Installed Integrations: Install from a Catalog, Configure, Bind to Apps

**Admin → Integrations** is the first piece of the unified integrations platform
(epic #2911). An integration is a definition in a catalog; installing it creates an instance with
its own URL, sign-in mode and set of actions; apps bind instances and the model gets their actions
as tools. Which groups may use an installation is set on the groups (see below).

- **Catalog and install wizard:** the wizard is generated from the definition's install fields
  (URL, numbers, switches, choices, a secret), offers the sign-in modes the definition declares
  (no sign-in, or a shared service account whose token goes to the credential store), lets you
  choose the actions, and tests the connection before anything is saved. One definition
  can be installed several times.
- **Actions with guard rails:** each action carries its side effect (read, write, destructive).
  Install values are enforced on every call: a result cap the model cannot raise, a filter that
  is always added, a value the model cannot change.
- **Scopes:** when a definition declares scopes (for a data portal: the publishers), users pick
  one per chat like an iFinder search profile, and the pick binds the actions.
- **Cited answers:** a definition declares how results become sources, so every dataset or record
  an answer mentions is linked.
- **In apps:** **Admin → Apps → Edit → Installed integrations** binds an installation, narrows it
  to some actions and sets the default or pinned scope. An app is offered only while every
  installation it binds as **Required** (the default) exists and is enabled; **Admin → Apps**
  names a missing one. Switch **Required** off and the app stays available without that
  integration's actions while it is off. Web search is optional by default, since most apps work
  without it; its own **Required** switch hides the app instead.
- **Marketplace:** the new item type **Integrations** installs definitions from a registry. The
  official marketplace publishes the first one with an example app.
- **CKAN Open Data Portal** ships with iHub: search datasets, read licenses, publishers, coverage
  and the list of files with their formats and download links (the files' contents are not read
  in this release), query DataStore tables, on GovData, the German state and city portals,
  data.gov and internal CKAN catalogs. Tested against demo.ckan.org, GovData, Open-Data
  Schleswig-Holstein, open.canada.ca and data.boston.gov; data.europa.eu offers only the search.

See [Integrations](../../integrations.md).

## iFinder and iAssistant Are Installed Integrations

iFinder and iAssistant are the first two built-in integrations under **Admin → Integrations**, and no longer a block in `platform.json` or an editor on the Providers page.

- **One place for the connection:** the iFinder installation holds the base URL, the sign-in
  mode (iHub-signed JWT or OIDC token exchange), the signing key as a credential-store
  reference, the search-profile settings and the endpoint paths. The iAssistant installation
  runs on that connection and only adds its own defaults (profile, search profile, grounded
  answers).
- **Test before you save:** the install wizard runs the known iFinder diagnostics (reachability,
  signing key, token exchange, a search) on the unsaved draft, and the installed list tests a
  saved installation the same way.
- **Apps bind instead of listing tools:** an app binds the installation (`integrations.ifinder`)
  and picks actions by name; the seven tools keep their ids, so group grants and prompts that
  name `iFinder_search` and friends are unchanged. An iAssistant app binds `integrations.iassistant`.
  An app whose installation is missing or disabled is not offered, and **Admin → Apps** names it.
- **Migrated for you:** migration V192 moves the two platform blocks into installations (keeping
  their enabled state), rewrites the shipped and custom apps and retires `tools/iFinder.json`.
  Environment variables (`IFINDER_API_URL`, `IFINDER_PRIVATE_KEY`, `IASSISTANT_PROFILE_ID`)
  still apply.

## MCP Servers Are Installed Integrations

Outbound MCP servers are installed under **Admin → Integrations** like any other
integration, and no longer on a page of their own.

- **Catalog:** the hosted servers of the former built-in catalog (Microsoft Learn, Context7,
  GitHub, Atlassian, Stripe and some thirty more), draw.io and Excalidraw are shipped
  definitions with their endpoint and sign-in mode set. Any other server, including a local
  process, is installed from the generic **MCP server** definition (Streamable HTTP, SSE,
  WebSocket or stdio).
- **Sign-in:** no sign-in, a shared service account (bearer, header or basic), an OAuth client
  (client credentials) or per-user OAuth, with the secret in the credential store. Per-user
  servers show their connected users in a dialog, where an admin disconnects a user or resets
  iHub's client registration.
- **Actions are the server's tools:** the wizard lists them after **Test connection**, single
  tools can be switched off, and the installed list shows whether the server is reachable and
  how many tools it offers.
- **Apps bind the installation** in **Admin → Apps → Edit → Installed integrations**, optionally
  narrowed to some tools, and are offered only while it exists and is enabled. Tool ids
  (`drawio__create_diagram`) and group grants are unchanged.
- **Migrated for you:** migration V193 moves every server of `mcpServers.json` into an
  installation under the same id; per-user sign-ins and OAuth client registrations stay valid.

## Remote A2A Agents Are Installed Integrations

Remote agents (Agent-to-Agent protocol) are installed from the **A2A agent** definition under
**Admin → Integrations**, and no longer on a page of their own.

- **One wizard:** Agent Card URL, sign-in (none, a shared token or API key, or an OAuth client)
  and the call budget; **Test connection** fetches the card and lists the skills, each of which
  can be switched off. The installed list shows whether the card could be read.
- **Apps bind the agent** in **Admin → Apps → Edit → Installed integrations**, optionally
  narrowed to some skills; tool ids (`a2a__<id>__<skill>`) and group grants are unchanged.
- **Migrated for you:** migration V194 moves every agent of `a2aAgents.json` into an
  installation under the same id.

## Integrations Can Bring Their Own Code

A definition in a registry may ship a connector module (`"protocol": { "type": "script",
"module": "connector.js" }`) with the same contract as iHub's built-in connectors, so an
integration that no OpenAPI document can express (Jira, Microsoft 365 and the like) can be
published through a registry instead of only built in. Two guard rails: a registry delivers such
an integration only when an admin marked it as **trusted for code** (**Admin → Marketplace →
Manage Registries**), and the catalog must carry a hash for the code file, which the install
checks. The Catalog tab and the install wizard say when an integration runs code on the server.

A connector is one bundled file: the module named in the definition is the only code file the
folder may carry and imports nothing from the folder (esbuild or rollup bundle a multi-file
connector before it is published). The install refuses a second code file or a relative import
with a clear message. The reason is that an update from the Marketplace reloads the entry module
only; a helper file would keep running its old code until a restart. Updating a code-based
integration takes effect at once, for its actions and for the scopes it offers in the chat.

## Web Search Is an Installed Integration

The search engines and the page reader are the built-in integration **Web search** under
**Admin → Integrations**, and no longer a category on the Providers page.

- **One place for the engines:** the installation `websearch` holds the Brave and Staan API keys
  as credential references and the **default search engine** every app on `auto` uses. The groups
  granted the installation may search — the grant holds for native search on Google, OpenAI and
  Anthropic models too, so a user without it gets no web search on any model. Qwant still needs
  no key.
- **Test:** the installation's **Test** reports which engines have a key and runs one live search
  with the default engine, with the same verdicts and hints as the former connectivity test.
- **Apps unchanged:** an app still switches web search on in its own settings and may name an
  engine; the tools keep their ids (`braveSearch`, `staanSearch`, `qwantSearch`, `read_url`). An
  app with web search on is offered only while the installation is enabled, and **Admin → Apps**
  names it when it is missing.
- **Migrated for you:** migration V195 moves the provider keys into credentials, creates the
  installation and retires the four tool files. `BRAVE_SEARCH_API_KEY` and `STAAN_API_KEY` still
  apply when no credential is referenced.

## Jira Is an Installed Integration

Atlassian Jira is the built-in integration **Atlassian Jira** under **Admin → Integrations**, and no longer a page of its own.

- **One place for the OAuth app:** the installation `jira` holds the client id, the client secret
  as a credential reference, the redirect URI and the site URL; **Test** checks them and the route
  to `auth.atlassian.com`, and **Connections** lists the users who connected their Atlassian
  account and disconnects one. The redirect URI may stay empty: it is then derived from each
  request (scheme, host and base path as the browser sees them), and **Test** shows the resulting
  URL to register. The "users connected" count follows connects and disconnects as they happen.
- **Apps bind instead of listing tools:** an app binds `integrations.jira` and picks actions by
  name; the six tools keep their ids (`jira_searchTickets` and friends). An app that binds Jira is
  offered only while the installation is enabled, and the groups' integration grants decide who may
  use it.
- **Users connect as before:** the "Connect to Jira" prompt in the chat and **Settings →
  Integrations** are unchanged, and existing connections keep working.
- **Migrated for you:** migration V196 moves `platform.jira` into the installation (keeping its
  enabled state), retires a hand-written tool file for `tools/jira.js` and rewrites `tools: ["jira"]`
  into the binding.

## Entra ID Directory Is an Installed Integration

The Microsoft Entra ID people search is the built-in integration **Microsoft Entra ID directory**
under **Admin → Integrations**, instead of a tool configured through environment
variables alone.

- **Configured in the admin UI:** the installation `entra` holds the tenant id, the application
  (client) id and the client secret as a credential reference; `AZURE_TENANT_ID`,
  `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` still apply when a field is empty. **Test**
  acquires a token with the client credentials and lists one user, with hints when Graph refuses.
- **Apps bind instead of listing tools:** an app binds `integrations.entra` and picks actions by
  name; the six tools keep their ids (`entraPeopleSearch_findUser` and friends). An app that
  binds the directory is offered only while the installation is enabled, and the groups'
  integration grants decide who may use it.
- **Migrated for you:** migration V197 creates the installation (enabled when the three variables
  were set), retires `tools/entraPeopleSearch.json` and rewrites `tools: ["entraPeopleSearch"]`
  into the binding.

## Integrations Carry a Version, Compatibility and Release Notes

An integration definition now says which iHub versions it runs on and what changed between its
versions, so the marketplace can tell you before you install or update anything.

- **Compatibility:** a definition declares the iHub version range it needs. The marketplace greys
  an item this server cannot run and says why ("needs iHub >=6.0.0, this server runs 5.7.2");
  **Install** and **Update** are disabled, and the API refuses them too. A definition already on
  disk that no longer matches (after a downgrade, or copied in by hand) is listed under **Admin →
  Integrations** as **Incompatible** with the reason; its installations stay as they
  are but offer no actions until the definition fits again.
- **Release notes:** every version of a definition has a date, a one-line summary and Markdown
  notes per category (features, fixes, breaking changes). The marketplace detail of an integration
  gets a **Releases** tab that opens each release's notes on request, and the **Update** dialog
  lists what changed between your installed version and the catalog version before you confirm.
- **Versions in the admin UI:** the installed list shows each installation's definition version and
  an **Update to vX available** badge when the catalog it came from offers a newer compatible
  version; the admin dashboard counts the installations with an update waiting.
- **Shipped definitions** declare their compatibility and carry a 1.0.0 release whose notes
  describe what the config migrations of this release did (iFinder, iAssistant, web search, Jira,
  Entra ID directory, MCP servers, A2A agents, CKAN).

See [Integrations → Version, compatibility and release notes](../../integrations.md#version-compatibility-and-release-notes)
and [Marketplace](../../marketplace.md).

## People Directories Are Installed Integrations

LDAP people directories — the company directory and external ones such as x500.bund.de — are
installations of the built-in integration **LDAP people directory** under **Admin → Integrations**, one installation per directory, and no longer a page of their own.

- **One wizard per directory:** the install wizard holds everything the directory editor had —
  reuse an LDAP sign-in provider or connect directly, access (anonymous or a service account whose
  password is a credential), preset and mapping, units, data flow, limits, trusted certificates and
  the admin **LDAP browser**. **Test connection** runs the known directory test, and a field next to the button takes
  a surname for the sample search. **Use for people search** on an LDAP sign-in provider opens the
  wizard with the provider selected.
- **Same tools, same ids:** every directory keeps its id, so `<id>__search_people`,
  `<id>__get_person`, `<id>__list_units` and the browser's `<id>__browse_*` tools, group grants
  and audit records are unchanged. The installed list shows the transport (LDAPS, StartTLS, plain
  text) and marks external directories.
- **Bind one or all:** an app binds one directory like any installation, or **All LDAP people
  directory installations** — the new definition binding `"integrations":
  { "com.intrafind/ldap-directory": {} }`, which follows directories installed later. The app
  editor offers that row for every integration installed more than once. Actions such as the LDAP
  browser are bound only when named, never as part of "every action".
- **Migrated for you:** migration V198 moves every directory of `peopleDirectories.json` into an
  installation (bind passwords stay credential references), rewrites the shipped People search
  and LDAP browser apps and every app that listed `peopleDirectories` or a directory, and keeps
  `ldapBrowse` references working.

See [People Directory Search](../../people-directory-search.md).

## iHub's Own Tools Are the Always-Installed iHub Integration

`ask_user`, the project knowledge tools, artifacts, agent memory, inboxes and tasks, the evidence
tools and the scheduled-task tools are the actions of the built-in integration **iHub**
(installation `ihub`) under **Admin → Integrations**, instead of tool files.

- **Always there:** the installation exists and is enabled at all times — it is created when
  missing and shows **Always installed** without a remove or disable switch. Edit it to switch
  single actions off for every app (what `enabled: false` on a tool file did); which groups may
  use it is granted on the groups.
- **Nothing changes for apps:** the tools keep their ids, so `tools: ["ask_user"]`,
  `["knowledge"]`, `["write_artifact"]` and group grants work as before; the rules for
  `ask_user` (kept through a chat's tool narrowing) and the scheduled-task tools are unchanged.
  Every action carries its side effect (read, write, destructive).
- **Migrated for you:** migration V199 removes the shipped tool files from `contents/tools/`
  (a file an admin edited is kept, with a warning) and creates the installation. **Admin → Tools**
  lists only custom tools from now on.

## Storage Providers Are Installed Integrations, Several per Provider, Bound per App

Office 365 (OneDrive / SharePoint / Teams), Google Drive and Nextcloud are the built-in storage
providers **Microsoft Office 365**, **Google Drive** and **Nextcloud** under **Admin →
Integrations**, and no longer three pages of their own with a shared provider editor.

- **Several installations per provider:** install a provider as often as needed — one per Azure
  app registration or tenant, per Google OAuth client, per Nextcloud server. Each installation has
  its own OAuth app, settings, connected users and group grant, and users see each one under its
  label. The installation id is the provider id in the callback URL and in the users' stored
  connections.
- **Bound per app:** **Admin → Apps → Edit → Integrations → Storage providers** offers **All
  storage providers**, **All … installations** of one provider, or single installations. The
  chat's cloud file picker offers the providers the app binds and the user's groups grant; the
  **Cloud Storage Upload** switch of the upload settings is gone.
- **A dedicated editor per provider:** the **Settings** tab of an installation shows the redirect
  URI to register — derived with the base path, with a **Copy** button and where to register it
  (Azure portal, Google Cloud console, Nextcloud) — then the tenant or server URL, client id and
  client secret credential, the sources (with the Microsoft Graph permissions each one needs) and
  Office 365's site and drive restrictions, how many users connected, and **Test connection** on
  the unsaved values. Tiles show the tenant id, the Nextcloud server, the sources and whether the
  client secret is set.
- **Redirect URI with the base path:** an empty redirect URI is derived from each request
  including the base path (as for Jira), so iHub under `/ihub` sends
  `https://<host>/ihub/api/integrations/<provider>/<installation id>/callback`.
- **Nothing changes for connected users:** existing connections, registered redirect URIs, project
  cloud documents and the Nextcloud embed plugin keep working. Migrations V200 and V205 move the
  `platform.cloudStorage` providers into installations under the ids they had — a second provider
  of one type included — restore an Office 365 tenant id the first migration could not read, clean
  up the old tenant id credentials and bind every storage provider in the apps that had cloud
  storage switched on.

See [Integrations → Built-in integrations](../../integrations.md#built-in-integrations) and
[Apps → Files from storage providers](../../apps.md#files-from-storage-providers).

## Groups Decide Which Integrations Their Members May Use

Admins grant installed integrations per group, like apps: **Admin → Groups → a group →
Integrations** lists every installation, grouped like the Integrations page (people directories,
web search, storage providers, MCP servers, agents, built-in, from the catalog). In `groups.json`
the list is `permissions.integrations`.

- **All, one, a kind or a definition:** **All integrations** (`*`) includes ones installed later;
  **All people directories**, **All web search engines** and **All storage providers**
  (`type:people-directory`, `type:web-search`, `type:storage`) grant every installation of that
  kind; a definition with several installations has an **All … installations** row; or tick
  single installations.
- **Inherited like apps:** a group gets what the groups it inherits grant; the editor shows those
  rows ticked and greyed out with the group they come from ("via users").
- **Everywhere the integration is used:** chat, workflows, scheduled tasks, direct tool runs, the
  MCP and A2A gateways, web search (native search included) and the LDAP people directories hold
  to the grant. Storage providers do too: users see, connect, browse and import only from the
  providers their groups grant.
- **Tokens and API keys:** a token acting for a user and a personal API key keep the user's grant;
  a machine OAuth client may use what the apps it is allowed to use bind.
- **Shipped groups:** `admins`, `users` and `authenticated` may use every integration; `anonymous`
  may use iHub's own tools and web search.

See [Integrations → Who may use an integration](../../integrations.md#who-may-use-an-integration).

## Integrations: One Admin Page, Grouped Tiles and a Page per Installation

**Admin → Integrations** is one page with the tabs **Installed**, **Catalog** and **Inbound**.
Installations and catalog definitions are grouped (people directories, web search, storage
providers, MCP servers, agents, built-in, from the catalog), and each installation is a tile that
shows what matters at a glance.

- **Tiles:** label, definition, version, enabled or disabled, update available, incompatible,
  live status (connected, unreachable, connected users), sign-in mode, groups and two to four key
  facts of its settings — the iFinder base URL and sign-in, a directory's URL and base DN, the
  Nextcloud server, which web search keys are set. A secret only ever shows as set or not set.
  Test, enable or disable, remove and the connected users stay one click away on the tile.
- **A page per installation:** a tile opens `/admin/integrations/<id>` with **Overview** (facts,
  actions with their side effects, documentation link and the apps that bind it), **Settings**
  and, where the definition has a history, **Releases**.
- **iFinder and iAssistant get their editor back:** the Settings tab of the two installations is
  the well-structured editor they had on the Providers page — token issuer, OIDC key pair with the
  iFinder settings to copy, token exchange, search profiles — and tests the unsaved values. Other
  installations use the form generated from their definition.
- **Inbound** lists what connects to iHub: Outlook add-in, browser extension, Microsoft 365
  Copilot, Nextcloud embed and the MCP gateway, each with its status.
