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

## Web Search Engines Are Installed Integrations

Each web search engine is an integration of its own under **Admin → Integrations → Web search** —
**Brave Search**, **Staan** and **Qwant** — installed only where it is wanted, and no longer a
category on the Providers page.

- **Native search needs no engine:** an app with web search on searches with the model's own
  search on Google, OpenAI and Anthropic models even while no engine is installed (a fresh
  install ships none), with the page reader next to it on OpenAI and Anthropic. An engine is
  needed only for the other models; on those, the chat offers the web search toggle only while
  an engine is available.
- **Pick the engine per app:** the **Web Search** panel of the app editor, now on every chat app,
  lists **Auto** and the installed engines, marks a disabled one, and warns when the app names an
  engine that is not installed. Auto takes the first engine the user may use: Brave, Staan, Qwant,
  then any other.
- **An editor per engine:** the API key as a credential with the environment variable it falls
  back to (`BRAVE_SEARCH_API_KEY`, `STAAN_API_KEY`), and **Test connection** with the values as
  entered: where the key comes from, then one live search with the verdicts and hints of the
  former connectivity test. The tiles show whether the key is set; Qwant needs none.
- **Who may search:** the groups grant engines like any integration — one engine, or **All web
  search engines** (`type:web-search`).
- **Your own engine:** a `script` or OpenAPI definition of type `web-search` with one action
  `search` is an engine like the shipped ones (see
  [Building an Integration](../../integration-development.md#web-search-engines)).
- **Tools keep their ids:** `braveSearch`, `staanSearch`, `qwantSearch` and the page reader
  `read_url`; a workflow node's generic `webSearch` uses the first engine the user may use on
  models without native search.
- **Migrated for you:** migrations V195 and V204 move the provider keys into credentials and
  install one engine per key, and Qwant where it was reachable. `BRAVE_SEARCH_API_KEY` and
  `STAAN_API_KEY` still apply when no credential is referenced.

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

## Integrations Carry a Version, Compatibility, Release Notes and Migrations

An integration definition now says which iHub versions it runs on and what changed between its
versions, so the marketplace can tell you before you install or update anything, and a new version
brings your installations along by itself.

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
- **Migrations:** a release that renames an install field or an action, removes one, or needs a
  new value ships a migration. iHub runs it for every installation of the definition — on a
  marketplace update, and at the server start for the built-in integrations an iHub release
  updated — and rewrites the installation's settings, its action selection and the apps that bind
  it. A backup is made first under `contents/backups/integrations/`; a step that would overwrite
  something stops the migration instead, before anything is written.
- **Update preview:** the marketplace update dialog of an integration says per installation how
  many install values, actions and app bindings the update changes ("This update changes 2 install
  values and 1 action of GovData; a backup is made first."), which apps lose an action, which
  installation's migration will fail and stay on its version until you act, and which one is
  planned only once the update is downloaded. After the update it reports every installation as
  migrated or failed with the reason, each with a link to its page.
- **Nothing half-migrated:** an installation whose migration fails keeps its settings, offers no
  actions and says why; an admin re-runs the migration, restores the backup (for a marketplace
  update, together with the previous package) or uninstalls it. One that waits for a migration
  offers no actions until it ran, and one without a known version (written by hand) waits for an
  admin to restore a backup or adopt the current version. Each installation keeps a log of its
  last ten migrations.
- **Migrations in the admin UI:** the installation's tile carries an amber **Migration pending** /
  **Needs review** or a red **Migration failed** pill with the reason as text and the buttons of
  that state. The installation's page shows what a pending migration changes before you click
  **Migrate now**, and offers **Re-run migration**, **Restore backup**, **Adopt current version**
  and **Uninstall** where they apply — restoring, adopting and uninstalling ask first. Each action
  shows the log entry it wrote or the reason it failed. While an installation waits for a
  migration, failed or needs a review, its settings are shown read-only; the **Migration log** on
  the Overview tab lists every run with versions, date, admin, result, warnings and steps.
- **Apps warnings:** **Admin → Apps** and the app editor's Integrations section warn on an app
  whose bound action a migration removed, or whose type binding still names a renamed action or
  scope, next to the binding concerned.

See [Integrations → Version, compatibility and release notes](../../integrations.md#version-compatibility-and-release-notes),
[Integrations → Migrations](../../integrations.md#migrations) and [Marketplace](../../marketplace.md).

## People Directories Are Installed Integrations

LDAP people directories — the company directory and external ones such as x500.bund.de — are
installations of the built-in integration **People directory (LDAP)** under **Admin →
Integrations**, one installation per directory, and no longer a page of their own.

- **One wizard per directory:** the install wizard holds everything the directory editor had —
  reuse an LDAP sign-in provider or connect directly, access (anonymous or a service account whose
  password is a credential), preset and mapping, units, data flow, limits and trusted certificates
  (the admin **LDAP browser** is an integration of its own now, see below). **Test connection** runs the known directory test, and a field next to the button takes
  a surname for the sample search. **Use for people search** on an LDAP sign-in provider opens the
  wizard with the provider selected.
- **Same tools, same ids:** every directory keeps its id, so `<id>__search_people`,
  `<id>__get_person`, `<id>__list_units`, group grants and audit records are unchanged. The installed list shows the transport (LDAPS, StartTLS, plain
  text) and marks external directories.
- **Bind one or all:** an app binds one directory like any installation, every LDAP directory
  with the definition binding `"integrations": { "com.intrafind/ldap-directory": {} }`, or every
  people directory with **All people directories** (`"type:people-directory": {}`), which
  follows directories installed later.
- **Migrated for you:** migration V198 moves every directory of `peopleDirectories.json` into an
  installation (bind passwords stay credential references) and rewrites the shipped People search
  and LDAP browser apps and every app that listed `peopleDirectories` or a directory.

See [People Directory Search](../../people-directory-search.md).

## Asking the User and Scheduled Tasks Are the Always-Installed iHub Integration

`ask_user` and the scheduled-task tools (`schedule_task`, `list_scheduled_tasks`,
`update_scheduled_task`, `delete_scheduled_task`, `run_scheduled_task_now`, `list_task_runs`,
`get_task_run`) are the actions of the built-in integration **iHub** (installation `ihub`) under
**Admin → Integrations**, instead of tool files.

- **Always there:** the installation exists and is enabled at all times — it is created when
  missing and shows **Always installed** without a remove or disable switch. Edit it to switch
  single actions off for every app (what `enabled: false` on a tool file did); which groups may
  use it is granted on the groups.
- **Nothing changes for apps:** the tools keep their ids, so `tools: ["ask_user"]`,
  `["schedule_task"]` and group grants work as before; the rules for `ask_user` (kept through a
  chat's tool narrowing) and the scheduled-task tools are unchanged. Every action carries its
  side effect (read, write, destructive).
- **Project knowledge works whenever projects are on:** `knowledge_search`, `knowledge_read` and
  `knowledge_list` belong to projects, not to an integration. Every request that reaches a project
  gets them while the projects feature is on, whatever the app's `tools` or an installation says.
- **Agent and evidence tools stay with workflows and agents:** artifacts, agent memory, inboxes
  and tasks and the evidence tools are not listed under the iHub integration. Workflows, agent
  profiles and apps name them in `tools` as before, and group grants select them.
- **Migrated for you:** migrations V199 and V202 remove the shipped tool files from
  `contents/tools/` (a file an admin edited is kept, with a warning) and create the installation.
  **Admin → Tools** lists only custom tools from now on.

## Marketplace: Integration Cards Show Sign-in, Effect, Where It Runs and Actions

An integration in **Admin → Marketplace** now shows what it does before you install it: the card
lists four fixed facts, and the details list every action the definition declares.

- **Four facts on every integration card:** the sign-in modes, the effect (**read** or **read ·
  write**), where it runs (cloud, on-premises, local) and the number of actions (**listed by the
  server** for an MCP server or A2A agent).
- **Actions in the details:** each declared action with its effect (read, write, destructive) as a
  badge, under **Integration facts**.
- **No local processes from a registry:** an integration item that would start a local MCP
  process (`stdio`) is left out of the catalog when it is refreshed, and the server log names the
  registry, the item and the reason. Install refuses it as before.

See [Marketplace](../../marketplace.md).

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
  cloud documents and the Nextcloud embed plugin keep working. Migrations V200 and V206 move the
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
  MCP and A2A gateways, the web search engines and the LDAP people directories hold to the grant
  (native web search on the model needs no grant). Storage providers do too: users see, connect, browse and import only from the
  providers their groups grant.
- **Tokens and API keys:** a token acting for a user and a personal API key keep the user's grant;
  a machine OAuth client may use what the apps it is allowed to use bind.
- **Shipped groups:** `admins`, `users` and `authenticated` may use every integration; `anonymous`
  may use iHub's own tools and every web search engine.

See [Integrations → Who may use an integration](../../integrations.md#who-may-use-an-integration).

## Integrations: One Admin Page, Grouped Tiles and a Page per Installation

**Admin → Integrations** is one page with the tabs **Installed**, **Catalog** and **Inbound**.
Installations and catalog definitions are grouped (people directories, web search, storage
providers, MCP servers, agents, built-in, from the catalog), and each installation is a tile that
shows what matters at a glance.

- **Tiles:** label, definition, version, enabled or disabled, update available, incompatible,
  live status (connected, unreachable, connected users), sign-in mode, groups and two to four key
  facts of its settings — the iFinder base URL and sign-in, a directory's URL and base DN, the
  Nextcloud server, whether a web search engine's key is set. A secret only ever shows as set or
  not set.
  Test, enable or disable, remove and the connected users stay one click away on the tile.
- **A page per installation:** a tile opens `/admin/integrations/<id>` with **Overview** (facts,
  actions with their side effects, documentation link and the apps that bind it), **Settings**
  and, where the definition has a history, **Releases**.
- **iFinder and iAssistant get their editor back:** the Settings tab of the two installations is
  the well-structured editor they had on the Providers page — token issuer, OIDC key pair with the
  iFinder settings to copy, token exchange, search profiles — and tests the unsaved values. The
  web search engines have an editor of their own; other installations use the form generated
  from their definition.
- **Inbound** lists what connects to iHub: Outlook add-in, browser extension, Microsoft 365
  Copilot, Nextcloud embed and the MCP gateway, each with its status.

## People Search Uses Every People Directory, Entra ID Included

The LDAP directory integration is now called **People directory (LDAP)** (German:
**Personenverzeichnis (LDAP)**), and it shares the **People directories** group with the
**Microsoft Entra ID directory** on the Integrations page and in the app editor: both are people
directories.

- **People search follows Entra ID:** the shipped **People search** app binds every people
  directory (`"type:people-directory": {}`) instead of only the LDAP ones. With the Entra ID
  directory enabled, users find people there too, and the app is offered as soon as any people
  directory is enabled. Its instructions know the Entra tools.
- **Migrated for you:** migration V205 rewrites an existing People search app that still has the
  binding it got in V198. A customised binding is left alone.

See [People Directory Search](../../people-directory-search.md).

## Scheduled Tasks and Workflows Keep Their Search Profile

A scheduled task now searches where it was set up to search. It keeps the iFinder search profile
and the iAssistant of the chat it was scheduled from, or the ones picked on its form, and every
run uses them, even after the chat moved to another profile.

- **Task form:** **Where to search** shows the same choices as the chat's **+** menu and lets the
  owner change them. A profile the owner may not use is refused on save.
- **Every run** checks the profile again. One the owner lost fails the run with an error naming
  it, instead of quietly searching somewhere else.
- **Workflows:** an agent or tool step can bind its iFinder tools to a profile with
  `integrationScopes`, fixed or from a workflow input; the model cannot pick another one.
- Tasks saved before keep running as they did: without a stored profile, they search the
  default.

## LDAP Browser Is an Integration of Its Own

The admin LDAP browser — ask about a directory in plain words and see the raw entries — is the
new built-in integration **LDAP browser**, separate from people search. Install it under
**Admin → Integrations → Catalog**, once for every directory admins should be able to read.

- **Reuses a directory:** an LDAP browser names a People directory (LDAP) installation and uses
  its connection — URL, TLS settings, trusted certificates, allowed hosts, base DN and bind
  account — with its own browse base, result limit, attributes to withhold and, optionally, a
  read-only account of its own.
- **Granted like any integration:** who may browse is the browser's grant under **Admin → Groups →
  Integrations**. Only signed-in users browse; personal API keys, OAuth clients and agents never
  do, the browser is never offered over the MCP gateway, and every call is audited.
- **Bound like any integration:** an app binds one browser or every browser
  (`com.intrafind/ldap-browser`); a binding without actions binds all three browse tools. The
  shipped **LDAP browser** app binds every browser and still ships disabled.
- **Migrated for you:** migration V205 creates a browser installation for every directory that
  had the browser switched on and grants it to the groups that could browse.

See [People Directory Search → LDAP browser](../../people-directory-search.md#ldap-browser-for-admins).

## Integrations: Dedicated Editors for People Directories, the LDAP Browser and Entra ID

The **Settings** tab of these installations is a dedicated editor instead of the generic form.

- **People directory (LDAP):** the directory editor from before directories became integrations
  is back — model-facing name and description in English and German with a preview of what the
  model sees, source (reuse an LDAP sign-in provider or connect directly), access, network with
  the transport, plain text, allowed hosts, trusted certificates and TLS versions, visibility with
  the groups that grant the directory, limits, search and mapping with the preset's value next to
  every field, and a sample search next to **Test connection**.
- **LDAP browser:** pick the directory and see what the browser takes over from it, then set the
  browse base, result limit, account and withheld attributes.
- **Microsoft Entra ID directory:** tenant ID, application ID and client secret, each saying
  whether the `AZURE_*` environment variable it falls back to is set on the server. Tenant ID and
  application ID may now be left empty to use that fallback.
- **Tiles:** an LDAP browser shows its directory, browse base and account; a directory shows its
  directory type.

See [Integrations → Editors](../../integrations.md#editors).

## Sources Panel: Where Each Document Was Found

The sources panel under an answer now says where each document came from. Every iFinder card
names the search profile it was found in by its display name ("Contracts"), and the panel header
says where the answer searched (**Searched in Contracts**) or which iAssistant it asked
(**Asked HR assistant**).

- **iAssistant over all search profiles:** each document names the profile iFinder reports on it.
- **Several profiles in one answer:** the panel can show one profile at a time.
- **Reopened chats:** the labels are stored with the answer, so they show the same after reopening.
- The names come from the same per-user list as the search profile picker; a profile whose name
  is unknown shows its id. Shared chats leave the labels out, like the documents themselves.
