# Features — Unreleased

## Installed Integrations: Install from a Catalog, Configure, Bind to Apps

**Admin → Integrations → Installed** is the first piece of the unified integrations platform
(epic #2911). An integration is a definition in a catalog; installing it creates an instance with
its own URL, sign-in mode, groups and set of actions; apps bind instances and the model gets their
actions as tools.

- **Catalog and install wizard:** the wizard is generated from the definition's install fields
  (URL, numbers, switches, choices, a secret), offers the sign-in modes the definition declares
  (no sign-in, or a shared service account whose token goes to the credential store), lets you
  choose groups and actions, and tests the connection before anything is saved. One definition
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
  installation it binds exists and is enabled; **Admin → Apps** names a missing one.
- **Marketplace:** the new item type **Integrations** installs definitions from a registry. The
  official marketplace publishes the first one with an example app.
- **CKAN Open Data Portal** ships with iHub: search datasets, read licenses, publishers, coverage
  and the list of files with their formats and download links (the files' contents are not read
  in this release), query DataStore tables, on GovData, the German state and city portals,
  data.gov and internal CKAN catalogs. Tested against demo.ckan.org, GovData, Open-Data
  Schleswig-Holstein, open.canada.ca and data.boston.gov; data.europa.eu offers only the search.

See [Integrations](../../integrations.md).


## iFinder and iAssistant Are Installed Integrations

iFinder and iAssistant are the first two built-in integrations under **Admin → Integrations →
Installed**, and no longer a block in `platform.json` or an editor on the Providers page.

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

Outbound MCP servers are installed under **Admin → Integrations → Installed** like any other
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
**Admin → Integrations → Installed**, and no longer on a page of their own.

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
Manage Registries**), and the catalog must carry a hash for every code file, which the install
checks. The Catalog tab and the install wizard say when an integration runs code on the server.

## Web Search Is an Installed Integration

The search engines and the page reader are the built-in integration **Web search** under
**Admin → Integrations → Installed**, and no longer a category on the Providers page.

- **One place for the engines:** the installation `websearch` holds the Brave and Staan API keys
  as credential references, the **default search engine** every app on `auto` uses, and the
  groups that may search — these hold for native search on Google, OpenAI and Anthropic models
  too, so a user outside them gets no web search on any model. Qwant still needs no key.
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

Atlassian Jira is the built-in integration **Atlassian Jira** under **Admin → Integrations →
Installed**, and no longer a page of its own under **Admin → Integrations**.

- **One place for the OAuth app:** the installation `jira` holds the client id, the client secret
  as a credential reference, the redirect URI and the site URL; **Test** checks them and the route
  to `auth.atlassian.com`, and **Connections** lists the users who connected their Atlassian
  account and disconnects one. The redirect URI may stay empty: it is then derived from each
  request (scheme, host and base path as the browser sees them), and **Test** shows the resulting
  URL to register. The "users connected" count follows connects and disconnects as they happen.
- **Apps bind instead of listing tools:** an app binds `integrations.jira` and picks actions by
  name; the six tools keep their ids (`jira_searchTickets` and friends). An app that binds Jira is
  offered only while the installation is enabled, and the installation's groups decide who may use
  it.
- **Users connect as before:** the "Connect to Jira" prompt in the chat and **Settings →
  Integrations** are unchanged, and existing connections keep working.
- **Migrated for you:** migration V196 moves `platform.jira` into the installation (keeping its
  enabled state), retires a hand-written tool file for `tools/jira.js` and rewrites `tools: ["jira"]`
  into the binding.
