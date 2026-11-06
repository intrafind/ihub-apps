# Features — Unreleased

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
  MCP gateway). Installations are grouped (people directories, web search, storage providers, MCP
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

- **Files drawer:** the chat's side panel has **Uploaded** and **Generated** tabs. Uploaded files
  show type, size, pages and whether the original is still stored, open as a preview (PDF,
  picture, CSV, notebook, text, e-mail, meeting or web page) and offer **Download original**,
  **Download text** and **Delete file**; the Outlook task pane adds **Attach to email**.
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
chat, without the conversation it came from. Open the Artifacts panel, select the file and choose
**Share**.

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
  cite it again with a badge. For more of a web page, it reads the page again. The answer badge
  shows where the source came from: an answer built on a web page found earlier says "web search".
- **Uploaded files:** files from earlier turns can be read again in full, also those that were
  left out of the prompt to save space.
- **Created files:** documents, spreadsheets, presentations, code and web pages the chat created
  can be read again, for example to revise a document into a new version. Pictures and ZIP
  archives are listed but not read.
- Only for kinds the chat actually has, only in stored chats that send their history, and only for
  people who may read the chat. Nothing to configure; the lookups never ask for approval.

See [Chat Persistence](../../chat-persistence.md#what-earlier-turns-give-the-model).

## Artifacts Open Full Window, from a Click in the Chat

A generated page, dashboard, picture or document now opens as itself: one slim toolbar and the
artifact filling the rest of the window, edge to edge.

- **Click to open:** the card of a generated file and a generated picture in a chat message open the
  viewer. **Download** stays a separate button; Word, Excel and ZIP files, which have no preview,
  still just download. Works in your chats and in shared chats.
- **Toolbar:** name with a file menu, previous/next through the chat's artifacts, **Preview | Code**,
  copy, **Share**, **Export** (HTML, Markdown, PDF), download and browser **Full screen**. On a phone
  the actions are in the file menu. **Esc** or **×** closes it and focus returns to the card.
- **Chat beside it:** the **Chat** button splits the window so the conversation stays usable next
  to the artifact.
- **Links:** the open artifact is in the address (`?artifact=…`): reload reopens it and Back closes
  it. **Open in new tab** shows one artifact of your chat on its own page. A shared single file
  opens in the same full-window layout; add `?embed=1` to drop the toolbar for embedding.
- **Files panel:** the **Full screen** toggle is replaced by **Open**.
- HTML runs in the same sandboxed frame as before and cannot reach iHub.

See [Artifacts](../../artifacts.md#the-artifact-viewer).

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

Errors that the server's routes do not answer themselves — a request body that is too large, a body
that is not valid JSON, an unexpected failure — are now answered as JSON instead of an HTML or plain
text page. Every such response has the same body:

```json
{ "error": "…", "code": "PAYLOAD_TOO_LARGE", "details": { "type": "entity.too.large" } }
```

- `code` is a stable, machine-readable code; the web app shows its own translated message for it
  (English and German).
- `error` is an English text for scripts and other API callers. For a server error (5xx) it carries
  the real message only if it is safe to show (no file paths, hosts, URLs, credentials, SQL or stack
  details, at most 200 characters); otherwise it is a fixed text. The real reason is always written
  to the log.
- OAuth endpoints (`/api/oauth/*`, `/.well-known/*`) keep their standard `{ error, error_description }`
  body.
- Request validation (`400`) answers `code: "VALIDATION_FAILED"` with the failed fields in
  `details.issues` (a list of `{ path, code, message }`), instead of `{ error: "Invalid request",
  details: [...] }`. This covers the chat, tool-run, feedback, session-start, magic-prompt and MCP
  app endpoints; `error` now reads "Some of the entered data is not valid." and `details` is an
  object, not a list.
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
- The routes that still answer errors with their own body are converted to this shape one by one in
  the following releases; each conversion is listed here.

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
  before.
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
- **The original file, images included:** the document is fetched as the original and attached
  like a file from Nextcloud: an image as an image for a vision model, anything else as a document
  that keeps its original next to the extracted text.
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
