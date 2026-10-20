# 02 · Market research: how others do integrations

**Date:** 2026-10-20 · **Status:** Research · Part of [Unified Integrations](README.md)

Twelve products were reviewed from their current documentation (October 2026): Langdock, Open WebUI, LibreChat, Dify, AnythingLLM; Claude.ai / Claude for Enterprise, ChatGPT, Microsoft 365 Copilot and Copilot Studio, Gemini Enterprise, Glean, Perplexity Enterprise, Slack and Notion AI; and the "managed auth" layer (Composio, Nango, Pipedream Connect, Arcade, n8n). The Anthropic connector directory extract (842 remote MCP connectors, 132 desktop extensions, 4,482 plugins; `claude-connector-directory-ihub.xlsx`) was used as a quantitative reference. Sources are listed at the end of each section.

## 1. Convergence: the industry has settled on one shape

Across every product the same three objects appear, whatever they are called:

| Layer | Langdock | Claude | ChatGPT | M365 Copilot | Glean | Composio / Nango | iHub today |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Catalog entry | Integration (directory) | Connector (directory) | App / Plugin (directory) | Copilot connector, Agent, Tool (registry) | Data source, Tool | Toolkit / Integration | MCP catalog entry, hub card, tool JSON |
| Org-level install | Integration enabled for workspace / groups | "Add to your team" | Availability: Available / Install / Disabled | Deployed to: me / org / groups; staged rollout | Enabled for Agents / Glean, RBAC | Auth config | `mcpServers.json` entry, `platform.*` |
| Per-user credential | Connection (default per integration) | "Connected" per member | Connected account (several per app) | "Sources → Connect" | first-use OAuth | Connected account / Connection | `TokenStorageService` file |
| Callable unit | Action (effect-tagged, confirm per action) | Tool (Always allow / Needs approval / Blocked) | Action (read-only / all / custom; new-action policy) | Tool (read vs write/delete groups) | Tool (run without confirmation Y/N) | Tool | tool function |

And every product separates the **three decisions**: the admin enables, the user connects, the user (or the app) picks what is active in a conversation. Enabling never grants access; connecting never widens what the admin allowed. Claude's Academy course and Microsoft's "five conditions" (publisher allowed → connector enabled → user access → staged rollout → licence) describe the same gates.

MCP has become the default wiring: 831 of 842 directory connectors use streamable HTTP; 727 need per-user OAuth; 820 let the client register itself (CIMD or DCR); only 22 need a customer-provided OAuth client; 161 ship an interactive UI (MCP Apps). Native code is reserved for gaps the vendor does not fill (Anthropic hosts Microsoft 365, PubMed and others on `*.mcp.claude.com`).

## 2. Admin side: what the best ones do

**Catalog.** Claude has one directory for connectors, skills and plugins ("Customize" hub, each with a Discover tab), badges *Verified* (functionally tested, explicitly "not a security audit"), *Community* (with a pre-connect reminder) and *Custom*, an *Interactive* badge, usage-based ranking, and in-chat "suggested connectors". Dify shows install counts and "Verified by a Dify partner". Open WebUI's community library says plainly that items are not reviewed. Langdock curates: 72 integrations and 79 MCP servers, listed only after customer demand and testing, with a Type filter (Built-in / Custom). Microsoft splits a user-facing Agent Store from an admin-facing registry with a Certification tab.

**Install.** Claude's custom connector dialog is the reference for an MCP install form: name, URL, *Authentication* (Sign in now / Sign in when needed / No sign-in), *OAuth client* (Claude's published identity via CIMD, recommended / Register automatically via DCR / Your own client), up to four request headers, transport in Advanced. Copilot Studio's wizard adds the manual OAuth variant (auth URL, token URL, refresh URL, scopes, callback shown). Langdock and Dify add a "list server features and tick tools" step with caps (60 tools), and a visible *Test* before save. Pitfall: Claude's auth settings cannot be edited after creation (remove and re-add, all users reconnect).

**Enablement.** Langdock: an *Enable for entire workspace* toggle that flips into *Manage access* (users and groups), plus per-action *Available to all users* with a Share dialog that warns when the recipient lacks integration access. Microsoft: *Deployed to* + staged rollout + a tenant-wide User access ceiling. Claude Enterprise: custom roles with a Connectors tab, evaluation "role grant → most permissive across roles → org ceiling → member setting cannot exceed". Glean: test groups (≤10) per connector.

