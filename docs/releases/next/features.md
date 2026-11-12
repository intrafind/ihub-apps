# Features — Unreleased

## Workers and Their Memory Follow the Container's Memory Limit

In a container with a memory limit, iHub no longer starts four workers that each size their memory as if they
had the whole container to themselves. When `WORKERS` (or `NUM_WORKERS`) is not set, the server starts as
many workers as fit into the memory limit (768 MB each after 160 MB for the primary), at most one per CPU and
never more than four, and gives each worker a heap limit of its share, so memory is reclaimed before the
container is killed. A 2 GB container now runs 2 workers instead of 4; a 1 GB container runs a single process.
Without a memory limit nothing changes (4 workers).

An explicit `WORKERS` and an explicit `--max-old-space-size` in `NODE_OPTIONS` still win. The decision is
logged at startup ("Worker sizing: …"), and the container start banner no longer claims a worker count the
server does not use. See [Scaling with Multiple Workers](../../scaling.md#sizing-from-the-container).

## Interactive Artifacts Can Use Chart and UI Libraries

HTML artifacts — the interactive pages, dashboards and calculators the `web-artifacts` skill builds — can now
load libraries such as Chart.js, D3, Leaflet or Tailwind from a CDN, so charts drawn with them no longer stay
blank in the preview.

- **Allowlisted CDNs only.** Scripts and stylesheets load over https from `cdnjs.cloudflare.com`,
  `cdn.jsdelivr.net` and `unpkg.com`. Everything else stays blocked: no `fetch`, no remote images or fonts.
- **Admins decide.** Change the list in Admin → Platform Configuration (`artifacts.scriptHosts`), for example to
  an internal mirror; `[]` keeps the preview fully offline, as before.
- **Light and dark.** Artifacts now follow iHub's own light/dark switch instead of the operating system's.
- **Fewer broken artifacts.** Before you see the result, iHub checks that the page's JavaScript parses and that
  the file was not cut off, and has the model fix it.

## A Calmer Chat Input: Chips Collapse to Icons

The chips under the chat input — web search, projects and connected systems — took a lot of room, and
with several switched on they ran over each other and the model selector. They now show an icon only.

- **Labels on hover.** The name of a chip (and the × to remove it) appears when you point at it or tab
  to it; a tooltip and the screen-reader name stay the same.
- **No more overlap.** When more chips are active than fit, the rest fold into a **+N** chip; point at
  it to see their names. The switches themselves are unchanged in the **+** menu.
- **On touch screens** there is no hover: the icons stay, a tap on web search turns it off, and a project
  is removed in the project picker.
  
## Generated Images Keep the Provider's Marks, and Can Be Checked

AI Act Art. 50(2) asks that generated images are marked and can be checked. The providers already mark their
output (Gemini images carry SynthID; some models also embed a C2PA manifest). iHub now makes sure it never
removes that mark, records what the provider claims, and lets anyone check a file.

- **Bytes in, bytes out.** A generated picture reaches the chat, the stored artifact, a share link, the ZIP and
  the download exactly as the provider sent it. A test fails if an image or audio library is ever added to
  the server's request path.
- **One record per generated image**, with the hash of the raw bytes, the model and what the provider marking
  looks like (C2PA present, valid, issuer, digital source type; what you declared). Pictures too large for
  the artifact store are recorded too. The record never holds the picture.
- **Check a file.** `POST /api/eu-ai-act/provenance/_verify` now also takes an image or audio file (`multipart/form-data`,
  one `file` field, up to 50 MiB) and answers whether this installation generated it, plus the file's C2PA
  manifest. A file generated elsewhere still gets its manifest read. Results say "found" or "not found" and
  "trust not evaluated"; a signature is never called authentic, and a missing record is not proof of origin.
- **Declare what the provider embeds.** In **Admin → Models**, an image-generating model has an *Image marking*
  section: *Provider marks the output*, a scheme such as `synthid` and a reference to the provider's written
  statement (`contentMarking.image`). Nothing is preset: SynthID is only ever "declared", because it cannot be
  detected.
- **Settings.** `provenance.media.maxVerifyBytes` and `readC2pa` in `platform.json` (migration V244).

See [Provenance Records → Images](../../provenance.md#images-provider-marks-3328) and
[Models → Output Marking](../../models.md#output-marking-contentmarking).

## Uploaded Presentations Move Into the Company Design

A user uploads a PowerPoint deck made elsewhere and asks for it in the company design. The `pptx`
skill has a new tool, `restyle_pptx`, that puts the deck on the **document template's slide master
and layouts** and gives it back as a download, instead of rebuilding it from its text.

- **Content is kept.** Pictures, charts with their data, tables and speaker notes come along.
- **The template decides the look.** Each slide gets the template's layout for its kind; titles,
  footers and slide numbers take its positions, fonts and colours; text alone on a slide uses its
  content area. Pictures, charts, tables and other shapes keep their arrangement and are scaled into
  the content area, also when the deck has another size (4:3 to 16:9).
- **Colours follow the theme.** Colours the deck took from its old theme, in slides and charts, become
  the template's. Slide backgrounds and the old master are dropped.
- **Works with any template.** Upload the company's PowerPoint template under **Admin → Document
  templates**: a cover photo, edge strips, logos and a footer bar in its master reach every slide. Without
  a PowerPoint template, iHub's built-in design made from the brand is used.
- **A move, not a redesign.** A colour or font a shape sets itself stays, and slides with several
  pictures can need a look afterwards; the tool reports slides whose content had to shrink a lot. To
  rewrite a deck, `create_pptx` still rebuilds it from its text.

See [Document templates → Uploaded presentations](../../document-templates.md#uploaded-presentations).

## The Chat Scrolls Behind the Message Box

In a chat, the message box no longer sits on a band of its own below the conversation. The
messages run the full height of the chat and scroll visibly behind the box, as the document does
in the full-screen workspace. Only the box itself stays solid, so what you type remains readable.
The last message can still be scrolled clear of the box.

## Chats Get a Short Title After the First Answer

Chats in the history were named after the first words of your first message, so a list of chats
that all began with "Can you help me with …" was hard to scan. Under **Admin → Chat History → Chat
titles**, switch on **Generate chat titles**: after the first answer of a chat, a short model call
replaces that name with a headline of three to six words, in the language of the first message.

- **Off by default.** It sends the first message and the first answer of each chat, cut to about 600
  characters each, to a model. Nothing changes until you switch it on.
- **Your model choice.** Pick a small, cheap **Title model**, or leave it empty so the chat's own model
  writes the title. The picked model is used only for people whose groups may use it; everyone else
  gets the chat's own model. No other model is ever used.
- **Your own titles stay.** A title you set yourself is never replaced.
- **Once, and in the background.** A chat gets its title when its first answer arrives, without
  delaying the chat. If it fails, the first-message title stays. It shows in the list a few seconds
  after the answer. Temporary chats get theirs when you keep them. Chats that already have several
  answers keep the title they have.

**Migration:** on the first start with this version, `chats.titles` is added to `platform.json`,
switched off.

See [Chat Persistence → Chat titles](../../chat-persistence.md#chat-titles).

## Upload Types Start With All Their Formats Selected

In **Admin → Apps → Upload Configuration**, turning on an upload type (images, files, audio or
video) now selects **Use entire category** straight away, so the app accepts every format of that
type. Uncheck it to pick individual formats; your selection stays as it was and you remove what you
do not want. Before, a newly enabled type started with a short default list.

Unchecking **Use entire category** now also works when every format is selected.

**Migration:** on the first start with this version, every enabled upload type that has no format
list, or still has one of the old defaults the editor and the chat used, is moved to the entire
category of its type (for documents that includes HTML, CSS, JavaScript and **Any text file**).
Format lists you chose yourself, and types that are turned off, are left alone.

## iFinder Model Gateway as a Model Source

iHub can use the **iFinder Model Gateway** as a built-in model source. Under **Admin → Models →
Import from URL**, tick **This endpoint is an iFinder Model Gateway**, enter the gateway root and a
project API key, and iHub lists the models the project may use.

- **Detected, not guessed:** chat, vision and realtime-speech models are recognised from what the
  gateway reports for each model, with the context window. Embedding and NER models are listed but
  cannot be picked.
- **Right dialect per model:** Mistral models use the Mistral adapter, OpenAI and Azure models the
  provider's API type. All calls go through the gateway's auto-select route, so a model survives a
  backend being replaced.
- **Tool calling:** the gateway does not support it yet, so imported models have tool support off.
- **Existing providers:** **Admin → Providers** has a new **Model gateway** setting for turning a
  provider into a gateway provider.
- **Sync with gateway:** on a gateway provider's page, **Sync with gateway** compares what the
  gateway lists now with the models imported from it: new models, changed context window, image
  input, URL or adapter, and models that are gone. Changes and gone models start ticked, new
  models start unticked (importing one makes it available), and nothing happens until you apply. A model that is gone is disabled, never deleted.

See [Models](../../models.md#importing-models-from-an-endpoint).

## Integrations: Install from a Catalog, Configure, Bind to Apps

**Admin → Integrations** is one platform for everything iHub connects to. An integration is a
definition in a catalog; installing it creates an installation with its own URL, sign-in mode and
set of actions; apps bind installations and the model gets their actions as tools. Existing
configuration moves into installations on the first start (see Breaking Changes).

- **Install wizard:** generated from the definition's install fields (URL, numbers, switches,
  choices, a secret), offers the sign-in modes the definition declares (none, or a shared service
  account whose secret goes to the credential store), lets you choose the actions and tests the
  connection before anything is saved. One definition can be installed several times.
- **Guard rails on every call:** each action carries its side effect (read, write, destructive).
  Install values are enforced: a result cap the model cannot raise, a filter that is always added,
  a value the model cannot change.
- **Scopes and cited answers:** a definition can declare scopes (for a data portal: the publishers)
  that users pick per chat like an iFinder search profile, and how its results become sources, so
  every record an answer mentions is linked.
- **In apps:** **Admin → Apps → Edit → Installed integrations** binds an installation, narrows it
  to some actions and sets the default or pinned scope. An app is offered only while every
  installation it binds as **Required** (the default) exists and is enabled; **Admin → Apps**
  names a missing one. Switch **Required** off and the app stays available without that
  integration's actions. Web search is optional by default.
  Each binding also says whether the integration is **On by default** or only available: an
  integration that is useful but not needed in every chat can stay off in new chats and be
  switched on from the chat's "+" menu, as web search always could.
  **iAssistant** and **iFinder** have panels of their own instead of free-text scope boxes:
  choose whether users may switch iAssistant or search profile (in the menu, in the chat input, or
  not at all), pick the start search profile with **Load from iFinder**, and let other models ask
  an iAssistant. The settings are stored in the app as before.
- **One admin page:** the tabs **Installed**, **Catalog**, **Requests** and **Inbound** (what
  connects to iHub: Outlook add-in, browser extension, Microsoft 365 Copilot, Nextcloud embed, the
  MCP gateway). **Installed** opens with a **Clients** section: the Outlook add-in, the browser
  extension, Microsoft 365 Copilot and the Nextcloud embed, each with whether it is switched on and
  a link to its settings page; the search box finds them too. Installations are grouped (people directories, web search, storage providers, MCP
  servers, agents, built-in, custom, from the catalog); a tile shows version, status, sign-in mode
  and key facts, and opens `/admin/integrations/<id>` with **Overview**, **Settings** and, where
  the definition has a history, **Releases**. iFinder, iAssistant, the web search engines, people
  directories, the LDAP browser, Entra ID, storage providers and Jira have dedicated editors; other
  installations use the form generated from their definition. Secrets only ever show as set or not
  set.
- **Marketplace:** **Integrations** is a new item type. Cards show the sign-in modes, the effect
  (read, read · write), where it runs (cloud, on-premises, local) and the number of actions; the
  details list each action with its effect. An item that would start a local MCP process (`stdio`)
  is left out of a registry's catalog.
- **Marketplace integrations in the catalog:** the **Catalog** tab also lists the integrations of
  the marketplace that are not installed yet, marked **Marketplace**; **Install** fetches the
  definition from its registry and opens the setup form in one step. 29 hosted MCP servers —
  among them GitHub, Linear, Stripe, Zapier, Supabase and Microsoft Learn — now come from the iHub
  Official Marketplace this way, so they get updates without an iHub release; Context7,
  Atlassian, draw.io, Excalidraw and a few more still ship with iHub. MCP servers you already
  connected to one of the 29 keep their id, tools and key, and are linked to the marketplace
  definition so they receive its updates.
- **CKAN Open Data Portal** ships with iHub: search datasets, read licenses, publishers, coverage
  and the files with formats and download links (file contents are not read), and query DataStore
  tables, on GovData, the German state and city portals, data.gov and internal CKAN catalogs.

See [Integrations](../../integrations.md#the-integrations-page) and
[Marketplace](../../marketplace.md).

## Integrations: Build Your Own, Test Every Action

**Admin → Integrations → Add manually** builds a custom integration in five steps: name, icon and
description; sign-in (none, a service account from the credential store, or per-user OAuth for an
MCP server); the source of its actions; the actions; a review. It replaces the Tools page.

- **Sources:** an **OpenAPI** document (pick the operations; the side effect comes from the
  method), **HTTP requests** (method, URL template with `{param}` placeholders, query, headers,
  body template, a JSONPath response mapping; no code), a **script** (a JavaScript module edited in
  the builder), an **MCP server** (URL or local command) or an **A2A agent** (agent card).
- **Per action:** description for the model, parameters, side effect, data flow and approval.
  HTTP calls go through the SSRF guard, the proxy and the certificate whitelist and never follow
  redirects.
- **Custom is an ordinary installation:** bind it to apps, grant it to groups, test it, reopen it
  with **Edit in builder**, or **Export for a registry** to install it on another iHub.
- **Own code from a registry:** a registry definition may ship a connector module
  (`"protocol": { "type": "script", "module": "connector.js" }`). It is delivered only when an admin
  marked the registry **trusted for code** (**Admin → Marketplace → Manage Registries**) and the
  catalog carries a hash of the file, which the install checks. The connector is one bundled file
  that imports nothing from its folder. The catalog and the wizard say when an integration runs
  code on the server.
- **Action details:** every action on an installation's page has **Details**: the description and
  parameter schema exactly as the model gets them (replaceable per language), side effect, data
  flow and approval with where each value came from (overridable), **model guidance** and
  **example prompts** per language (added to the system prompt while the integration is active,
  together with the integration's own **instructions**), the apps, workflows and tasks that use it,
  and calls, approvals, errors and admin tests of the last 7 days.
- **Test runner:** a form built from the parameter schema runs the action without a model, as you
  or with the shared credential, and shows status, duration, the request as sent (credentials and
  secrets redacted), the raw response and the Answer Sources it produced. An action that is not a
  confirmed read runs only after you tick the confirmation. Tests are audited (`action.test`).
- **Test in chat:** the page of an installation opens the real chat beside it, running an app that
  uses the installation. **Create example app** makes one (LDAP browser and CKAN ship their own;
  other integrations get an assistant generated from their description and example questions); the
  chat restarts after each save. Definitions from a registry can ship example apps (`exampleApps`).

See [Integrations → Custom integrations](../../integrations.md#custom-integrations-add-manually)
and [Building an Integration](../../integration-development.md).

## Integrations: Versions, Compatibility, Updates, Migrations and Revert

A definition declares which iHub versions it runs on and what changed between its versions; a new
version brings your installations along by itself.

- **Compatibility:** the marketplace greys an item this server cannot run ("needs iHub >=6.0.0,
  this server runs 5.7.2") and disables **Install** and **Update**; the API refuses them too. A
  definition on disk that no longer fits is listed as **Incompatible**; its installations offer no
  actions until it fits again.
- **Release notes and badges:** each version has a date, a summary and notes per category. The
  marketplace detail has a **Releases** tab, the **Update** dialog lists what changed, and the
  installed list shows **Update to vX available** (the dashboard counts them).
- **Migrations:** a release that renames an install field or action, removes one or needs a new
  value ships a migration. iHub runs it for every installation, on a marketplace update and at
  server start for built-in integrations, and rewrites the settings, the action selection and the
  apps that bind it, after a backup under `contents/backups/integrations/`. The update dialog
  previews per installation what changes and which apps lose an action.
- **Nothing half-migrated:** an installation whose migration fails keeps its settings, offers no
  actions and says why. Its tile shows **Migration pending**, **Needs review** or **Migration
  failed**; its page offers **Migrate now**, **Re-run migration**, **Restore backup**, **Adopt
  current version** and **Uninstall** as they apply, plus a **Migration log**. **Admin → Apps**
  warns on apps whose binding a migration removed or left on a renamed action.
- **Revert:** the **Backups** card lists every backup (before each migration, at each version an
  update passed through, before each restore). **Revert to this version** puts the definition, the
  settings, the action selection, the app bindings and the marketplace entry back together; if
  anything fails, nothing changes.
- **Channel and pins:** **Admin → Marketplace → Manage Registries → Edit → Versions** sets the
  channel (**Stable releases only**, the default, or **All releases, including pre-releases**) and
  a **version pin** such as `1.3.x` per item. An update never goes back; revert instead.
- **Code migrations:** a definition may migrate with a small JavaScript module when renames and
  defaults are not enough. It runs only for built-in integrations and registries trusted for code,
  only when the file matches the catalog's hash, never sees credentials and changes only settings,
  action selection and app bindings.

See [Integrations → Version, compatibility and release notes](../../integrations.md#version-compatibility-and-release-notes),
[Migrations](../../integrations.md#migrations) and
[Marketplace → Versions, channel and pins](../../marketplace.md#versions-channel-and-pins).

## Existing Systems Are Installed Integrations

These systems are configured under **Admin → Integrations** instead of `platform.json`, their own
files or pages of their own. Tool ids, group grants and users' connections are unchanged; apps bind
the installation (`integrations.<id>`) and pick actions by name; an app is offered only while its
installation is enabled. Environment variables keep working as the fallback where noted.

- **iFinder and iAssistant:** the iFinder installation holds the base URL, the sign-in mode
  (iHub-signed JWT or OIDC token exchange), the signing key as a credential reference, the
  search-profile settings and the endpoint paths; the iAssistant runs on that connection and adds
  its defaults. The wizard runs the iFinder diagnostics (reachability, key, token exchange, a
  search) on the unsaved draft. `IFINDER_API_URL`, `IFINDER_PRIVATE_KEY` and
  `IASSISTANT_PROFILE_ID` still apply. The action **Ask the iAssistant** (`iassistant__ask`) lets
  an app on any model ask one iAssistant turn and cite the documents; tick it in the app's
  iAssistant binding. The iAssistant picked in the chat or pinned by the app always wins over the
  one the model names.
- **MCP servers:** the hosted servers of the former catalog (Microsoft Learn, Context7, GitHub,
  Atlassian, Stripe and some thirty more), draw.io and Excalidraw are shipped definitions; any other
  server, local processes included, uses the generic **MCP server** definition (Streamable HTTP,
  SSE, WebSocket or stdio). Sign-in: none, a shared account, an OAuth client or per-user OAuth.
  The wizard lists the server's tools after **Test connection**; single tools can be switched off.
- **Remote A2A agents:** Agent Card URL, sign-in and call budget; **Test connection** lists the
  skills, each of which can be switched off.
- **Web search engines:** **Brave Search**, **Staan** and **Qwant** are installed where wanted. Apps
  with web search on use the model's native search on Google, OpenAI and Anthropic models even
  with no engine installed (a fresh install ships none); other models need an engine, and the chat
  offers the toggle only while one is available. The app editor's **Web Search** panel picks
  **Auto** (the first engine the user may use) or an engine. `BRAVE_SEARCH_API_KEY` and
  `STAAN_API_KEY` remain the fallback. Your own engine is a definition of type `web-search` with one
  action `search`.
- **Jira:** the installation `jira` holds the OAuth app (client id, secret reference, redirect URI,
  site URL); **Test** checks it, **Connections** lists connected users. The redirect URI may stay
  empty and is then derived from each request including the base path.
- **Entra ID directory:** the installation `entra` holds tenant id, application id and client
  secret; `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` fill empty fields.
- **People directories:** each LDAP directory is an installation of **People directory (LDAP)**
  with the settings of the former directory editor and a sample search next to **Test connection**.
  Apps bind one directory, every LDAP directory or **All people directories**
  (`"type:people-directory": {}`), which includes Entra ID and directories installed later. The
  shipped **People search** app binds all of them.
- **LDAP browser:** the admin browser is an integration of its own that reuses a directory's
  connection with its own browse base, limit, withheld attributes and optional account. Only
  signed-in users browse; it is never offered over the MCP gateway and every call is audited. The
  shipped **LDAP browser** app still ships disabled.
- **Storage providers:** **Microsoft Office 365**, **Google Drive** and **Nextcloud** can be
  installed several times (per tenant, OAuth client or server), each with its own OAuth app,
  connected users and group grant. **Admin → Apps → Edit → Integrations → Storage providers**
  binds all or selected installations; the chat's cloud file picker offers what the app binds and
  the user's groups grant (the **Cloud Storage Upload** switch is gone). The settings tab shows
  the redirect URI to register, with the base path, and tests the unsaved values.
- **iHub's own tools:** `ask_user` and the scheduled-task tools are actions of the built-in
  integration `ihub`, always installed and enabled (switch single actions off for every app).
  Project knowledge tools work whenever projects are on.

See [Integrations → Built-in integrations](../../integrations.md#built-in-integrations),
[People Directory Search](../../people-directory-search.md) and
[Apps → Files from storage providers](../../apps.md#files-from-storage-providers).

## Integrations: One Connection Service, One Connect Card, Settings → Integrations

Jira, Office 365, Google Drive, Nextcloud and MCP servers with per-user sign-in connect, refresh and
disconnect through one connection service and one OAuth client. Connected users stay connected,
nobody signs in again and the callback URLs registered with the vendors keep working
(`/api/integrations/oauth/callback` handles every sign-in; the old URLs are aliases).
A user connected before the upgrade appears in an installation's **Connections** list after
their first use of it (the list is built as tokens are used, not at start).

- **Same protection everywhere:** PKCE for every sign-in (Nextcloud included), a single-use state
  on the server bound to the user and installation, same-origin return URLs, refresh tokens sent
  only to the server that issued them. Changing an installation's server URL, tenant or OAuth
  client ends its users' connections. Disconnect revokes upstream where the provider supports it.
  `connection.create` and `connection.revoke` are audited; the **Connections** dialog shows each
  user's status.
- **One Connect card:** when a request needs an integration the user has not connected, the chat
  explains why iHub must act as the user, what that covers in read and write terms and where the
  sign-in happens, with **Connect** and **Not now**. After consent the user returns to the same
  chat and the request is retried once; a call that failed for another reason is never retried.
  **Reconnect** appears when a connection expired or lacks a permission, also when an MCP server
  asks for more scopes. The cloud file pickers show the same card.
- **Scheduled tasks** use their owner's connection; with none, the run fails with
  `INTEGRATION_AUTH_REQUIRED`, naming the integration, the reason and a **Reconnect** link.
- **Settings → Integrations** lists every integration your groups allow and says who iHub acts as:
  _Connected as you_, _Signed in via SSO_, _Runs as service account_, _Shared key_, _Not
  connected_, _Reconnect needed_ or _Unavailable_. Connect, Reconnect and Disconnect work there;
  a row opens its actions, the apps that use it, last use and what you allowed. Search, filter by
  category or show only what **needs attention**. `GET /api/integrations` returns the same list.

See [Integrations → Connections](../../integrations.md#connections).

## Integrations: Groups Decide Who May Use Them, Users Can Request More

**Admin → Groups → a group → Integrations** grants installations like apps (`permissions.integrations`
in `groups.json`), in sections for people directories, web search, storage providers, MCP servers,
agents, built-in and from the catalog (custom integrations are listed under from the catalog).

- **What a grant covers:** **All integrations** (`*`, including ones installed later), a kind
  (**All people directories**, **All web search engines**, **All storage providers**:
  `type:people-directory`, `type:web-search`, `type:storage`), all installations of one
  definition, or single installations. Groups inherit grants like apps.
- **Enforced everywhere:** chat, workflows, scheduled tasks, direct tool runs, the MCP and A2A
  gateways, web search, LDAP directories and storage providers. A token acting for a user and a
  personal API key keep the user's grant; a machine OAuth client may use what the apps it may use
  bind. `admins`, `users` and `authenticated` may use every integration; `anonymous` may use iHub's
  own tools and every web search engine.
- **Users request integrations:** **Settings → Integrations** lists the catalog integrations the
  user cannot use yet as a compact card grid like the marketplace (the first six cards, then **Show
  all**, and a search from six entries on). Each card has **Request** (optional reason, up to 500
  characters) and afterwards shows _Requested_, _Approved, being set up_ or _Declined_. **Admin →
  Integrations → Requests** lists who asked for what, with the open count on the tab and the
  sidebar. **Approve** opens the install wizard; **Decline** and **Decline and hide** take an
  optional note, and a hidden integration disappears from every user's list until shown again. A
  request closes once the integration is installed and the requester's groups may use it. Requests
  and decisions are audited.

See [Integrations → Who may use an integration](../../integrations.md#who-may-use-an-integration)
and [Requests from users](../../integrations.md#requests-from-users).

## Tool Calls Can Need a Person's Approval

Admins decide which tool calls a person must approve before anything is sent, for example before an
external MCP server receives what was found in your documents or a comment lands on a Jira issue.
Approval is off until you set a mode.

- **Three modes:** never, ask unless the call only reads, always. Every tool carries what it does
  (reads, writes, deletes or overwrites, unknown) and where its data goes (internal, external).
- **Where to set it:** a platform default for internal and external tools (**Admin → Security →
  Tool approval**), a default and a mode per action on each installation (**Admin → Integrations →
  an installation → Overview**, or the action's Details), the integration builder for custom
  integrations, and an app override (**Admin → Apps → Edit → Tools**). The strictest setting wins;
  an app can only make it stricter.
- **Approval card in the chat:** the tool, what it does, the exact arguments and any assistant
  text, labelled as such. **Approve**, **Approve & allow for this chat** or **Reject**; iHub runs
  exactly the call that was shown. MCP App views get the same card below the view.
- **Claims are not trusted:** an MCP server's read-only label still asks under "ask unless it only
  reads" until an admin confirms the tool as a read. New or changed actions (fingerprinted by name,
  description and input) are badged **New** or **Changed** and ask until you choose **Mark
  reviewed**; a builder save marks the actions it changed as reviewed.
- **Sensible start:** a new installation preselects "ask unless it only reads", and "always ask" for
  MCP servers, A2A agents and other external integrations that do not declare what their actions
  do. Existing integrations are left as they are.
- **Where nobody can approve** (OpenAI-compatible API, apps as tools, the MCP and A2A gateways,
  workflow and agent steps) a gated call is refused and the model is told; a step that names
  approver groups parks the approval for them. Scheduled tasks ask their owner. Custom tools with
  `requiresApproval: true`, which used to ask only in scheduled runs, now ask in the chat too.

See [Tool Approval](../../tool-approval.md).

## Chat: Integrations Picker, Chips, Defaults and Named Tool Calls

The "+" menu is the integrations picker: one row per integration the app offers, never one per
action, with what it does ("read · write").

- **Search, Attach, Use in this chat:** upload and storage providers are under **Attach**; web
  search, integrations and image generation are rows under **Use in this chat**. A row with a scope
  (iFinder search profile, iAssistant) shows it and can change it. A personal integration not yet
  connected shows **Connect →**; consent opens in a new tab and returns to the same chat.
  **Manage integrations…** opens Settings → Integrations; `@` finds the app's integrations too.
- **Chips under the composer** show what the next answer can reach, with its scope; web search turns
  off with one click. An app can show the scope as a dropdown in the chat input (`scopePicker:
  "inline"`).
- **Per chat, default on the server:** a switch changes only the open chat. **Use as default for
  new chats** saves the set (integrations, web search, scopes) for the app on the server, so it
  applies in every browser; what the browser remembered is taken over once after the upgrade.
- **Tool calls read as users think:** each call shows the action ("Search people") and the system
  it ran against ("Munich AD"), not `muc-ad__search_people`; the summary names the systems; the
  internal id stays as a tooltip. A search in a connected system (a Jira search, an MCP server's
  search) is listed as a call to that system, no longer as a web search.
- **Sources panel:** every iFinder card names the search profile it was found in ("Contracts"), and
  the header says **Searched in Contracts** or **Asked HR assistant**. Labels are stored with the
  answer and left out of shared chats.
- **Scheduled tasks and workflows keep their search scope:** a task keeps the iFinder search
  profile and iAssistant of the chat it was scheduled from, or those picked under **Where to
  search** on its form, and every run uses them; a profile the owner lost fails the run with an
  error naming it. A workflow agent or tool step can bind iFinder tools to a profile with
  `integrationScopes`. Older tasks search the default as before.

See [Integrations → In the chat](../../integrations.md#in-the-chat-the-integrations-picker).

## Chat and Scheduled-Task Files: Durable, Reusable and Connected

Files attached to a chat now stay with it: the assistant keeps reading them on follow-ups, after a
reload and on another device, and **Regenerate** and **Edit** no longer lose them. Scheduled tasks
can carry reference documents and templates of their own.

- **Files in the workspace pane:** the chat's Files index has **Generated**, **Uploaded** and
  **Sources** tabs. Uploaded files show type, size, pages and whether the original is still
  stored, open as a preview (PDF, picture, CSV, notebook, text, e-mail, meeting or web page) and
  offer **Download original**, **Download text** and **Delete file**; the Outlook task pane adds
  **Attach to email**.
- **What the server keeps** (**Admin → Chat history → Uploaded files**, per app
  `uploads.storageMode`): the file and its text, only the text, or only text extracted in the
  browser. Originals older than the retention period (14 days by default) are removed and their
  text stays with the chat. Limits per file, chat or task, user and server; the server-wide limit
  is counted in a shared counter, so several instances enforce it together.
- **Long chats stay within the context window:** the files of earlier turns go back to the model in
  full while they take up to a quarter of the model's context window. Older files are named but
  not repeated, and the assistant reads them again when a question needs them. The context meter
  under the composer counts the same way.
- **Templates and forms:** an uploaded Word, PowerPoint, Excel or PDF file can be used by the
  document skills: `create_docx` and `create_pptx` take its styles, master and layouts
  (`templateFileId`, `templateMode`), `create_pdf` fills its form fields or prints on it as
  letterhead, `create_xlsx` adds and replaces sheets (`sourceFileId`). An app with a fixed
  corporate template keeps it unless it sets `allowUserTemplateUploads`.
- **Scheduled tasks:** attach files in the task editor; every run reads them, a copied task copies
  them. Files from Nextcloud, OneDrive and SharePoint, Google Drive or iFinder can be fetched by the
  server and refreshed at every run (`refreshOnRun`); if a refresh fails, the last version is used
  and the run says so.
- **Sharing:** a shared chat lists attached file names; the owner can share the text or the original
  file by file.
- **Outlook:** e-mails, meetings and web pages sent to the assistant are stored as files, once per
  chat, with the real `.eml` from a pop-out and the original of Outlook attachments.
- **APIs:** the Inference API gets `/v1/files`, `file_id` references and `input_file` parts on
  conversation items (`.xlsx` and scanned PDFs included), with their own per-user limits
  (`maxApiFiles` 200 and `maxApiBytes` 1 GB by default, 0 removes them). `app__*` and
  `workflow__*` MCP tools accept `files`, `app__*` returns generated files as `resource` and
  `image` blocks, and A2A takes and returns `FilePart`s (its tools gained `fileIds`, so an A2A skill
  set to "ask when new or changed" asks once more after the upgrade).

See [Chat Files](../../chat-files.md).

## Excel Workbooks and Interactive Web Artifacts from Chat

Two new system skills, enabled per app by adding `xlsx` and `web-artifacts` to its `skills`:

- **Excel workbooks:** multi-sheet `.xlsx` with the corporate design, frozen header row, filters,
  fitted widths, number, percent and date formats and live formulas. A formula that reaches outside
  the workbook (`WEBSERVICE`, `HYPERLINK`) is written as plain text.
- **Web artifacts:** a self-contained interactive `.html` page (dashboard, calculator, simulator) or
  `.svg` using `--brand-primary`, `--brand-accent` and `--brand-font`. It runs sandboxed and cannot
  contact other sites.
  Links in an artifact (sources, details, menu items) open content inside the file instead of
  pointing nowhere; a link the preview cannot follow is flagged so the model rebuilds it.
  A rebuilt artifact replaces the earlier version: the answer shows one card per file name, not one
  per attempt.
- **Previews:** PDFs, HTML, SVG, CSV/TSV tables and Jupyter notebooks open in the panel, with a
  **Preview | Code** switch.
- **Open:** the Files panel's preview has an **Open** button (or double-click a file) that opens the
  file in the full-window viewer; see _Artifacts Open Full Window_.
- **PDF, Word and PowerPoint:** `create_pdf` lays out fillable and pre-filled forms; `create_pdf`
  and `create_docx` take `showTitle`, `accentColor` and `date`; slides can show KPI metric cards.
  The fields of an uploaded PDF form are part of the text the model reads.

See [Apps → Skill Settings](../../apps.md#skill-settings).

## Tables in Uploaded PDFs Are Recognised Without Tags

Tables in uploaded PDFs reached the model as scrambled lines unless the PDF was tagged. iHub now
reads a table from where its text sits on the page and passes it on as a Markdown table, for PDFs
exported from browsers, report generators and iHub itself: header row, wrapped cells and tables
that continue on the next page come out as rows and columns. Detection is conservative: bulleted
lists, tables of contents, code, justified text, two columns of prose and anything under three rows
or two columns stay ordinary lines. Tagged PDFs still use their structure tree.

## Share a Single File as a Link, Optionally Embedded

A generated file — a web page, image, document or code file — can now be shared on its own, like a
chat, without the conversation it came from. Choose **Share** on the file's card in the chat or in the
header of the workspace pane.

- **Same audiences and limits as chat links:** specific users, anyone signed in, or anyone with the
  link, each with an expiry, an open limit and **Revoke**. Only that one file opens through the link;
  HTML pages run in the same sandboxed preview as in the chat.
- **Embedding:** a public link without an open limit can be embedded in an iframe. The dialog gives
  the embed code; only the websites an admin lists can show it.
- **Deleting the chat deletes its file links and the files.**
- **Admin settings** (Admin → Observability → Chat History → Chat sharing): _Links to single files_
  (on by default) and _Allow embedding public file links_ with the list of websites that may embed
  (off by default).

See [Chat Sharing](../../chat-sharing.md#sharing-a-single-file).

## Usage Limits per Model, Group and User — Visible to Users and Admins

Admins can give each model a per-user token budget per day, week and month — for example a small
budget for a preview model — and lower it further for groups and individual users. Users see
their budgets and when they reset; admins see everyone's usage against their limits.

- **Levels:** the model's limit is the ceiling; a group's and a user's limits can only lower it.
  A budget across all models can be set for everyone. Groups and users can also get a lower file
  storage limit than the platform's per-user upload quota.
- **Built-in resets:** daily at a set time, weekly on a set weekday and monthly on the 1st, in a
  configurable time zone (**Usage Reports → Limits & quotas → Reset schedule**).
- **Enforced everywhere:** chat, agents, workflows, scheduled tasks and the Inference API refuse
  a call once the budget is used up, with a message saying when it resets (`429` with
  `QUOTA_EXCEEDED` on the API).
- **For users:** a new **Usage** page in the user menu, a notice above the chat input from 80 %
  of a budget, and the usage of limited models in the model picker.
- **For admins:** a **Limits & quotas** tab under Usage Reports with every user (search, filter
  by near or at a limit, per-model, reset), a per-model and a per-group view; limit fields in
  the model, group and user editors, and the user's current usage in the user editor.

Nothing is limited until an admin sets a limit. See [Usage Limits](../../usage-limits.md).

## Chat: The Assistant Can Look Back at Earlier Sources, Files and Created Files

On a follow-up the assistant used to see only the text of earlier answers. Now it can look up what
earlier turns of the chat found, were given and produced, without everything being sent again on
every turn.

- **Sources:** "what did the second source say?" or "open that article again" works. The assistant
  reads the stored title, link, snippet and passages of a source an earlier answer found, and can
  cite it again with a badge. For more of a web page, it reads the page again. The basis chip
  shows where the source came from: an answer built on a web page found earlier says "Web".
- **Uploaded files:** files from earlier turns can be read again in full, also those that were
  left out of the prompt to save space.
- **Created files:** documents, spreadsheets, presentations, code and web pages the chat created
  can be read again, for example to revise a document into a new version. Pictures and ZIP
  archives are listed but not read.
- Only for kinds the chat actually has, only in stored chats that send their history, and only for
  people who may read the chat. Nothing to configure; the lookups never ask for approval.

See [Chat Persistence](../../chat-persistence.md#what-earlier-turns-give-the-model).

## Chat: Files and Sources Open in a Workspace Next to the Chat

Generated files, uploaded files and the sources an answer cites now open in a workspace pane on the
right of the chat. The chat moves aside instead of being covered, so you can keep asking while the
document is open.

- **Open, dock, expand:** a click on a file card, on a source's **Preview** or on **Files** in the
  chat header opens the pane next to the chat. Drag its edge (or use the arrow keys on it) to make
  it wider or narrower; a double-click resets it. **⤢** makes it full screen, with a small chat box
  at the bottom to keep asking. Back steps out one level at a time: full screen, docked, closed.
- **One header for everything:** back to **Files**, the file name (a menu to switch to any other
  file of the chat), **Preview | Code**, **Copy** with the export formats (HTML, Markdown, PDF),
  **Download**, **Share**, full screen and close; the rest is under **⋯**.
- **Files index:** the old Files drawer is the pane's list now, with **Generated**, **Uploaded**
  and **Sources** tabs, ZIP download of all or of a selection, and **Answer 3** links that jump to
  the answer that made a file.
- **Sources:** a cited document opens read-only in the pane, its passages highlighted, with
  **Passage 2/5** navigation and **Open in source system**.
- **Ask about a passage:** select text in the pane and choose **Ask about** or **Edit with AI**:
  the passage is quoted into the chat input. **Edit with AI** produces a new file; the original is
  not changed.
- **Cards:** the card of the file that is open in the pane is highlighted; Download and Share appear
  on hover.
- **Small screens and add-ins:** below 1024 px wide, in the Outlook add-in and in the browser
  extension the pane opens as a full-screen sheet with **Back to chat**. Below 1280 px the left
  sidebar folds to its icons while the pane is open.
- **Links:** what is open is in the address (`?artifact=…`, `&view=full`): reload reopens it.
  **Open in new tab** shows one file on its own page; a shared single file opens the same way, and
  `?embed=1` drops the header for embedding.
- **Keyboard and screen readers:** **Ctrl+.** (⌘. on a Mac) opens and closes the pane, **F6**
  moves between sidebar, messages, input and pane, **Esc** closes the innermost layer and never
  from the chat input, and a "Skip to workspace" link leads to the pane.
- HTML runs in the same sandboxed frame as before and cannot reach iHub.

See [Artifacts](../../artifacts.md#the-workspace-pane).

## Marketplace: Offline Registry for Installations Without Internet Access

An iHub without internet access can now use the marketplace. The **offline marketplace** is the
official catalog, the website and every file the catalog points at as one folder of static files,
published as a Docker image (`ghcr.io/intrafind/ihub-marketplace`) and as a `.tar.gz` bundle with
every release of the marketplace (versioned by the UTC build time, `yyyymmddhhmm`). Host it
inside your network, add its `catalog.json` under **Admin → Marketplace → Manage Registries**, and
install apps, models, prompts, skills, workflows and integrations as usual.

- **Nothing is dropped:** the 89 skills that the official catalog links to on GitHub are copied into
  the bundle at their pinned commits, with their reference files and license texts.
- **Easy to host:** the image needs no configuration or volume, runs as a non-root user and serves
  on port 8080; the bundle works behind any web server, at any path.
- **Skills with reference files from a registry's own host:** a skill whose catalog entry is a path
  on the registry and lists companion files now installs them. Before, installing such a skill failed
  with a server error, which affects private registries that list reference files too.
- **Unchanged:** the hosted MCP integrations and the model providers still need to be reachable.

See [Marketplace → Air-gapped installations](../../marketplace.md#air-gapped-installations).

## Localization: Edit Translation Overrides in the Admin UI

**Admin → Customization → Localization** now lets you overwrite labels and translations without
editing files. The editor opens on the keys you changed; search by key or text to find any other
label, edit it per language and save, or reset a key to the built-in text. Changes are stored in
`contents/locales/{lang}.json` and apply immediately.

## Configure Group Inheritance in the Group Editor

Admins can now choose which parent groups a group inherits from directly in **Admin → Groups**,
without switching to the JSON tab. The new **Group Inheritance** card on the group form has an
**Inherits From** picker that lists every other group; inheritance stays optional and a group can
have several parents.

- **Safe to save:** a group can no longer be saved with a parent that does not exist, with itself as
  a parent, or with a chain that leads back to itself. The save is refused with a message naming the
  problem and the group file is left untouched, instead of failing when the groups are next loaded.
- **Same behaviour as before:** members still receive the combined permissions of all parents plus
  the group's own. See [Admin UI → Groups](../../admin-ui.md).

## Admin → Documentation: Read and Search the Docs for Your Version

Admins can now read the iHub Apps documentation inside the admin UI under **Admin → Documentation**
(`/admin/docs`). It is the documentation that ships with the installed version, so it matches what
is running — also in the Docker image, which did not include the documentation before.

- **Search** finds every section that contains all the words you type and opens the page at that
  section.
- **Links in What's New work.** Links in the release notes pointed to addresses such as
  `/integrations.md#…` and ended on an error page; they now open the documentation page at the
  linked heading, and links to another release's notes open that release in What's New.
- **`/docs` redirects to Admin → Documentation.** The separate documentation website is no longer
  part of the installation; it is published on GitHub Pages instead.

See [Admin UI → Documentation](../../admin-ui.md#documentation).

## One Error Response Shape for the API

Every error the API answers is now `application/problem+json`, the standard format of RFC 9457, with
the same members everywhere. That includes the errors the server's routes do not answer themselves
— a request body that is too large, a body that is not valid JSON, an unexpected failure — which
used to be an HTML or plain text page.

```json
{
  "type": "urn:ihub:problem:PAYLOAD_TOO_LARGE",
  "title": "The request is too large.",
  "status": 413,
  "detail": "request entity too large",
  "code": "PAYLOAD_TOO_LARGE",
  "details": { "type": "entity.too.large" }
}
```

- `code` is a stable, machine-readable code; the web app shows its own translated message for it
  (English and German). A client should branch on `code`, never on the text.
- `title` is the English text of the code and the same for every occurrence; `status` repeats the
  HTTP status; `type` is a stable identifier (`urn:ihub:problem:<code>`), not an address to fetch.
- `detail` is the English text of this occurrence, for scripts and other API callers. For a server
  error (5xx) it carries the real message only if it is safe to show (no file paths, hosts, URLs,
  credentials, SQL or stack details, at most 200 characters); otherwise it is the `title`. The real
  reason is always written to the log.
- `details` (optional) holds what the message needs or what the caller can act on, such as
  `retryAfterMs`, `currentVersion`, `linkedModels` or `integrationId`.
- OAuth endpoints (`/api/oauth/*`, `/.well-known/*`) and bearer-token errors keep their standard
  `{ error, error_description }` body, and the OpenAI-compatible endpoints (`/v1/*`) keep the OpenAI
  error object.
- Request validation (`400`) answers `code: "VALIDATION_FAILED"` with the failed fields in `errors`,
  a list of `{ pointer, code, message }` where `pointer` is a JSON Pointer to the offending member
  (`/schedule/cron`), instead of `{ error: "Invalid request", details: [...] }`. This covers the
  chat, tool-run, feedback, session-start, magic-prompt and MCP app endpoints.
- The chat sharing endpoints (`/api/chats/:chatId/shares`, `/api/shares/*`, `/api/users/lookup`) answer
  in this shape. The codes they already had (`CHAT_SHARING_UNAVAILABLE`, `SHARE_MODE_DISABLED`,
  `CHAT_TEMPORARY`, `ORIGINAL_DISCARDED`, …) moved from `details.code` to the top-level `code`; an
  unknown or foreign share, chat or file answers `NOT_FOUND`, and a share link that needs a sign-in
  answers `AUTH_REQUIRED`. A malformed share request answers `VALIDATION_FAILED` with `details.issues`
  instead of one joined `error` text. The ZIP download of several artifacts (`POST /api/shares/:shareId/artifacts/zip` and `POST /api/chats/:chatId/artifacts/zip`) answers `BAD_REQUEST`, `NOT_FOUND` or `PAYLOAD_TOO_LARGE`; the former body codes `empty`, `too-many-files` and `too-large` are now `details.reason` (`too-many-files`, `too-large`) of `PAYLOAD_TOO_LARGE`, and "no files" is `NOT_FOUND`.
- The scheduled task endpoints (`/api/scheduled-tasks/*`, `/api/admin/scheduled-tasks/*`) and the
  scheduling tools of the agents answer in this shape. Their codes (`TASK_DISABLED`,
  `RUN_IN_PROGRESS`, `VERSION_CONFLICT`, …) are unchanged; a sign-in that is missing answers
  `AUTH_REQUIRED` instead of `AUTHENTICATION_REQUIRED`. The field problems of a rejected task
  (`INVALID_TASK`) moved from `details` (a list) to `details.issues`, also in the tool results the
  model sees. A malformed settings body answers `VALIDATION_FAILED` with `details.issues`.
- The personal prompt library endpoints (`/api/prompts*`) answer in this shape. The codes they
  already had (`USER_PROMPTS_DISABLED`, `USER_PROMPTS_UNAVAILABLE`, `PROMPT_LIMIT_REACHED`,
  `SHARE_TARGET_NOT_ALLOWED`, …) and the stale-edit code `REVISION_CONFLICT` moved from
  `details.code` to the top-level `code`; a prompt the caller may not see answers `NOT_FOUND`, an
  unknown share target `BAD_REQUEST` with `details.unknown`, and a malformed body
  `VALIDATION_FAILED` with `details.issues` instead of one joined `error` text.
- The prompt administration endpoints (`/api/admin/prompts*`, `/api/completions`) answer in this shape
  as well: `NOT_FOUND`, `BAD_REQUEST` (a missing field or an unsafe id), `CONFLICT` (a prompt id that
  already exists) and `VALIDATION_FAILED` with `details.issues` for the user prompt settings. A
  failed model call of `/api/completions` that is not a provider error answers `INTERNAL_ERROR`
  without the technical reason, which is only logged.
- The integration administration endpoints (`/api/admin/integrations*`) answer in this shape. Their
  codes (`INVALID_VALUES`, `DUPLICATE_ID`, `MIGRATION_LOCKED`, `BACKUP_REQUIRED`,
  `CONFIRMATION_REQUIRED`, …) are unchanged and are now translated by the web app. The `success:
  false` flag is gone from error bodies. The validation problems of an installation moved from
  `details` (a list) to `details.issues`, and a failed migration (`422 MIGRATION_FAILED`) carries its
  `reason`, `logEntry` and `instance` in `details` instead of at the top level of the body.
- The personal skill library endpoints (`/api/user-skills*`, including the marketplace) answer in
  this shape. The codes they already had (`USER_SKILLS_DISABLED`, `SKILL_LIMIT_REACHED`,
  `SKILL_TOO_LARGE`, `MARKETPLACE_SKILL_NOT_FOUND`, `REVISION_CONFLICT`, …) moved from
  `details.code` to the top-level `code`; the limits that were reported next to them stay in
  `details` (`limit`, `maxFilesPerSkill`, `maxSkillSizeKB`). A malformed body answers
  `VALIDATION_FAILED` with `details.issues` instead of one joined `error` text.
- The skill administration endpoints (`/api/admin/skills*`, `/api/admin/user-skills*`) answer in this
  shape too. `SKILL_NAME_TAKEN` and the new `SKILL_NAME_RESERVED` (importing or promoting a skill under
  the name of a system skill, 409) are top-level `code`s; deleting a system skill answers `FORBIDDEN`,
  an oversized zip `PAYLOAD_TOO_LARGE`, and the problems of an invalid skill are in `details.errors`
  instead of a bare `details` list.
- The workflow endpoints (`/api/workflows*`, `/api/admin/workflows*`, including the webhook
  trigger `/api/workflows/:workflowId/webhooks/:triggerId`) answer in this shape. `NOT_FOUND`
  (workflow, execution, project, app, webhook trigger), `FORBIDDEN`, `BAD_REQUEST` and
  `CONFLICT` replace the former plain `{ error }` bodies; an invalid workflow definition answers
  `VALIDATION_FAILED` with the failed fields in `details.issues`. Deleting a running execution now
  answers `409 EXECUTION_ACTIVE` (before: `{ error: "cannot_delete_running", message }`), and a chat
  about an unfinished execution answers `409 EXECUTION_NOT_FINISHED`. The reason of a failed call
  is now in `error` instead of `message`, and a server error no longer carries the operation name
  ("Failed to start workflow execution") but the generic `INTERNAL_ERROR` text. A webhook call
  without a valid signature answers `AUTH_REQUIRED`.
- The integration builder and request endpoints (`/api/admin/integrations/builder*`,
  `/api/admin/integrations/requests*`, `/api/integrations/requests`) answer in this shape. Their
  codes (`INVALID_DRAFT`, `DUPLICATE_DEFINITION`, `REQUEST_EXISTS`, `REQUEST_NOT_FOUND`,
  `INTEGRATION_NOT_FOUND`, …) are unchanged and are now translated by the web app. The validation
  problems of a draft or an import moved from `details` (a list) to `details.issues`, and a
  malformed import body answers `VALIDATION_FAILED`. The `success: false` flag is gone from error
  bodies.
- The configuration backup endpoints (`/api/admin/backup/export`, `/api/admin/backup/import`) answer
  in this shape. An import without a file answers `BAD_REQUEST`; a second import while one runs
  answers `409 IMPORT_IN_PROGRESS`; a failed swap answers `500 IMPORT_FAILED` with what happened to
  the live configuration in `error` and how to fix the cause in `details.hint` (and the filesystem
  error code in `details.reason`). The admin page now shows that text instead of the generic
  "Request failed". A failed export that has not started streaming answers JSON, not a response
  with a ZIP content type. An unexpected import failure no longer answers the fixed text "Internal
  server error" when its message is safe to show.
- The marketplace administration endpoints (`/api/admin/marketplace*`) answer in this shape. The status
  and code no longer come from the wording of a message: an unknown registry or item answers
  `NOT_FOUND`, a registry that already exists or an item that is already installed `CONFLICT`, an
  invalid registry config `BAD_REQUEST`, and an item that fails validation `422
  CONTENT_VALIDATION_FAILED`. The codes the install, update and uninstall already answered
  (`LOCAL_CONTENT_EXISTS`, `VERSION_NOT_LISTED`, `INCOMPATIBLE_IHUB_VERSION`,
  `UNSUPPORTED_DEFINITION_SCHEMA`, `INTEGRATION_IN_USE`, `MIGRATION_LOCKED`, …) are unchanged and are now
  translated by the web app, which also shows them when an install from the catalog tile fails. The
  refusals of an integration that brings code (`CODE_NOT_TRUSTED`, `CODE_INTEGRITY_REQUIRED`,
  `INTEGRITY_MISMATCH`) used to answer `500` without a code; they now carry their code and answer `403`
  and `422`. A registry that cannot be created for another reason than a duplicate or an invalid config
  (for example a storage failure) answers `500` instead of `400`.
- The model administration endpoints (`/api/admin/models*`) answer in this shape: `NOT_FOUND`,
  `BAD_REQUEST`, `CONFLICT` (a model id that exists) and the failures below. The model discovery
  (`_discover`) answers `DISCOVERY_FAILED` with the stable reason in `details.messageKey` and the remediation
  text in `details.remediation` (`details.upstreamStatus` when the endpoint answered); before, these were
  top-level `messageKey`, `upstreamStatus` and a string `details`. The model connectivity test answers with
  the LLM error code (for example `AUTH_FAILED`), the headline in `error`, and the remediation text and
  `messageKey` in `details`. The text-to-speech voice routes use `NOT_TTS_MODEL`, `VOICES_UNSUPPORTED`,
  `INVALID_AUDIO`, `PAYLOAD_TOO_LARGE`, `UPSTREAM_ERROR` and `NO_AUDIO` instead of the former lower-case codes
  (`not-tts-model`, `voices-unsupported`, `invalid-audio`, `audio-too-large`, `upstream-error`, `no-audio`).
  The headline of a failed text-to-speech or transcription test is shown only when it is safe to show (it may
  name a host); the reason stays in `details.remediation`, which the admin page shows.
- The run endpoints (`/api/runs*`, answering an interaction, human events) answer in this shape:
  `NOT_FOUND` (a run or an interaction), `FORBIDDEN`, `BAD_REQUEST` (an unsafe id) and
  `VALIDATION_FAILED` with the failed fields in `details.issues` for a malformed answer or human event
  (before: one `error` text and a `details` object of `formErrors` / `fieldErrors`). The refusals of an
  answer keep their own status and code, now translated by the web app: `EXPIRED` and `RUN_DELETED`
  (410), `CANCELLED`, `NOT_PENDING`, `ANSWER_IN_PROGRESS` and `ANSWER_IN_CHAT` (409),
  `APPROVER_REQUIRED` and `UNAUTHORIZED_APPROVER` (403), and `INVALID_DECISION`, `INVALID_INPUT`,
  `INVALID_OPTION`, `REASON_REQUIRED` and `SKIP_NOT_ALLOWED` (400).
- The app administration endpoints (`/api/admin/apps*`) answer in this shape: `NOT_FOUND` (an app or its
  file), `BAD_REQUEST` (a missing field, an unsafe or changed id, a bad reorder list), `CONFLICT` (an app id
  that exists) and `VALIDATION_FAILED` for an app configuration that does not match the schema. The
  `error` text still names the failed fields; the failed fields are in `details.issues`
  (`{ path, code, message }`, `path` a dotted string) instead of a bare `details` list with `path` arrays.
- The in-place update endpoints (`/api/admin/update*`) answer in this shape: `BAD_REQUEST` for an installation
  that cannot be updated in place or an invalid request, `FORBIDDEN` for a missing write permission,
  `CONFLICT` for an update operation that is already running or no staged update, and
  `PAYLOAD_TOO_LARGE` for an upload over the limit. The codes the update already used are now upper case
  registry codes at the top level (before: lower case in `details.code`) and translated by the web app:
  `DISK_SPACE` and `CONFIG_SNAPSHOT_FAILED` (507), `UPDATE_PENDING`, `CONFIRM_DOWNGRADE`,
  `CONFIRM_UNSIGNED` and `STAGED_CHANGED` (409), `UNSIGNED_NOT_ALLOWED` (403) and `ARCHIVE_REJECTED` (422).
  A rejected archive keeps its `error` text; its staging summary moved from `summary` to `details.summary`.
- The chat endpoints (`/api/chats*`) and the file uploads of chats and scheduled tasks answer in this shape.
  The codes these routes already sent in `details.code` are now registry codes at the top level, with the
  web app's messages: `CHAT_PERSISTENCE_UNAVAILABLE` (503), `CHAT_OWNER_REQUIRED`, `USER_PROJECTS_DISABLED`
  and `APP_PROJECTS_DISABLED` (403), `PROJECT_TEST_CHAT_NOT_KEEPABLE` (409), `ORIGINAL_DISCARDED` (410, with
  `details.originalDeletedAt`), the upload refusals `QUOTA_FILE_BYTES`, `QUOTA_CHAT_FILES`, `QUOTA_CHAT_BYTES`,
  `QUOTA_API_FILES`, `QUOTA_API_BYTES`, `QUOTA_USER_BYTES` (413) and `QUOTA_SERVER_BYTES` (507),
  `BINARY_UPLOAD_NOT_ALLOWED`, `UNSUPPORTED_TYPE`, `SCAN_REJECTED`, `NO_TEXT` and `EXTRACTION_FAILED` (400),
  and the refusals of a file from a connected system `SOURCE_FORBIDDEN` (403), `SOURCE_GONE` (404),
  `SOURCE_UNAVAILABLE` and `SOURCE_INVALID` (400) and `SOURCE_FAILED` (502). Storage failures answer with
  their storage code (`INVALID_CURSOR` for a bad paging cursor, 400). Details of a refusal (a quota's
  `limit`, `used` and `size`) stay in `details`.
- The MCP App endpoints (`/api/mcp-apps*`) answer in this shape: `BAD_REQUEST`, `AUTH_REQUIRED`, `FORBIDDEN` and
  `NOT_FOUND` for an app or tool the caller may not use, `PAYLOAD_TOO_LARGE`, and `UPSTREAM_ERROR` (502) when
  the MCP server fails. "Connect this server first" is `409 INTEGRATION_AUTH_REQUIRED` with the server and the
  link to connect it in `details` (`integration`, `connectUrl`; before: top level, with `error: "auth_required"`),
  a refresh that failed for a transient reason is `503 MCP_AUTH_REFRESH_FAILED` (before: `error:
  "auth_refresh_failed"`), and a call that needs approval answers `403 APPROVAL_REQUIRED_NO_USER` or
  `409 APPROVAL_ALREADY_ANSWERED`. The message of a failing MCP server is shown only when it names no paths,
  hosts or credentials.
- The provider administration endpoints (`/api/admin/providers*`) answer in this shape: `NOT_FOUND` (a provider),
  `BAD_REQUEST` (an unsafe or changed id, a missing field, a reserved id, a built-in provider that cannot be
  deleted, a gateway setting that cannot be removed while models use their own dialect) and
  `409 PROVIDER_IN_USE` with the models that use the provider in `details.linkedModels`. An unexpected
  failure answers 500 with a fixed text; the cause is in the server log.
- The platform configuration endpoints (`/api/admin/configs/platform`, `/api/admin/voice/azure/test`) answer
  in this shape: `BAD_REQUEST` for a body that is not an object, a default language that is not a language
  code, a rejected `proxyAuth.sharedSecretHeader` or a `toolApproval` block that does not validate (the
  reason is in `detail`). An unexpected failure answers 500 with a fixed text; the cause is in the server log.
- The OAuth client administration endpoints (`/api/admin/oauth/clients*`, `/api/admin/oauth/public-key*`)
  answer in this shape: `BAD_REQUEST` while OAuth clients are switched off, for an unsafe id or an invalid
  body (the reason is in `detail`), `NOT_FOUND` for an unknown client or a public key that is not available,
  and 500 with a fixed text for an unexpected failure (the cause is in the server log).
- The agent profile administration endpoints (`/api/admin/agents/profiles*`) answer in this shape:
  `BAD_REQUEST` for an unsafe, missing or mismatched id or an invalid memory request, `NOT_FOUND` for an unknown
  profile, `CONFLICT` for a profile that exists already, and `VERSION_CONFLICT` (409) with the current version
  in `details.currentVersion` when a memory write lost the race. A profile that does not match its schema
  answers `VALIDATION_FAILED` with the failed fields in `errors` (before: `BAD_REQUEST` with the formatted
  schema issues in `details`). A failing model call keeps its canonical status through its LLM code.
- The group administration endpoints (`/api/admin/groups*`) answer in this shape: `BAD_REQUEST` for an unsafe
  id, a missing field, a protected system group, an invalid inheritance (the reason is in `detail`) or the
  removal of the last group with administrative access, `NOT_FOUND` for an unknown group and `CONFLICT` for
  a group id that exists. An unexpected failure answers 500 with a fixed text; the cause is in the server log.
- The agent run endpoints (`/api/agents/profiles/:id/runs`, `/api/agents/runs*`) answer in this shape:
  `BAD_REQUEST` for an unsafe id, a disabled profile or a run that cannot be resumed (the reason is in
  `detail`), `NOT_FOUND` for an unknown profile or run, `FORBIDDEN` for the run of somebody else (also when
  the authorization lookup itself fails), and `CONCURRENCY_LIMIT` (409) with the running count in
  `details.runningRuns`. An unexpected failure answers 500 with a fixed text; the cause is in the server log.
- The user administration endpoints (`/api/admin/auth/*`) answer in this shape: `BAD_REQUEST` for an invalid
  user id, a missing username or a password that is required or too short, `NOT_FOUND` for an unknown user,
  `CONFLICT` for a username that exists and `FORBIDDEN` for deleting the last admin user (the reason is in
  `detail`). An unexpected failure answers 500 with a fixed text; the cause is in the server log.
- The page administration endpoints (`/api/admin/pages*`) answer in this shape: `BAD_REQUEST` for an unsafe,
  missing or mismatched page id and for a content or title key that is not a language code, `NOT_FOUND` for an
  unknown page and `CONFLICT` for a page id that exists (the reason is in `detail`). An unexpected failure
  answers 500 with a fixed text; the cause is in the server log.
- The credential administration endpoints (`/api/admin/credentials*`) answer in this shape: `BAD_REQUEST` for an
  unsafe id or a body that is not an object, `VALIDATION_FAILED` with the failed fields in `errors` for an
  invalid credential (before: `BAD_REQUEST` with the schema issues in `details`), `NOT_FOUND` for an unknown
  credential and `CONFLICT` for a credential id that exists. An unexpected failure, including an unreadable
  credential store, answers 500 with a fixed text; the cause is in the server log.
- The client-metadata client endpoints (`/api/admin/oauth/clients/cimd/*` and the revoke-all route
  `/api/admin/oauth/clients/{id}/connections`) answer in this shape: `BAD_REQUEST` for OAuth clients that are
  not enabled, an identifier that does not decode and an invalid policy field (the reason is in `detail`),
  and `NOT_FOUND` for an unknown client. An unexpected failure answers 500 with a fixed text; the cause is
  in the server log.
- The short-link endpoints (`/api/shortlinks*`) answer in this shape: `BAD_REQUEST` for a missing target or a
  target that is not a path on this server or a URL on an allowed host, `NOT_FOUND` for an unknown code,
  `FORBIDDEN` for a link of somebody else and `CONFLICT` for a code that exists. The redirect `/s/{code}`
  keeps its plain-text answers. An unexpected failure answers 500 with a fixed text; the cause is in the
  server log.
- The skill endpoints (`/api/skills*`) answer in this shape: `BAD_REQUEST` for an unsafe skill name or a missing
  file path and `NOT_FOUND` for an unknown skill, missing skill content or an unknown resource (the reason is
  in `detail`). An unexpected failure answers 500 with a fixed text; the cause is in the server log.
- The CORS administration endpoints (`/api/admin/cors/config`) answer in this shape: `BAD_REQUEST` for an invalid
  field of the configuration (the field and the reason are in `detail`). An unexpected failure, including an
  unreadable platform file, answers 500 with a fixed text; the cause is in the server log.
- The agent inbox administration endpoints (`/api/admin/agents/inboxes*`) answer in this shape: `BAD_REQUEST` for
  an unsafe inbox id or a missing `body` or `text`, `NOT_FOUND` for an unknown inbox and `VERSION_CONFLICT`
  (409) with the current version in `details.currentVersion` for a stale `expectedVersion`. The inbox editor
  now recognizes that conflict by its `code` and shows the reload hint. An unexpected failure answers 500 with
  a fixed text; the cause is in the server log.
- The SSL administration endpoints (`/api/admin/ssl/config`) answer in this shape: `BAD_REQUEST` for an invalid
  field of the configuration (the field and the reason are in `detail`). An unexpected failure, including an
  unreadable platform file, answers 500 with a fixed text; the cause is in the server log.
- The SSRF allowlist endpoints (`/api/admin/ssrf/config`) answer in this shape: `BAD_REQUEST` for an allowlist
  that is not an array and for an entry that is not a string, is empty or is not a host pattern (the reason is
  in `detail`). An unexpected failure, including an unreadable platform file, answers 500 with a fixed text;
  the cause is in the server log.
- The admin translate endpoint (`/api/admin/translate`) answers in this shape: `BAD_REQUEST` for missing fields
  and, for a failing model call, the LLM code with its canonical status (as for the model test). A missing
  model or any other unexpected failure answers 500 with a fixed text; the cause is in the server log.
- The JSON schema endpoints (`/api/admin/schemas*`) answer in this shape: `BAD_REQUEST` for an unknown schema
  type (the allowed types are in `detail`) and `NOT_FOUND` for a type without a schema. An unexpected failure
  answers 500 with a fixed text; the cause is in the server log.
- The cache administration endpoints (`/api/admin/cache*`, `/api/admin/client/_refresh`), the value encryption endpoint (`/api/admin/encrypt-value`), the feature flag endpoint (`/api/admin/features`),
  documentation endpoints (`/api/admin/docs*`), version endpoints (`/api/admin/version*`), logging endpoints
  (`/api/admin/logging*`), system endpoints (`/api/admin/system*`) and rate limit endpoints
  (`/api/admin/rate-limits`) answer in this shape: `BAD_REQUEST` for an invalid value, `NOT_FOUND` for an
  unknown documentation page and, for an invalid rate limit body, `VALIDATION_FAILED` with the failed fields
  in `errors` (before: `BAD_REQUEST` with the schema issues in `details`). An unexpected failure answers 500
  with a fixed text; the cause is in the server log.
- The usage guide endpoint (`/api/admin/apps/_usage-guide`) answers in this shape: `BAD_REQUEST` for a missing
  app or an invalid language, `SERVICE_UNAVAILABLE` (503) when no chat model is available and, for a failing
  model call, the LLM code with its canonical status.
- The audit log (`/api/admin/audit-log*`), usage (`/api/admin/usage*`), UI customization (`/api/admin/ui*`),
  proxy (`/api/admin/proxy*`), translation override (`/api/admin/translations*`), overview and people directory
  editor administration endpoints answer in this shape: `BAD_REQUEST` for an invalid filter, date range, asset
  id, configuration or proxy setting (the reason is in `detail`; an invalid proxy configuration lists the failed
  fields in `errors`), `NOT_FOUND` for an unknown asset or language and `FORBIDDEN` for a proxy test target the
  SSRF guard blocks. The UI endpoints no longer answer an error with `{ success: false, message }`, and a UI
  configuration that is missing a section or has an invalid value answers `BAD_REQUEST` again instead of 500. An
  unexpected failure answers 500 with a fixed text; the cause is in the server log.
- The public page (`/api/pages/{id}`), renderer (`/api/renderers*`) and magic prompt (`/api/magic-prompt`)
  endpoints answer in this shape: `NOT_FOUND` for an unknown page, page file, renderer or app, `AUTH_REQUIRED` /
  `FORBIDDEN` for a protected page or a model the caller may not use, `BAD_REQUEST` for an invalid id or a
  missing input and, for a failing model call, the LLM code with its canonical status. An unexpected failure
  answers 500 with a fixed text; the cause is in the server log.
- The PDF export (`/api/exports*`), apps and models listing (`/api/apps*`, `/api/models*`), document template
  administration (`/api/admin/document-templates*`), content access (`/api/admin/content-access*`) and chat
  history administration endpoints answer in this shape: `NOT_FOUND` for an unknown app, model, template or group,
  `BAD_REQUEST` for an invalid id, type or upload, `CONFLICT` for a template that already exists,
  `PAYLOAD_TOO_LARGE` for a template file over the limit, `SERVICE_UNAVAILABLE` / `TIMEOUT` when the document
  renderer is busy or too slow (before: a plain `error` text), and `INTERNAL_ERROR` with a fixed text for an
  unexpected failure; the cause is in the server log.
- The change history (`/api/admin/changes*`), usage limits (`/api/admin/usage-limits*`), Nextcloud embed,
  Microsoft Office add-in and Copilot agent administration endpoints, the example apps of an installed integration
  and the app session and usage endpoints answer in this shape: `BAD_REQUEST` for an invalid id, resource or
  value (the reason is in `detail`), `NOT_FOUND` for an unknown snapshot or installation, `CONFLICT` for an
  installation whose definition is not loaded or an app id that already exists, the existing
  `COPILOT_AGENT_DISABLED`, `COPILOT_REFERENCE_ID_MISSING` and `COPILOT_PUBLIC_HTTPS_REQUIRED` codes for a
  Copilot package that cannot be built yet, and `INTERNAL_ERROR` with a fixed text for an unexpected failure;
  the cause is in the server log.
- The Office 365, Google Drive, Nextcloud and Jira integration endpoints (`/api/integrations/*`), the
  storage-provider access check that guards them, the personal API key, connection and scope endpoints answer in
  this shape: `AUTH_REQUIRED` for a missing session, `FORBIDDEN` for a caller or source that is not allowed,
  `BAD_REQUEST` for an invalid id, `NOT_FOUND` for an unknown installation, key or feature, the existing
  `STORAGE_PROVIDER_REQUIRED`, `STORAGE_PROVIDER_NOT_FOUND` and `INTEGRATION_NOT_GRANTED` codes for a storage
  request without a usable provider, and `INTEGRATION_AUTH_REQUIRED` (409, with the Connect card details) when the
  user has no usable connection. An unexpected failure answers 500 with a fixed text; the cause is in the server
  log.
- The agent run artifact (`/api/agents/runs/{id}/artifacts*`), OCR and tool job, chat feedback, release changelog,
  OAuth connection and iFinder assistant administration endpoints answer in this shape: `NOT_FOUND` for an unknown
  run, job, artifact or connection, `FORBIDDEN` for a run that is not the caller's or an app that turned feedback
  off (`FEATURE_DISABLED`), `BAD_REQUEST` for an invalid upload, id or value, `CONFLICT` when iFinder is not
  configured, `UPSTREAM_ERROR` (502) when iFinder cannot be asked, and `INTERNAL_ERROR` with a fixed text for an
  unexpected failure; the cause is in the server log. The voice routes keep their own codes as before.
- The user integration endpoints (`/api/integrations`, connect, reconnect, disconnect and preferences), the browser
  extension, Office add-in and Nextcloud embed configuration endpoints, the LDAP test, admin search and browser
  extension administration endpoints, the chat configuration endpoints (`/api/styles`, `/api/translations`,
  `/api/configs/*`) and conversation lookups answer in this shape: `AUTH_REQUIRED`, `JSON_REQUIRED`,
  `INTERACTIVE_SESSION_REQUIRED`, `INTEGRATION_NOT_FOUND`, `INVALID_APP`, `APP_NOT_FOUND` and
  `PREFERENCES_UNAVAILABLE` as before, and a failed sign-in start answers the new `INTEGRATION_CONNECT_FAILED`
  with the flow's own reason (`discovery_failed`, `public_url_mismatch`, ...) in `details.reason` (before: the
  reason as `code`). An unexpected failure answers 500 with a fixed text; the cause is in the server log.
- The route guards answer in this shape too: the admin guard (`FORBIDDEN`, 403), the content admin guard
  (`AUTH_REQUIRED` for a missing sign-in, `FORBIDDEN` for a user who may not edit content), the sign-in guards
  (`AUTH_REQUIRED`, 401), the app and model access guards (`APP_ACCESS_DENIED` / `MODEL_ACCESS_DENIED`, 403; now
  in the code registry) and the rate limiters (`RATE_LIMITED`, 429, with `Retry-After` as before). Every guard
  still fails closed: a refused request never reaches the route behind it.
- The first-run setup endpoints (`/api/setup/*`), the Teams token exchange, the reverse proxy sign-in and the OIDC
  login start answer in this shape: `BAD_REQUEST` for an invalid provider or key, `FORBIDDEN` when the system is
  already configured, `NOT_FOUND` for an unknown provider, the Teams codes (`TEAMS_SSO_TOKEN_REQUIRED`,
  `TEAMS_AUTH_NOT_ENABLED`, `TEAMS_ACCOUNT_DISABLED`, `TEAMS_INVALID_OR_EXPIRED_TOKEN`) as before, and the new
  `USER_VALIDATION_FAILED` (403, with the validation's own message) when a reverse proxy user is refused. A
  Teams request without a token or with Teams sign-in turned off is no longer answered as an invalid token.
  Every sign-in path still fails closed.
- The chat endpoints (`/api/apps/{appId}/chat/{chatId}` to send a message and to connect the live stream, and
  `/api/models/{modelId}/chat/test`) answer in this shape: `NOT_FOUND` for an unknown chat, app or model, the existing
  chat codes (`GUEST_COOKIE_MISSING`, `CHAT_STORAGE_UNAVAILABLE`, `CLIENT_HISTORY_NOT_ALLOWED`, `UNKNOWN_MESSAGE`,
  `CHAT_OWNER_REQUIRED`, `APP_NOT_FOUND`, `INVALID_APP`, the tool approval and project refusals) as before, the model
  call's own code and status (`TIMEOUT`, rate limits, provider errors) and `INTERNAL_ERROR` with a fixed text for an
  unexpected failure; the cause is in the server log. A refusal is no longer logged as a chat error.
- The iFinder authorization routes (`/api/integrations/ifinder/authorization`), the feature gate (`FEATURE_DISABLED`,
  403), the workflow chat route (`CHAT_STORAGE_UNAVAILABLE`, 503) and the admin prompt completions answer in this
  shape. The iFinder routes keep the status the token store reported and show its message only for a client error.
- A request whose declared body is larger than the configured limit is refused with `PAYLOAD_TOO_LARGE` (413) in this
  shape instead of the plain text `Payload Too Large`.
- The sign-in routes (`/api/auth/local/login`, `/api/auth/ldap/login`, `/api/auth/ntlm/login`) and `/api/auth/user`
  answer in this shape: `BAD_REQUEST` for missing credentials, a turned-off method, an unknown LDAP provider or an
  invalid return URL, `AUTH_REQUIRED` (401) for refused credentials or an unfinished NTLM handshake, and
  `RATE_LIMITED` (429, with `Retry-After`) for a locked account. They still fail closed: any other failure inside a
  sign-in handler answers 401, never a 500, and the cause stays in the server log. The wording of the messages is
  unchanged.
- The project routes (`/api/projects`, `/api/projects/{id}/items`, the pickers, the smart collections and
  `/api/admin/projects`) answer with the project's own error code in `code`, as every other route does, instead of
  inside `details.code`. `details` now holds only the extras (`limit`, `used`, `required`, `reason`, …). The client
  reads `code` first. New registry codes carry the English and German texts: `PROJECT_NOT_FOUND`, `PROJECT_EXISTS`,
  `QUOTA_FILES`, `ITEM_NOT_READY`, `KIND_DISABLED`, `IFINDER_REJECTED` and the other codes of the project service.
  The access guards still fail closed: a refused request never reaches the route behind it.
- The routes that still answer errors with their own body are converted to this shape one by one in
  the following releases; each conversion is listed here.
- The remaining routes now answer in this shape too: the authentication middleware (`AUTH_REQUIRED`,
  `TOKEN_EXPIRED`, `FORBIDDEN`), the admin routes for providers, groups, UI, translations and usage
  limits, the agent run and artifact routes, the project and
  project item routes, the chat session, history and short-link routes, the voice routes of the chat
  (`/api/voice/*`), the integration connection routes, the Teams sign-in and the feature gate. The `success: false`
  flag and the separate `message` member are gone from their error bodies: the text is `detail`.
  A conflict names what the caller needs in `details` (`currentVersion` of a `VERSION_CONFLICT`,
  `linkedModels` of a provider that is still used by models, `runningRuns` of a `CONCURRENCY_LIMIT`,
  the `summary` of a rejected update archive). A failed model test carries its remediation text in
  `details.remediation` and its `messageKey` in `details.messageKey`.
- Reading the sections above: where one says `error`, the member is now `detail`, and a list that
  is described as `details.issues` is now the `errors` list.
- The read-aloud routes (`/api/voice/speech`, `/api/voice/azure/token`) answer with registry codes instead of the
  former kebab-case strings: `INVALID_TEXT`, `TEXT_TOO_LONG`, `INVALID_MODEL`, `INVALID_LANGUAGE`, `INVALID_VOICE`,
  `NO_SPEAKABLE_TEXT`, `NO_AUDIO`, `TTS_NOT_CONFIGURED`, `MODEL_NOT_FOUND`, `MODEL_DISABLED`, `MODEL_ACCESS_DENIED`,
  `RATE_LIMITED` (too many syntheses at once) and `UPSTREAM_ERROR`. This is a clean break: a client that compared the
  old strings has to compare the new ones. The web app is updated. The codes of the voice WebSocket
  (`unknown-model`, `not-permitted`, …) are a different protocol and stay as they are. The discovery and JWKS
  endpoints under `/.well-known/` answer their failures in the OAuth shape (`error`, `error_description`) like the
  other protocol endpoints, and an expired token on an API route is answered `TOKEN_EXPIRED`
  (401) through the same error middleware as the other routes.

See [Error Responses](../../error-responses.md).

## Chat: Answers Read Like a Document, in One Centred Column

The chat now follows the layout of current AI assistants. Answers are plain text on the page
instead of a white card, so tables, code and diagrams get the full width, and long answers are
easier to read. The user's own messages sit in a neutral grey bubble on the right.

- Messages and the message box share one centred column of about 70 characters per line, so the
  question, the answer and the input line up.
- Sender icons are no longer shown next to messages. On phones and in narrow panels the answer
  gains that width. The `icons.userMessage` and `icons.assistantMessage` settings in `ui.json` no
  longer have a visible effect.
- The main area of the app is now white and the sidebar light grey, which was the other way round
  before. This holds on every page, not just in the chat: the start page, the apps list, all
  chats, scheduled tasks, projects, the integrations settings and a shared chat look the same.
- Error messages keep their red callout.

## Projects: Try a Project in a Chat Before You Link It

The project editor has a new **Try in chat** button. It opens a scratch chat beside the editor
that has this project and nothing else in scope, so an admin can check that sources, instructions
and files work without building an app first. When an answer is wrong it shows whether the cause
is the project or the app and the model.

- Pick the app (the general chat by default) and, in the chat, the model. The other projects the
  app links are left out, and during the test it cannot call other apps or workflows.
- Each answer shows its sources, the knowledge searches that were made and what they found, as in
  any chat.
- The chat runs as you, on the project as saved, and a disabled or unpublished project can be
  tried. How other users reach the project is not tested; the panel says so. It also says how many
  items are not searched yet because they are still being processed or failed.
- The chat is temporary: it is not listed in your chat history and nothing is added to the
  project.

See [Projects](../../projects.md#try-in-chat).

## Projects: Edit a Web Page, iHub Page or iFinder Item After Adding It

A link item of a project — a web page (URL), an iHub page, an iFinder document or an iFinder
search — can now be changed after it was added. Before, fixing a mistyped URL or pointing an item
at another page meant removing it and adding it again.

- **Edit** in the item's actions opens the same fields used for adding, filled with the current
  values, together with the item's name. The change takes effect at once, without a restart. An
  item still named after its old URL or page takes the new one's name; a name you chose stays.
- Admins also get **Rename** in the item list of an admin project, which only user projects had.
- Uploaded and written documents, cloud documents and documents linked from another project have no
  address to change; they are renamed, or removed and added again.
- API: `PATCH /api/projects/:id/items/:itemId` and `PATCH /api/admin/projects/:id/items/:itemId`
  accept `ref` next to `name` and `pinned`. The reference is checked like a new item's and
  replaces the stored one as sent.

## Embed Mode: Steer an Embedded iHub from the URL Without Changing It for Direct Visits

A page that embeds iHub in an iframe — iFinder's standard iHub integration, a portal, an intranet
page — can now control iHub's chrome, colour mode and language from the URL, and none of it is
remembered in the browser outside that tab. Before, `?sidebar=false`, `?header=false` or
`?language=de` in an iframe were saved in `localStorage`, so on a same-site subdomain they also
changed iHub for people who opened it directly, and the colour mode could not be set from the URL
at all.

- **`embed=true`** switches embed mode on for the tab. Header, footer and sidebar, the colour mode
  and the language are then kept in the tab's `sessionStorage` and `localStorage` is neither read
  nor written for them. They survive navigation inside iHub and a reload of the frame, and are gone
  when the tab closes. Loading an embed URL starts a fresh session, so the URL the host builds is
  what the user gets.
- **`mode=light|dark|auto`** is new and sets the colour mode. It applies before the first render,
  so the page does not flash the other mode. Outside embed mode it is stored like a click on the
  dark-mode toggle.
- **`header`, `footer`, `sidebar` and `language`** keep working. An embed starts without iHub's
  header, footer and sidebar; the host switches a part on with `=true`. Only `en` and `de` are
  accepted for `language` (`de-DE` selects `de`); invalid values for `mode` and `language` are
  ignored — outside embed mode too.
- Example: `/apps/translator?embed=true&sidebar=false&header=false&footer=false&mode=dark&language=de`
  shows the Translator without iHub's chrome, in dark mode and in German, and opening iHub
  directly afterwards shows the user's own settings.
- An embed does not publish its language on the cross-product `intrafind` `BroadcastChannel`, so it
  cannot switch the language of other iHub tabs.
- The Nextcloud embed already ran in this mode; its colour mode and language now stay in the
  iframe's tab as well instead of being read from and written to `localStorage`.
- Not covered: the recently used apps list, the collapsed state of the sidebar and the sign-in
  token are still stored in the browser as for any visit.

See [Embedding iHub in Another Product](../../embed-mode.md).

## Audit Log: Open an Entry, and See Which Groups a Sign-in Brought Along

Every entry in **Admin → Audit Log** now opens in a detail panel — click the row or the eye icon.
For sign-ins through an external identity provider, the panel shows where the user's groups came
from, so admins can check what an Entra ID or other OIDC user actually got, even without an active
session.

- **Groups from the identity provider:** the groups the provider sent at sign-in (for Entra ID
  usually group ids), each with the iHub groups it maps to, or **Not mapped**.
- **Assigned manually:** the groups an admin gave the user under **Users**.
- **Added automatically:** groups such as `authenticated` or the provider's default groups.
- **Effective groups:** what the user ended up with.
- Recorded for OIDC, LDAP and NTLM sign-ins. The values are a snapshot from that sign-in; changes in
  the identity provider show up with the next one. At most 200 provider groups are listed per
  sign-in, with the total.
- The audit log search also finds provider group names, so searching an Entra group id lists who
  signed in with it.
- Display only: who may do what is still decided by the groups of the current session, and nothing
  is added to `users.json`.

## Open a Document from Another System: Choose the App in iHub

A link such as `/apps?documentId=<id>&integration=ifinder` (optionally `&searchProfile=<id>` and
`&prefill=…`) now opens the app list with the document waiting. Before, the system linking to iHub
— for example the "Open in iHub" action of an iFinder hit — had to know the target app up front.
The link names the **integration** the document comes from; the earlier `source` parameter is
gone.

- **Pick an app:** a banner names the document and the app you choose opens with it attached. The
  link is followed in a new tab, and after signing in, as well. `/start?documentId=…` hands over to
  the same list.
- **Only apps that bind the integration:** an app is offered when it binds the integration the
  document comes from (iFinder under **Admin → Apps → Edit → Installed integrations**); the binding
  is what lets it receive the document, whatever its local upload settings are. An app that never
  opted into iFinder never receives an iFinder document. A checkbox in the banner, on by default,
  turns the filter off; it is left out when no app qualifies.
- **The link keeps its `integration`:** the sign-in clean-up of the page removed `integration` from every address, which dropped the document before the list could use it. It now removes `integration` only next to a sign-in error (`integration_error`).
- **The integration is switched on:** the chat opens with the integration's tools on, even when your saved default for the app has them off, because the link came from that system. The app list narrows as soon as the integration answers, without waiting for the document's details.
- **The server fetches the document:** an iFinder document is attached by reference. The server
  fetches the original with your own iFinder permissions, stores it with the chat and extracts the
  text, like an upload without the upload; it never passes through your browser. Whether the
  original is kept or only the text is the usual upload storage mode. Images and audio, which a
  model needs as bytes, are still fetched in the browser and attached as an image or audio.
- **Clear errors:** an integration that is not available to you, a document you may not read, or
  one that no longer exists is reported in the banner before you choose an app, and the app then
  opens without it. A document that fails to attach in the chat now says so instead of silently
  attaching nothing.
- **Nothing is attached twice:** the parameters are removed from the address once the app has
  used them, so a refresh does not attach the document again. `send`, `model` and `var_*` are not
  passed on from the list.
- **API:** installed integrations that declare the `files` capability hand over documents by
  reference, as resources of the integration: `GET /api/integrations/:integration/files` (the
  probe), `/files/:id` (the document's details), `/files/:id/content` and
  `/files/:id/content/:filename` (the same bytes under a name for a browser or viewer). The id is a
  URL-encoded path segment; `scope` and `format` are query parameters. They answer `404` when the integration is not installed or configured and `403` when the user's
  groups do not grant it (an upstream `401` is answered as `403`, so it never reads as an expired
  iHub session). These routes are the one way to a source's content and details for Preview,
  Download, Add to email, Details and Open in App: the old `GET /api/sources/:provider/content` and
  `/metadata` are removed, and `project` documents answer the same routes under their own access
  rules. The integrations feature switch does not apply to them. iFinder 1.2.0 is the first
  integration to declare the capability.
  A chat file fetched from an iFinder document needs the same grant: a user whose groups may not use
  iFinder gets `403 SOURCE_FORBIDDEN`. The same applies to the sources of an iAssistant answer, which
  carry `provider: ifinder`: preview, download and details of a citation need the grant of the
  `ifinder` installation, so a group that may use the iAssistant but not iFinder gets
  `403 INTEGRATION_NOT_GRANTED` for them. Grant both to such groups.

See [Auto-Send and URL Parameters](../../auto-send-feature.md#document-attachment-from-an-integration).

## Attachments: See What the Assistant Gets and Download It

Each attachment under the composer now says what the assistant gets from the file: the characters of
text extracted from a document, the page images sent instead for a scan without a text layer, or the
size an image is sent in. Once the server stored the file, it also says when only the text is kept
or the text was shortened.

- **Download after attaching:** a file that came from a cloud storage or an integration, such as an
  iFinder document opened from a link, has buttons to download the original file and, for a document,
  the extracted text (from the stored file when the server fetched it). A local file is yours already and has none. Images and audio from these sources
  keep their original for the download.
- **After sending:** the files of a message are shown as cards above it, not as a badge inside its
  text, and they are the same cards before and after a reload and in a shared chat. A document
  opens in the **Files** panel with a click or Enter, an image shows a thumbnail, and audio is a
  card of its own. Each card repeats what the assistant got from the file, and once only the text
  of a file is kept it says so instead of showing a size. The thumbnail and the "what the assistant
  got" line are shown the same way after a reload; for a document the server stored it keeps what
  it read. A picture is kept by the server now, so its thumbnail is back after a reload, and its
  card opens it in the **Files** panel, where it can be previewed, downloaded and deleted. It
  follows the rules of an original: only in the `original_and_text` mode, kept for
  `originalRetentionDays`, counted against the storage quotas but not against the number of files
  of a chat, never read by the assistant as a document, and shared in a chat share only with the
  originals. More than four files fold into **+N more files** (more than three on a phone or
  in the Outlook task pane). In a shared chat a file the owner did not share is marked as such.
- **Outlook task pane and browser extension:** the cards of a message now open their file in the
  Files panel, a full-pane sheet on the narrow pane, with **Attach to email** while a mail is being
  written. They were plain cards there.
- **Copy and link:** copying a message, or its link, gives the text you typed. It no longer
  carries the markup of a file badge.
- **Images and a model without vision:** an image attached before switching to a model that cannot
  see images now stops the message with a note instead of sending it; audio already did. Dropping
  an image or a sound file on a model that cannot take it now says so and suggests another model,
  instead of the list of accepted formats.
- **Export:** the JSON and JSONL export of a chat no longer contain the contents of the attached
  files (their text and base64 data) for a message sent in the current session; each file is
  listed with its name, type and size (see the breaking changes).
  
## LLM Timeouts Configurable for All Providers and Per Provider

A model that goes silent for a while — Gemini with thinking switched on, for example — could stop with
"stopped sending stream chunks for 60000 ms", and raising the limit meant editing `platform.json` and
restarting, or changing every model. The two transport limits now have a place in the admin UI at every level:

- **Admin → Models → Providers → Timeouts for all providers:** the **connect timeout** (longest wait for the provider's
  response headers, default 30 s) and the **stream idle timeout** (longest silence between two chunks of a
  running stream, default 60 s) for the whole installation.
- **Provider page:** a **Timeouts** section gives all models of one provider their own values, so every Google
  thinking model can share one ceiling. A field left empty uses the installation value.
- **Model page:** unchanged, and still the most specific level. Its fields now say what an empty value means.

The order is model, provider, installation, environment variable (`LLM_CONNECT_TIMEOUT_MS`,
`LLM_STREAM_IDLE_TIMEOUT_MS`), built-in default. Values run from 0 to 300000 ms; `0` turns a limit off. Changes
apply to the next request — no restart. No migration is needed: providers without the new fields behave as before.

See [LLM client → Tuning the ceilings](../../llm-client.md#tuning-the-ceilings).

## Models and Providers in One Admin Area

Web search, storage and tools are integrations now, so **Providers** is only the connection to a model
endpoint. It no longer has a page of its own in the menu. **AI Workspace → Models** has two tabs, **Models**
and **Providers**, and each links to the other.

- **Models tab:** the provider column names the provider (a custom provider's name, not `openai`) and links to
  it; filter by **Provider**, **Type** and **Status** (kept in the address); **Add New Model** and
  **Import models** are the primary actions, **Upload Config**, **Install from Marketplace**, **Enable All**
  and **Disable All** moved into a **⋮** menu.
- **Set up your models:** a three-step strip (a provider with a key, an enabled model, a default model) replaces
  the "Get started" panel and goes away when the steps are done.
- **Providers tab:** each row's model count opens the Models tab for that provider, **Import models** opens the
  import for it, and a ⏱ marks a provider with its own timeouts. The description and status columns are gone
  (the description is a tooltip, a disabled provider is tagged). **Timeouts for all providers** is one summary
  line you can open with **Edit**.
- **Provider page:** **Add model** creates a model with the provider already chosen.
- **Add provider** always creates an LLM provider; the category choice is gone. Entries of other categories
  that an older installation still has stay reachable under a collapsed **Other credentials** group.

Nothing else changes: addresses (`/admin/models`, `/admin/providers`), permissions (`admin.pages.providers`
still decides whether the **Providers** tab is shown), data files and the API stay as they are.

See [Admin UI → Managing Models](../../admin-ui.md#managing-models).

## Created Resources Can Be Read Back From Their `Location`

Two creates answered a `Location` that had no matching read. `GET /api/integrations/api-keys/{keyId}`
now answers the metadata of one of your personal API keys (never its secret), and
`GET /api/integrations/requests/{requestId}` answers one of your own integration requests. Both
answer `404` for an id that is not yours. `GET /api/workflows/{id}` now also answers a disabled
workflow to an administrator, so the `Location` of a create that saved it as disabled resolves.

## Switch Skills Off and Change Their Description

**Admin → Skills → (a skill)** now switches an installed skill on or off and changes the description
shown for it. A skill that is off is offered to no app, user, agent or MCP client, and its files stay
installed. A description you set replaces the one in `SKILL.md` wherever the skill is listed, and a
marketplace update does not overwrite it. System skills cannot be changed. The settings are kept in
`contents/config/skills.json`, a new file that a fresh install and an upgrade create.

## Tool Search: Apps With Many Integrations Stop Sending Every Tool on Every Request

An app with many integrations used to hand the model every tool definition of every integration on
every request, even for a turn that used no tool. That made requests larger and slower, blurred tool
choice on smaller and local models, and changed the request start whenever the tool set changed.
With **Tool Search** switched on, an app whose integration tools exceed a token budget sends only
what fits. The biggest integrations are left out and listed in the system prompt, and the model
finds a tool with `search_tools`: the tools it finds are added to the request, and the model calls
them like any other tool.

- **Off by default.** Switch it on under **Admin → Features → Tool Search** (preview). An app, a
  chat or an integration that does not exceed the budget sends exactly the request it sent before.
- **Whole integrations, biggest first.** The list names each left-out integration with its tools.
  If the list itself grows too long it shortens to tool names, then to integrations with their
  tool counts. It depends only on the tools, never on the message, so it stays the same from turn
  to turn.
- **Found tools are ordinary tools.** Approval, connection checks, scopes, progress, chat history,
  MCP App views and usage logs show the tool by its own name. A write that needs approval still asks
  first, and a tool the model has not found cannot be called. One search loads at most five tools,
  and one run at most 15.
- **A turn that searches changes the request.** The found tools join the tools list, so a provider's
  prompt cache no longer applies to the steps after the search. A turn that does not search sends
  the same request as before. A tool found in one turn is not carried into the next: the model
  searches again when it needs it.
- **Per app:** **Admin → Apps → (an app) → Tools → Tool search** switches it off for the app or
  sets the token budget for its tool definitions (default 6000, never more than a tenth of the
  model's context window, so a small local model gets a smaller budget).
- **Per integration:** tick **Always loaded** on an integration's binding to always send its tools
  in full. Web search engines, the question to the user (`ask_user`), skills, project knowledge,
  workflows and apps used as tools are never left out.
- **Only for models that call tools.** Agents and workflows keep sending the tools they list.

No migration is needed: the new settings are optional and absent means automatic.

## Projects: Delete Several Documents at Once

Tick documents in a project and choose **Delete** to delete them all after one confirmation.

- **Admin → Projects → (a project):** **Delete** sits next to **Move to…** and **Copy to…**.
- **A user's project page:** owners and editors tick documents and choose **Delete**. In an iFinder
  smart collection the button is **Remove**: the documents leave the collection and stay in iFinder.
- Each document is removed on its own and recorded like a single removal.
- A document that cannot be deleted stays in the list and stays ticked, and the page says why, so
  you can try it again.

## Chat: Sources Sit at the End of the Answer, Next to the Basis Chip

An answer used to show two near-identical lines above its text: **Searched the web · 1 search · 10
sources** and, right under it, **Searched for “…”** with the sites' icons. The entry to the
sources has moved to the end of the answer. The top of an answer now says how it searched, and
the end says what it rests on.

- Under the answer: **Cited in this answer**, then one row with the entry at the start and the
  basis chip at the end (for example **Web**). In narrow panes (Outlook, the browser extension,
  phones) the chip moves to its own line.
- The entry reads **10 results** instead of **Searched for “…”**, and the activity line above the
  answer counts **results** too. Not "sources": the count includes everything the search found,
  and only what the answer cites is a source of it. The searches are listed in the panel's header.
- The entry appears once the answer is complete. While the answer is still being written, the
  numbered badges in the text open the panel, and a panel that is open stays open when the answer
  completes.
- Closing the panel returns the keyboard focus to whatever opened it: a badge in the text, a
  number in the cited list or the entry. Focus you have moved elsewhere, for example to the
  message box, stays there.
- The entry and the chip are the same height, and both have an outline because both can be
  clicked.
- An answer that links none of its sources, but was written from pages the search read, lists
  those pages as **Read for this answer** in the cited list's place, and at the top of the panel;
  the other results stay under **Also considered**. The panel shows a section only when it has
  entries, so an empty **Cited in this answer (0)** no longer appears.

See [Answer Sources](../../answer-sources.md#what-users-see).

## Chat: The Input Is One Line Once the Conversation Has Started

A multi-line app now shows its configured rows (**Rows in a new chat** in the app editor, formerly
**Textarea Rows**) only before the first message, where users often write a long request. Once the
conversation has started, the input is a single line that grows as the user types, so the answers
get the space back. **New chat** brings the configured rows back.

- The input grows up to 12 lines or 40% of the window, then scrolls. While it grows, the
  conversation stays scrolled to the end, so the answer being replied to stays in view.
- A chat opened from the history starts with the one-line input; so does the canvas side panel.
- **Outlook Add-in:** the input never grows beyond 3 lines, even for an app that asks for more rows.
- Single-line apps now really show one line (they showed two), and a long placeholder no longer
  makes the one-line input taller.
- While a multi-line message is being written, **Ctrl + Enter to send** (**⌘ + Enter** on a Mac)
  shows next to the token count, and screen readers announce how to send.

## Outlook Add-in: Expand the Chat Input for a Long Prompt

The chat input in the Outlook task pane stays small (up to 3 lines) so the conversation keeps the
space. An **Expand input** button at the top right of the input now opens a taller editing area —
about half the pane — so a long prompt can be read and edited without scrolling inside 3 lines.

- The text, the cursor position and the focus stay as they are when the input expands or
  collapses.
- The input collapses again when the message is sent, on **Esc**, on a second click and when a new
  chat starts.
- Available in the chat and on the start page. The header and the send button stay visible, also
  in a narrow pane.
- The web app and the canvas are unchanged.

## Projects: A Web Page Is Named After Its Title

A web page added to a project without a name now shows the page's title instead of its URL. A name
you type is kept as it is, and pages picked from a site crawl keep the titles the crawl found. A
page that cannot be read when it is added keeps its URL as the name.

## Projects: Up to 200 Items, and the Limits Are Set in the Admin UI

A project can now hold up to 200 items, the same number of documents an iFinder smart collection
holds, and by default holds 100 items and 500 MB (was 25 items and 200 MB). Admins set the project
limits under **Admin → Projects → Project settings** instead of
editing `platform.json`, and a change applies at once, without a restart.

- Four limits: items per project (100 by default, at most 200), size of one file (20 MB) and of
  one project (500 MB), and projects per user (0 for no limit).
- An upgrade raises the item and project size limits only where they still hold the old defaults; a
  value an admin chose stays.
- Lowering a limit removes nothing; it only refuses what would go past it.
- Adding several iFinder documents to a smart collection project at once takes up to 200 per call.

## Projects: The Model Knows Which Documents a Searched Project Holds

When a project is too large to load in full and is searched instead, the model now sees a list of
its documents, not just a count. It can pick the page or file that answers the question and read it
directly, instead of searching blindly first.

- Each listed document shows its name, size and, for web pages, its URL, plus the document's own
  title and a short description when iHub knows them.
- The title and description are captured automatically: from an uploaded file's metadata or first
  heading and paragraph, from a web page's title and description when it is added (or, for
  pages added earlier, the first time it is read), from an iHub page's configured title, and from
  an iFinder document's title, else its file name.
- The list stops at 50 documents per project; the model is told how many more there are and how to
  list them all.

## Projects: Files Linked From Websites Are Stored Like Uploads, With a Refresh Schedule

A web address that serves a document — PDF, Word, PowerPoint, Excel, OpenDocument or any other
type an upload accepts — is now downloaded when it is added to a project and stored like an
uploaded file, instead of being read live. Its whole text is available, no longer cut at 50,000
characters, and the item keeps its source address for citations and refreshes. HTML pages stay
live links.

- The download follows the upload rules: the file size and project size limits, the accepted
  types and the malware scan. An address that serves an image, an archive or a legacy Office file
  is refused like the same upload would be.
- **Find more pages of this website** now also lists Word, PowerPoint, Excel and OpenDocument
  files, not only PDFs. **Include files on other websites** adds the documents its pages link to
  on another host, such as a download server.
- An address that ends in `.pdf`, `.docx` and the like is added as a file even when the website
  does not answer at that moment; **Retry** downloads it later.
- How long a file from a website or a web page counts as current is set per installation
  (**Admin → Projects → Project settings**, one day by default), per project (**Refresh** in the
  project's side panel) and per item (**Refresh schedule** in the item menu), or set to **Never**.
- Files are downloaded again on their own once that time has passed. An unchanged file is
  neither downloaded nor read again and keeps its text. The item shows when its text was taken
  and when it is refreshed next; **Refresh** still works at any time. Web pages are read again
  after the same time, and **Refresh** on a web page applies on every server process.
- Uploads never wait behind scheduled refreshes.
- Files picked from OneDrive, SharePoint, Google Drive or Nextcloud are still refreshed only by
  hand, because that needs the account of the user who picked them.

## Projects: Choose How a Project Reaches the Model, per Project and Link

How a project reaches the model used to be fixed: chats and attached projects always used
`auto`, and only administrators could set a mode, only on app and workflow links. Now there are five
**knowledge modes**, and owners and editors can choose:

- **Automatic** (the default): everything when it fits, otherwise the pinned documents plus the best
  sections for the question.
- **Read everything** (`context`): everything, up to 75 % of the model's context window. For a contract, a policy or
  a specification that must be read whole.
- **Best passages** (`relevant`): the pinned documents plus the best sections for the question from all
  documents, word for word. For large projects and models that call tools poorly; it works for iFinder
  smart collections, too, and saves a tool round trip.
- **Look things up** (`tools`): the pinned documents only; the model searches the rest.
- **Pinned documents only** (`pinned`): the pinned documents only, and the model cannot reach the others, because no
  knowledge tool is offered for the project.

The mode belongs to the project, not to the chat: a chat never changes it. Where it is set, the first
that is set wins: the mode on the **link** of an app or workflow (set by an administrator), then the
**project's own default** (**Knowledge mode** on the project page; for admin projects in the project
editor). You choose the mode of your own projects; the mode an administrator set, or the owner of a
project shared with you, applies as set. A link without a mode now uses the project's default; links
that say `auto` keep saying it. In **Admin → Projects → Project settings**, "Knowledge modes users may
choose" lets you switch a mode off, for example full context to save cost; links and admin projects
an administrator set keep their mode.

- **Not for AI:** an item can be marked "Not for AI" with the "For the AI" setting in its Edit
  dialog, next to Pinned. It stays in the project for people (preview, download, sharing) but is never given to the
  model, listed or searched.
- **Models without tools** cannot call `knowledge_search`. For them Look things up reads as Best passages,
  so unpinned documents are not silently out of reach.
- **The answer** names the mode a project was used in, under **About this answer**, and says when it was replaced.

**API:** `knowledgeMode` on projects (`POST` and `PATCH` `/api/projects`, the admin project
documents), `excludedFromAi` on items,
`knowledgeModes` in the project settings and the platform config. All additive.

See [Projects → Knowledge modes](../../projects.md#knowledge-modes).

## Long Pages and Documents Are Read for the Question, Not From the Top

When the section that answers a question is far into a long web page or project document, the
model now gets that section, not just the first part of the text. The text is returned
word for word, ranked with the keyword search iHub already uses; no extra model call is made.

- **Web pages:** `read_url` takes a `focus` (the question). On a page longer than the read length,
  the result holds the best-matching sections with their headings and positions, plus an outline of
  the whole page; the model can read on from any position in it. Without `focus`, nothing changes.
- **Projects too large to load:** a project linked in `auto` mode now puts its pinned documents
  and the sections of the other documents that best match the user's latest message into the
  prompt, each marked with its document and section, instead of pinned documents alone.
- **The 75 % limit of the context window:** the document that does not fit keeps its best
  sections for the question and an outline, not its first characters.
- **`knowledge_read` with `focus`:** a long document returns its best sections and an outline
  instead of the outline alone.
- **Web search:** the search tools of Brave, Qwant and Staan take the same optional `focus`. With
  page extraction on, a long result page contributes the sections that answer the question instead
  of its first characters. Without `focus`, nothing changes.
- **About this answer:** a searched project that also put the sections matching the question into
  the prompt reads "searched for matching passages" (German: "nach passenden Abschnitten
  durchsucht"), so the answer is not mistaken for one that rested on search alone.
- The sections the model was given appear as passages of the page or document in the sources panel,
  for the pages a web search read as well. A section cut short to fit shows only the part the model saw.
- A chat turn that has excerpts changes the system prompt with the question, so a model
  provider's prompt cache misses on those turns, and such a turn can use up to half of
  the projects budget on excerpts. Lower `projects.loadAllMaxTokens` in the platform settings to
  spend less.

## Short Links: Pick the App From a Search Box

The short link editor offers the app as a search box, as other admin pages do: type part of an
app's name and pick it, instead of typing its ID. The **Redirect URL** field says that a link to
another website needs its host on the SSRF allowlist, with a link to it.

## Chat: Progress While the Model Writes a Document, File or Web Artifact

A web artifact, document, presentation, Excel workbook, PDF, file or ZIP archive is written by the
model in one piece before anything is created, which can take a minute or two. The chat used to show
only a spinner for that time, so a working answer looked frozen and people pressed Stop. It now says
what is happening.

- **A row within about a second:** "Creating web artifact…" (or document, presentation, Excel
  workbook, PDF, file, ZIP archive), with the size written so far and a clock, for example
  "12 KB written · 0:41". There is no percentage: the final size is not known in advance.
- **A second call is its own row**, marked "No. 2", so a second wait is explained instead of looking
  like the first one starting over.
- **Every model, every provider:** after 3 seconds without visible output the headline reads
  "Waiting for the model… 0:12", or "Thinking… 0:07" while the model reasons and the provider sends
  its reasoning. The line says that a request is pending; it cannot tell a busy model from a stuck
  one.
- **A call that does not finish says so:** a call that is stopped, cut off by the model's output
  limit, refused or waiting for approval shows its own state, for example "Stopped", "Incomplete" or
  "Waiting for approval", instead of a spinning row.
- **Screen readers** are told the start and the end, each at most once; the changing numbers are
  not read out. With reduced motion the spinner is replaced by a still icon.
- **Which models show the row:** OpenAI-compatible servers and vLLM whose tool-call parser streams
  the call, Anthropic, OpenAI Responses and Amazon Bedrock. Google and Mistral send a tool call
  whole, and some vLLM parsers hold it back until it is complete; those models get the waiting line
  only.

For integrators: SSE v2 gains three `tool/progress` phases, `args`, `args.ended` and
`model.waiting`. They are additive, `tool/started` is unchanged and nothing is added to saved chats.
See [SSE v2](../../sse-v2.md) and [Accessibility](../../accessibility.md).

## Translations: One Key for the Product Name, and No More Untranslatable Texts

The product name has a single translation key, `product.name`, and every translation that
mentions "iHub Apps" now refers to it. Overriding that one key under **Admin → Customization →
Localization** renames the product in the footer, page titles, share links, the Teams manifest text
and every other place the name appears.

- The header tagline ("by IntraFind" / "von IntraFind") and the footer line ("© 2025 IntraFind
  Software AG. All rights reserved.") are now the translation keys `product.tagline` and
  `footer.legal`, so they can be overridden the same way. The footer line shows the current year
  instead of 2025. Installations that still have the shipped texts in `ui.json` are switched over
  automatically; a tagline or footer text you wrote, or removed, is left alone.
- More than 200 texts of the workflow screens, the clarification questions, Canvas, the setup wizard,
  uploads and the error pages had no entry in the built-in translations, so they could not be
  overridden and some had no German text. They now do, in English and German.
- Use `$t(product.name)` in your own overrides instead of typing the name.

See [Localization](../../localization.md).

## Claude Code Plugin Marketplaces as Registries

A registry can now point at a Claude Code plugin marketplace — a `marketplace.json` such as
Anthropic's [knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) or
[claude-plugins-official](https://github.com/anthropics/claude-plugins-official). Every `SKILL.md`
a plugin ships appears in **Admin → Marketplace** as a skill and installs like any other skill.
Marketplaces whose plugins live in other GitHub repositories (`github`, `url` and `git-subdir`
sources) no longer fail to load.

- Add the registry under **Admin → Marketplace → Manage Registries** with the raw URL of the
  `marketplace.json`.
- Only skills are imported; a plugin's commands, agents, hooks and MCP servers are not.
- Plugins from other repositories need one GitHub API call each. GitHub allows 60 calls an hour
  without a token, so give such a registry a bearer token (a GitHub token without scopes is
  enough). Plugins that could not be read are listed in the server log.

See [Marketplace → Claude Code plugin marketplaces](../../marketplace.md#claude-code-plugin-marketplaces).

## Website Corpus: Measure How Many Tokens a Website Holds

The new **Website Corpus** integration tells you how much text a website really has, in tokens,
and whether all of it fits into one context window. That decides whether "put the whole site into
the prompt" is a realistic alternative to retrieval.

- Five tools: find a site's pages from its sitemap, outline a few pages to spot boilerplate, crawl
  the pages in resumable batches, show the kept text of a page, and report the size.
- The report gives tokens per section, how many 128k, 256k and 1M windows the corpus fills (all
  pages, after removing repeated lines, and without blog and news sections), the largest pages,
  duplicates, how much of the sitemap was crawled, and the method.
- Only pages of the site itself are fetched, with the SSRF guard and the proxy settings, within
  the site's `robots.txt`. The speed is an installation setting: **Parallel requests per crawl**
  (default 4, at most 16) and **Pause between requests (ms)**, so a site of several hundred pages
  is crawled in a minute or two instead of ten, and a site that must not be loaded heavily can be
  crawled slowly. A chat turn now allows up to 50 tool rounds (was 25), so a crawl of a large site
  is not cut off. A crawl belongs to the user who started it and is removed after 14 days.
- Install it under **Admin → Integrations**, grant it to groups and bind it to an app. The
  `website-corpus-sizer` skill from the marketplace guides users through it. With the `dashboard`
  system skill in the app's skills as well, the guided process ends with a dashboard of the result
  in the chat's workspace pane, in English or German, without anyone asking for it.
- Internal websites need no entry per page. The SSRF guard refuses company-internal addresses; a
  user whose crawl was refused can ask an admin to allow the host, and the admin approves or
  declines under **Admin → Integrations → Requests** (the sidebar counts open requests). An approval
  covers only the Website Corpus and a host's web ports (80 and 443; another port is approved as
  `host:port`). The setting **Allow company-internal websites** lets every crawl
  reach the company network instead. Loopback, link-local and cloud metadata addresses stay blocked
  in both cases.
- Tokens are counted with the shared token estimator. The server does not ship `gpt-tokenizer`, so
  without it the estimator counts one token per four characters; the report says which method it
  used.

See [Website Corpus](../../website-corpus.md).

## Chat Inside a Project From the Catalog, Privately

A project you added from the catalog used to hold no chats: **New chat** started a chat outside it
with the project attached, and its page showed no chats at all. Now the chat runs **inside** the
project, like a chat in your own project, and the page lists your chats.

- **Private to you.** The project's owner, its editors and its other members cannot read a chat you
  start in it, and you cannot read theirs. A full administrator keeps the read access for compliance,
  as for every chat. Chats of the members stay open to the members, as before.
- **The Chats card.** It shows your own chats in the project and the chats that have it attached,
  newest first, a page at a time, without the **All chats / My chats** switch. A project the
  administrators made available to everyone still holds no chats: its card lists your chats that have
  it attached.
- **The project's instructions apply** to the chat, and the app you start with is the project's default
  app, as in your own projects.
- **If the project goes away.** When its owner deletes it, your chats are kept outside it. When it is
  taken out of the catalog, your chats stay in your history and answer without the project.
- **API:** `GET /api/projects/{projectId}/chats` lists the caller's own chats for someone who took the
  project from the catalog, whatever `filter` says. A project's `permissions.canHoldChats` is now `true`
  for them; `permissions.readsAllChats` stays `false`. A chat records that it is private
  (`projectPrivate`) when it opens in such a project.

See [Projects → Chats in a project](../../projects.md#chats-in-a-project).

## Dashboards From Data in the Artifacts Panel

The new `dashboard` system skill turns the figures of a tool run, an analysis or the user's own
data into a finished dashboard page in the chat's workspace pane, without the user having to ask
for it once the results are in.

- **One page, the answer first.** A headline sentence, KPI tiles, ranked bar charts (with limit
  lines such as a context window), line charts, sortable tables with good/warning/critical cells,
  a "How these numbers were made" section and a collapsed **Sources and formulas** section that
  each chart opens from its **Source** button.
- **Every chart has a Table view** with the same numbers, a tooltip on hover and focus, light and
  dark colours and a phone layout. The header uses the app's brand colour and font.
- **Quick and consistent.** The model writes a small JSON spec instead of a whole HTML page, and
  the server lays it out. `create_web_artifact` gained the parameters `preset` (`dashboard`) and
  `data` for it; a faulty spec comes back as a message that names the field at fault.
- **Numbers are not recalculated.** The skill has the model copy every figure from the data; the
  page works out shares, order, the sum of a folded tail and table sorting itself.
- **Enable it** by adding `dashboard` to an app's `skills`. It brings the tool itself, so
  `web-artifacts` does not have to be enabled as well.

See [Document and File Generation → The `dashboard` skill](../../pdf-generation.md#the-dashboard-skill)
and [Apps → Skill Settings](../../apps.md#skill-settings).

## Notice That You Are Chatting With an AI

The empty chat now shows a short note above the message box: *You are chatting with an AI system, not a
person. Answers can be wrong, so please check important information.* It is on by default, so installations
see it after the upgrade.

- **Passive and not stored.** It is not a message: it is not sent to the model, not saved with the chat and not
  shown when a chat with messages is reopened. It disappears with the first message.
- **Your wording.** Set the text per language, or switch the notice off for all apps, under
  **Admin → EU AI Act → AI notice** (`aiDisclosure.firstTurnNotice` in `platform.json`). An app can use its own
  text or no notice in the **AI notice** section of the app editor. Links in Markdown are allowed.
- **Where.** The app chat, also above a start form. Apps that start by themselves, the Office add-in panel and
  `iframe`/`redirect` apps do not show it.

See [EU AI Act](../../ai-act.md#first-turn-notice).

## Assistants Always Say They Are an AI

Every call to a text model now carries the rule "You are an AI system. If asked, always say so. Never claim to
be human, even in a role." as the last line of the system prompt. It applies in chat, the inference API, MCP,
A2A, agents, workflows and scheduled tasks, also for apps with a human persona. An app prompt or a client's own
`system` message cannot remove it, and there is no app setting to switch it off (only the audited EU AI Act master switch, below). Admins can reword the rule for the
whole platform under **Admin → EU AI Act → AI notice** (`aiDisclosure.guardrail.text`); empty keeps the built-in text.

Utility calls such as chat titles and translations carry it too (about 25 more tokens per call). A model can
still ignore a prompt rule in a strong role-play, so check the models you use with "Are you a human?".

See [EU AI Act](../../ai-act.md#guardrail-prompt).

## Users Confirm the Use of AI Before Their First Message

Before the first chat message a dialog asks the user to confirm a short AI-use statement, with an optional link
to your AI policy. The confirmation is stored with the user (version, time, SHA-256 of the exact text and its
language) and in the audit log, so you can answer "who confirmed which version, and what did it say?".

- **Versioned.** Editing the text asks nobody again. **Request again** raises the required version and everyone is
  asked at their next message. Anonymous visitors confirm once per browser (a signed cookie plus an audit entry).
- **Enforced by the server.** Without a valid confirmation, sending a chat message, starting a workflow or its
  chat step, and starting an agent run answer `428 AI_ACKNOWLEDGEMENT_REQUIRED`. Other OAuth clients, API keys,
  MCP, A2A and the inference API are not asked. With enforcement off the dialog only asks.
- **In the Outlook add-in, the browser extension and the Nextcloud embed too.** The same dialog opens in the
  pane or side panel before the first message, in the pane's look and language. A declined dialog keeps the
  draft and the open email or page; the menu has an **AI-use notice** entry to read it again, and the policy
  opens through the host (or its address is shown to copy). One confirmation counts in every client, and the
  record says which one it came from (`client: office | extension | nextcloud`).
- **Admin.** **Admin → EU AI Act → AI acknowledgement** holds the switches, the text per language and the policy
  link. **Admin → Users** gets an **AI acknowledgement** column and filter, a per-user **Remove AI
  acknowledgement** action and an **AI acknowledgements** menu: **Export CSV**, **Request again**, **Remove all**.
  (`aiAcknowledgement` in `platform.json`; migration V242 adds the defaults.)

See [EU AI Act](../../ai-act.md#ai-use-acknowledgement).


## AI Outputs Carry a Provenance Object and Leave a Record

Every AI answer now says where it came from, in a form a program can read, and iHub keeps a small record so
"did this exact text come from us?" can be answered later. This supports the marking duty of Art. 50(2) of the EU
AI Act.

- **The object.** `provenance` has the model, the installation, a time, an output ID and a SHA-256 of the text. It
  is on stored chat messages and `run/ended`, on `/api/inference/v1` completions (plus the headers
  `X-AI-Generated` and `X-AI-Content-Id`, also on a stream), on MCP results as `_meta.provenance` and on A2A
  results as `metadata.provenance`.
- **In the chat.** Under every finished answer, the chip that says what the answer is based on opens **About this answer**. Its **Details** show the model (name and id), time, marking and content hash, with a **Copy hash** action. Every generated picture has an **AI generated: details** button next to download and share.
- **The record never holds the text**, only its hash, and names no user unless `provenance.recordUser` says so. `provenance.retentionDays` in `platform.json` (365 by
  default, `0` keeps them) is enforced by a daily sweep; `provenance.storeRecords: false` keeps no records.
- **Look it up.** `POST /api/eu-ai-act/provenance/_verify` takes a text or a hash and answers "Found" with the record or
  "Not found". Not found is not proof of human authorship. It needs a signed-in caller unless
  `provenance.verify.access` is `public`, and has its own rate limit (**Admin → Security**).
- **Per model.** **Admin → Models** shows an *Output marking* column ("Not marked" is only a hint) and an *Output
  marking* section: choose "Provider marks the output" only with the provider's written statement.
- **Upgrade.** Migration V243 writes the defaults. Workflow runs and the Slack and Teams integrations get no
  record yet; scheduled tasks and apps called by tools do.

See [Provenance Records](../../provenance.md) and [EU AI Act](../../ai-act.md#provenance-records).

## Text Watermarking for Self-Hosted vLLM Models, With Detection

For vLLM models iHub can now watermark the text it generates and recognise it again, which supports the
marking and detection duty of Art. 50(2) of the EU AI Act (due 2026-12-02).

- **Marked on the server.** Set **Admin → Models → Output marking** to *iHub watermark (vLLM)* (models on the
  `local` provider, or `openai` pointed at vLLM). iHub asks vLLM to watermark every answer; a caller cannot
  switch it off. Greedy requests (temperature 0) and structured output cannot be marked and are recorded as *not
  applied*, with the reason.
- **Keys iHub holds.** One active key at a time, stored encrypted; rotating makes the old key *retired*
  (still used to recognise older text). Keys are created, activated, revealed and deleted through
  `/api/admin/eu-ai-act/watermark-keys`; every change and every reveal is in the audit log, and a reveal is refused when the
  audit log is not available. After a rotation restart vLLM with the new `--watermark-config`, then run the
  self-test.
- **Detection.** `POST /api/eu-ai-act/provenance/_verify` also answers `watermark` for a text with no record: detected (with
  the key it was made with), not detected, or too short to tell. This needs a detector service (the contract is
  in the guide; iHub ships a mock for tests), reached over HTTPS or an internal network with a bearer
  credential, and honours the SSL whitelist and the proxy. Not detected is not proof of human authorship.
- **Checks.** `POST /api/admin/eu-ai-act/watermark-detectors/{modelId}/_test` and `/_self-test` show whether iHub and
  vLLM use the same key.
- **Also fixed.** The audit log now redacts a request field named `key`.

See [Text Watermarking](../../ai-act-text-watermarking.md).

## EU AI Act Page: Configuration Check, Watermark Keys, Settings and Verification in One Place

Admins find everything for the Art. 50 transparency duties on **Admin → EU AI Act** instead of in
config files.

- **Configuration check.** A traffic-light list (OK, Attention, Failing; always icon plus word)
  covers the AI notice, the acknowledgement, provenance records and every model's marking. A model
  marked "iHub watermark" is Failing when it has no active key, an unreachable detector or a failed
  self-test. Each row links to where it is fixed. Green means "configured as designed", not
  "legally compliant".
- **AI notice and AI acknowledgement.** The first-turn notice, the guardrail wording and the
  acknowledgement settings (switches, text, policy link, current version) are cards of this page.
- **Acknowledgements.** Counts (acknowledged, pending, total) and the Users page actions: request
  again, remove all, CSV export.
- **Watermark keys.** List, generate, add and delete retired keys; reveal a key on purpose
  (audit-logged, hidden again after 60 seconds, never kept in the page), and test the connection
  or run the self-test per model. **Make active** on a retired key rolls back to it; the
  confirmation says that the current key is retired, that vLLM's `--watermark-config` must follow
  and that self-test results turn outdated until then.
- **Provenance settings.** Retention (0 keeps records forever), whether records are kept, who a
  record names (nobody by default; a secured hash, a plain hash of the user id or the user id,
  shown to admins only; migration V246), who may
  check an output (signed-in users or anyone), the size limit of checked files (in MiB), C2PA reading and the text detector's false-positive limit, shortest judged text and
  time limit are a form with defaults and units. Values are checked in the browser and on the
  server against the same bounds. Lowering the retention or opening the check to the public asks
  for a confirmation first. Changes apply at once, no restart, and are written to the audit log.
- **Verification.** Paste a text or upload an image or audio file and see, per technique, whether
  it was found, which watermark key matched, and whether C2PA content credentials are present (with
  signer, claim generator and signing time; trust is not evaluated). A match shows the full stored
  provenance record, field by field and as JSON. A negative result never claims the content is
  human-made.
- **Model editor.** Image-generating models have an *Image marking* section to declare what the
  provider embeds.
- `GET /api/admin/eu-ai-act/status` returns the check (admin only, never a key or token).

See [EU AI Act](../../ai-act.md#admin-page).

## EU AI Act Master Switch With a Recorded Reason, and the Acknowledgement APIs Under `eu-ai-act`

Admins who do not need the Art. 50 measures can turn all EU AI Act features off from **Admin → EU AI Act**. The
switch is deliberate and attributable: switching off needs a written reason (20-1000 characters) and a
confirmation that the legal duty stays with the organisation, and the admin's name, the time and the reason are
stored on the server and in the audit log.

- **What stops.** The AI rule in prompts, the first-turn notice, the acknowledgement dialog and its enforcement,
  provenance records and the `provenance` member and `X-AI-*` headers, text watermarking requests, image
  marking, verification and the configuration check. Nothing shows an error; integrators see `euAiAct.enabled`
  in `GET /api/configs/platform`.
- **What stays.** Acknowledgements, provenance records, watermark keys, all settings and texts, and a history
  of every switch. While off, removing or resetting acknowledgements is disabled; the CSV export stays.
- **Switching on again.** Valid acknowledgements stay valid; only users without one are asked at their next
  message.
- **Only admins.** An interactive admin session; API keys, OAuth tokens and agents are refused.
- **vLLM.** A vLLM server started with `"enforce": true` keeps watermarking until it is restarted without that
  option.
- **API paths.** The acknowledgement APIs now live under `eu-ai-act`: `GET/POST /api/eu-ai-act/acknowledgements/me`,
  `/api/admin/eu-ai-act/acknowledgements/...` and `DELETE /api/admin/eu-ai-act/users/{userId}/acknowledgements`.
  They replace `GET /api/ai-acknowledgements/me`, `POST /api/ai-acknowledgements/me`,
  `POST /api/admin/ai-acknowledgements/_request-again`, `GET /api/admin/ai-acknowledgements/_export`,
  `DELETE /api/admin/ai-acknowledgements` and `DELETE /api/admin/auth/users/{userId}/ai-acknowledgements`,
  which never shipped in a release.
- **Provenance and watermark APIs move too.** `POST /api/eu-ai-act/provenance/_verify`,
  `/api/admin/eu-ai-act/watermark-keys` and `/api/admin/eu-ai-act/watermark-detectors` replace
  `POST /api/provenance/_verify`, `/api/admin/watermark-keys` and `/api/admin/watermark-detectors`, which
  never shipped either.
- **No look-up URL in the provenance object.** The `verify` member is gone from the `provenance` object and
  from the `_verify` answer, because the address of an installation can change. Clients build the URL from
  the public address of iHub plus `/api/eu-ai-act/provenance/_verify`.

The wording of the legal notes is a draft for legal review, not legal advice.

See [EU AI Act](../../ai-act.md#switching-the-features-off).

## Text Slots on Slides: the Model Knows What the Template Offers

Presentations from the `pptx` skill can now fill the small texts that make a strategy deck read
well: a **kicker**, a short label above the slide title ("VISION 2027"), and a **lead**, one
sentence under it that gives the context. They are two examples of **text slots**: text
placeholders of a slide layout besides its title and content. A company declares the slots its
template has, and the model is told which exist, where each one sits and how much text fits.

- **Declare slots per template.** Under **Admin → Document templates → PowerPoint → Text slots**
  give each slot an id, the name of its placeholder in the layouts, a description for the model and
  what to do in a layout without it. This works with any template, any language and up to twelve
  slots, for example the presenter on a title slide. A placeholder named `Kicker` or `Lead` is a slot
  without any setup.
- **Read from the template file.** The editor lists small, named text placeholders it finds in the
  uploaded PowerPoint file and adds one as a slot with a click, with an id and the instruction the
  template author typed into the placeholder.
- **A guide for the template's authors.** The new [PowerPoint Template Guide](../../powerpoint-template-guide.md)
  explains how the template should be built — layouts, placeholders, theme, text slots — with a
  brief admins can hand to marketing, in English and German.
- **The model sees the template.** The description of `create_pptx` lists the slots with their
  position (above or below the title …) and how many characters fit, and what each slide type has:
  title, subtitle, content areas, slots. The model passes the text in the slide field `slots`.
- **The right layout.** A slide that fills slots uses the layout of its kind that has most of them;
  all other slides keep their layout. A template without a slot keeps working: the text is left
  out, or becomes the first paragraph of the slide, as the slot says.
- **Title slide strip.** A title layout's footer placeholder can hold the company name; the model
  can replace it per deck with the `footer` field of the title slide ("Strategy 2027 · November
  2026").
- **KPI cards follow the company colours.** The KPI cards are now light neutral cards with a rule
  across the top in the template's first coloured accent, instead of a tint of accent 1. A template
  whose accent 1 is grey no longer produces grey cards.

See [Document templates → PowerPoint](../../document-templates.md#powerpoint).

## Chat: One Chip Says What an Answer Is Based On

Under a finished answer, a project chat used to say the same thing three times: the project as a
badge, **Based on configured sources**, and an icon-only ⓘ for **AI generated**. When the answer
also used a web search, the project disappeared into **Based on multiple sources**. One chip now
replaces all of them.

- **The chip names only the kinds of source the answer used:** Project, Web, iFinder, iAssistant,
  Documents, File, Email, Recording, or the name of an integration, MCP server or remote agent, for
  example **Jira**. Two integrations are two entries. At most two kinds are named, then **+N**.
  A workflow answer reads **Workflow**.
- **Nothing retrieved reads "Model knowledge"** (German: "Modellwissen"), never "no sources".
- **A project counts only when the answer used it.** A project that was in scope but whose text
  neither went into the prompt nor came back from a search is not named on the chip. It is listed
  as not used.
- **An amber chip stays separate** when a project in scope could not be used, for example an
  iFinder collection while iFinder is unreachable. The basis chip next to it shows what the answer
  actually used. Screen readers announce the amber chip only on the newest answer.
- **The chip opens "About this answer":**
  - **AI-generated:** one sentence, for example "This answer was generated by AI, based on project
    and web".
  - **Sources:** each source by name. A project shows how it was used (all documents read, searched
    for matching passages, only pinned documents) and an **Open project** link. The diagnostics
    that were in tooltips stay as muted text: the knowledge mode, over budget, the model cannot call
    tools.
  - **Not used:** projects that were in scope but did not contribute, with the reason.
  - **Details:** model, time, marking, content hash and output ID, as before.
- **The separate ⓘ button is gone.** The first-turn notice, the disclaimer below the message box,
  and the provenance record, watermark and headers are unchanged.
- **Keyboard and narrow panes.** The chip is a button. Opening the popover moves the focus into it,
  without trapping it: Escape closes it and returns the focus to the chip. Nothing is only in a
  tooltip. In a narrow pane (Outlook) a chip with several kinds
  shows icons only; its accessible name keeps the full text.
- **After a tool approval the chip covers the whole turn.** An answer that continues after you
  approved or rejected a tool call is based on everything the turn used before it paused, for
  example a project search or a Jira lookup, and not only on the approved call.
- **Older answers show no chip.** Answers stored before this release have no record of what they
  were based on, and iHub does not guess it from other fields. The amber chip for an unavailable
  project is still shown on them.

**API:** `run/ended` gains `answerBasis` (`[{ kind, label? }]`, `kind` one of `project`, `web`,
`ifinder`, `iassistant`, `documents`, `integration`, `email`, `file`, `audio`, `model`), and each
project of `knowledge/scope` gains `contributed`. Stored chat messages carry `answerBasis`. The
chat's own project knowledge now reports `project` in `knowledgeSources` instead of `sources`, which
keeps its admin-configured meaning.

See [Answer Sources](../../answer-sources.md#what-users-see).