**Tool policy.** Three products converge on the same tiers: Claude (*Always allow / Needs approval / Blocked*, per category read vs write/delete or per tool, org policy as ceiling), Perplexity (*Allow / Always ask / Disable*, groups Read-only vs Write/delete), Microsoft (Read tools always allowed, Write/Delete default *Needs approval*, publisher changes reset to Needs approval). ChatGPT adds an explicit policy for *newly added actions*. LibreChat has deployment-wide glob rules (`deny: ['mcp:*:delete_*']`, `ask: ['mcp:*:*']`, evaluated deny → ask → allow). Gemini Enterprise reads MCP `readOnlyHint` / `destructiveHint` to decide which actions skip confirmation.

**BYO OAuth client.** Langdock: one workspace client and optional group-specific clients (group wins; overlapping groups error), scope tooling ("Sync scopes with enabled actions"), a documented error dictionary (`redirect_uri_mismatch`, `invalid_client`, `consent_required`, `insufficient_scope`). Open WebUI: custom headers templated with `{{USER_ID}}`, `{{USER_GROUPS}}` so a downstream server can authorize without OAuth. LibreChat: `{{LIBRECHAT_OPENID_*}}` token forwarding.

**Enterprise-managed auth.** Claude + Okta (Cross-App Access, ID-JAG): admin enables once, members inherit by group, no consent click, revoke in the IdP, connection test button, vendor setup-docs link; Atlassian, Slack, Notion, Asana, Linear, Figma, Canva, Datadog support it. Nobody else has shipped it yet.

**Requests.** Claude and Microsoft let members *Request* a connector; admins see a badge-counted queue with approve / decline / decline-and-block.

**Audit.** Glean has a per-connector Logs tab (actor, status, CSV, 30 days). Claude and ChatGPT point to compliance APIs; connector-level audit is thin everywhere. Opportunity.

## 3. User side: what the best ones do

**One page.** Claude: *Customize → Connectors → Your connectors* with *Connected*, *Connect*, *Reconnect*; *Disconnect* keeps the row, *Remove* deletes it. ChatGPT: *Settings → Apps*, several connected accounts per app, "Disabled by admin" state visible. Langdock: a *Default* connection per integration; selection order agent-preselected → user default → prompt.

**In chat.** Langdock: `@` opens one searchable menu for integrations, agents, skills, knowledge bases, prompts, workflows; a selected tool turns blue "indicating an active connection"; a `+` button after the first. Claude: `+` → Connectors with per-conversation toggles, and a global *Auto* vs *On demand* tool-access mode recommended at ≥10 connectors to curb context bloat. LibreChat: `+` palette → server chips on the composer with status icons (green gear connected, amber key OAuth required, orange plug disconnected, red triangle error). Perplexity: `+ → Connectors and sources` checkboxes or `@Microsoft 365`. Gemini Enterprise advises switching off unused connectors for latency.

**Lazy connect.** Claude: a 401 becomes an inline *Connect* card. Glean: *Connect, then return to the pending request* ("connecting is not approval"). Composio: the agent itself returns a hosted connect link in the conversation. Langdock: expired tokens show *Reauthorize* and retry automatically. Pitfall (Open WebUI): consent returns the user to a *new* chat and OAuth tools cannot be model defaults.

**Confirming writes.** Microsoft: collapsible confirmation card with parameters, *Allow once / Allow for conversation / Always allow / Cancel*, "nothing is sent until you respond". Langdock: confirmation per action with editable parameters and Preview / Source tabs for rich text; default *confirm* for native actions but *no confirm* for MCP tools (inconsistency to avoid). Glean: *Allow / Cancel* with an editable preview and *Approve all* for batches. Gemini: the action is an editable draft (To, Subject, Body) with *Authorize* on first use, then *Send*. ChatGPT: tiers *Always ask / Any changes / Important actions / Never ask*, "Never ask" needs a second confirmation. Pitfall everywhere: prompt fatigue when read tools also ask.

**Rich results.** MCP Apps (SEP-1865, final, co-authored by Anthropic and OpenAI) is the standard for inline, fullscreen and picture-in-picture views; Claude, ChatGPT, VS Code and M365 Copilot host it. iHub already does.

**Restricted states.** Claude's copy differs per blocking layer ("disabled for your organization" / "contact your admin" / "not enabled for your role") but members cannot tell which; design the empty states to say which gate is closed.

## 4. Open-source peers, briefly

| Product | Strength to borrow | Weakness to avoid |
| --- | --- | --- |
| **Langdock** | Integration → Connection → Action model; enable/manage-access toggle; BYO client per group; `@` picker; Reauthorize + auto retry; MCP Apps side panel | screenshots-only docs; MCP tools default to no confirmation |
| **Open WebUI** | Global vs user tool servers; identity-templated headers; MCP elicitation forms; honest "not reviewed" library | OAuth returns to a new chat; secret-key footgun loses tokens; Python tools are root-equivalent |
| **LibreChat** | status icons in the composer; `toolApproval` glob policy; `customUserVars` per-user keys; QR/second-device OAuth; agent marketplace with ACL (Viewer/Editor/Owner) | YAML servers need restart; changing URL invalidates all user tokens |
| **Dify** | marketplace with partner verification and install counts; multiple credentials per tool with a default and fallback; enterprise credential policy (global vs workspace, allow/forbid) | builder-only exposure, end users cannot see or pick; server identifier coupling breaks apps on rename |
| **AnythingLLM** | simple Agent Skills page with status and logs per MCP server | file-only MCP config, no roles, no per-user auth |

## 5. Managed-auth layer

Composio, Nango, Pipedream Connect and Arcade all separate the **Integration** (provider config, OAuth app, scopes, managed or bring-your-own) from the **Connection** (one end user's credential: id, status `initiated / active / expired / failed / revoked`, scopes granted, expiry, last refresh, error). Consent starts from a hosted link or in-chat meta-tool, completion is awaited, re-authorization preserves the connection id. n8n's enterprise *end-user credentials* are the same idea inside a workflow tool: an admin creates a template once, each user clicks *Connect*, runtime resolves to the triggering user, deleting the template warns with the connection count. These are the minimal fields a `Connection` record needs; they are adopted in [04 · Architecture](04-architecture.md).

## 6. Standards that fix the data model

- **MCP 2026-07-28** is stateless (`server/discover`, no sessions), with `ttlMs` on lists, tool lists that may vary by credential, and `resultType: input_required` instead of server-initiated requests. Most servers still speak 2025-11-25. iHub's client must speak both.
- **Authorization**: RFC 9728 → RFC 8414 discovery, PKCE S256, RFC 8707 resource indicator, RFC 9207 `iss` check. Client registration order: pre-registered → **CIMD** (`client_id` is an https URL to a JSON document) → DCR (now deprecated) → ask the user. Credentials keyed by issuer. iHub already implements this for `oauthUser`.
- **Enterprise-managed authorization** (`io.modelcontextprotocol/enterprise-managed-authorization`, stable): IdP issues an ID-JAG by token exchange, the MCP server's authorization server accepts it as a jwt-bearer grant. Keycloak can *receive* ID-JAGs (experimental) but not *issue* them yet; Okta, WorkOS, Auth0, Descope can.
- **Tool annotations** `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` give the effect of a tool, but clients must treat them as untrusted unless the server is trusted. Hence a per-integration *trusted* flag.
- **MCP registry** `server.json`: reverse-DNS `name`, `packages[]` (npm, pypi, oci, mcpb) and `remotes[]` with templated URLs, typed input objects (`isRequired`, `isSecret`, `choices`, `format`). Preview status; private sub-registries expected. No auth posture in the schema: discover live or add in `_meta`.
- **MCPB `user_config`** (string, number, boolean, directory, file; `required`, `sensitive`, `default`, `multiple`) is the model for an auto-generated install form. Registry input objects and MCP elicitation forms map onto the same `ConfigField` type.
- **MCP Apps** `_meta.ui.resourceUri`, `_meta.ui.visibility`, CSP and permissions; OpenAI's `openai/*` aliases are being migrated to it.

## 7. What this means for iHub

1. **Adopt the three-layer model** (integration → installed integration → connection) and the three-decision rule (admin enables, user connects, user picks). This is what every peer does and what users already expect from Claude and ChatGPT.
2. **One catalog with trust labels**, one install form generated from typed fields, one test-before-save, and the marketplace as the distribution channel. Add the public MCP registry as an optional community source rather than curating 842 entries by hand.
3. **Tool policy tiers** (*ask / allow / block*, by effect category with per-action override, admin ceiling, reset to *ask* when a publisher adds a write tool) and a confirmation card with editable payload and scoped memory (*once / this chat / always*). Read actions never ask.
4. **In-chat picker at the integration level**, status cues on the composer, lazy connect that returns to the same chat and retries, *Reconnect* with the reason.
5. **Enterprise-managed auth** as a planned auth mode (the DACH public sector runs Entra and Keycloak; Keycloak issuance is not there yet, so this is phase 3).
6. **Differentiate on what directories lack**: on-prem and sovereign systems (SharePoint Server, Jira and Confluence Data Center, d.velop, enaio, nscale, ELO, M-Files, Nextcloud, openDesk, SAP), per-connector audit, and iFinder as a permission-trimmed MCP server (IPD-618).

## Sources

**Langdock:** docs.langdock.com/en/using-langdock/integrations/{introduction,connections,integration-directory,mcp-directory,mcp-ui}, /en/admin/manage-integrations/{manage-action-access,bring-your-own-oauth,default-tool-stack}, /en/admin/workspace/{permissions,roles}, /en/using-langdock/chat/tools/actions-in-chat, /en/using-langdock/guides/integrations/mcp/mcp.
**Open WebUI:** docs.openwebui.com/features/extensibility/{mcp,plugin/tools,plugin/functions,plugin/tools/openapi-servers/open-webui}, /features/authentication-access/rbac/{permissions,groups}, /tutorials/integrations/onedrive-sharepoint, /ecosystem/community.
**LibreChat:** librechat.ai/docs/features/{mcp,agents}, /docs/configuration/librechat_yaml/object_structure/{mcp_servers,agents}.
**Dify:** docs.dify.ai/en/cloud/use-dify/{workspace/tools,build/mcp}, /en/develop-plugin/dev-guides-and-walkthroughs/tool-oauth, marketplace.dify.ai, enterprise-docs.dify.ai/en/3.8.x/administer/credential-management, dify.ai/blog/2025-dify-summer-highlights.
**AnythingLLM:** docs.anythingllm.com/{agent/overview,agent/setup,mcp-compatibility/overview,community-hub/about}.
**Claude:** support.claude.com/en/articles/{11176164,11175166,13930452,14328846,13837440}, claude.com/docs/connectors/{directory,verification,getting-started,custom/remote-mcp,building/enterprise-managed-auth,building/mcpb}, claude.com/docs/plugins/admin, academy.claude.com (Deploying Claude Enterprise: Connectors), okta.com newsroom 2026-06-18, notion.com/help/set-up-enterprise-managed-connections-for-notion-mcp.
**ChatGPT:** learn.chatgpt.com/docs/enterprise/{apps-and-connectors,work-admin-faq}, developers.openai.com/{apps-sdk,plugins/build/chatgpt-ui}; help.openai.com articles 10847137, 8411955, 11509118, 12584461, 20001494, 20001495 (via search summaries, pages return 403).
**Microsoft:** learn.microsoft.com/en-us/microsoft-365/copilot/{connectors/overview,connectors/federated-connectors-overview,connectors/personal-sync-connectors-overview,copilot-agent-store}, /microsoft-365/admin/manage/{agent-settings,manage-tools-for-agent,manage-byo-mcp-server}, /microsoft-copilot-studio/{mcp-add-existing-server-to-agent,mcp-add-components-to-agent}.
**Gemini:** docs.cloud.google.com/gemini/enterprise/docs/{connect-third-party-data-source,connectors/custom-mcp-server/set-up-custom-mcp-server,assistant-use-actions,assistant-chat}, support.google.com/g/answer/17106276.
**Glean:** docs.glean.com/administration/tools/connect-remote-mcp-servers-to-glean, /administration/platform/mcp/enable-mcp-servers, /tools/human-in-the-loop-experience-for-tools, /connectors/connectors-settings-visibility, /user-guide/mcp/usage.
**Perplexity:** perplexity.ai/help-center articles 12569435, 12870620; conductor.com/docs/mcp/perplexity.
**Slack / Notion:** slack.com/help/articles/39044407124755, /38693462131219; notion.com/help/guides/use-ai-connectors-to-access-more-of-your-teams-knowledge.
**Managed auth:** docs.composio.dev/{reference/glossary,docs/authenticating-tools,docs/authenticating-users/in-chat-authentication}, nango.dev/docs/guides/auth/auth-guide, docs.nango.dev/guides/api-authorization/re-authorize-a-connection, pipedream.com/docs/connect/{managed-auth/quickstart,oauth-clients,mcp/developers}, docs.arcade.dev/home/auth/auth-tool-calling, docs.n8n.io/administer/manage-credentials/end-user-credentials.
**Standards:** modelcontextprotocol.io/specification/{versioning,2026-07-28/changelog,2026-07-28/basic/authorization,2026-07-28/basic/transports/streamable-http,2026-07-28/server/discover,2026-07-28/server/tools,2026-07-28/client/elicitation}, modelcontextprotocol.io/extensions/{client-matrix,tasks/overview,apps/overview}, modelcontextprotocol.io/seps/1865, github.com/modelcontextprotocol/{ext-auth,ext-apps,registry,mcpb}, modelcontextprotocol.io/registry/{about,registry-aggregators,remote-servers}, datatracker.ietf.org/doc/html/draft-ietf-oauth-identity-assertion-authz-grant, draft-ietf-oauth-client-id-metadata-document, keycloak.org/securing-apps/{mcp-authz-server,token-exchange,jwt-authorization-grant,identity-assertion-jwt-authorization-grant}, developers.openai.com/apps-sdk/reference.
