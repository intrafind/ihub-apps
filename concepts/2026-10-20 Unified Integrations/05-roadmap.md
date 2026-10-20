# 05 · Roadmap, risks and open questions

**Date:** 2026-10-20 · **Status:** Proposal · Part of [Unified Integrations](README.md)

## Phasing principle

Ship the shared layer under the existing integrations without changing what users see, then change what users see, then add what nobody has. Each phase leaves the product consistent and releasable. Effort is given in developer-weeks for one developer plus review; the first phase is the one to estimate carefully with the team.

## Phase 0 · Decide (1 week)

- Agree the vocabulary, the default write policy, server-side chat preferences, the nav change, the marketplace type and the breaking-change stance ([03 · Product concept](03-product-concept.md#10-decisions-this-concept-asks-for)).
- File the epic and sub-issues from this folder and from `concepts/third-party-integrations/` (still unfiled).
- Create the Jira idea (IPD) and link IPD-618 (iFinder MCP server) and IPD-554 (business-user admin for connectors).

## Phase 1 · Foundation, almost invisible (5 to 6 weeks)

Goal: one definition format, one instance store, one connection service, one OAuth client, one approval gate. The admin and settings UI still look the same. One change is visible to users on purpose: write and destructive actions now pause for the confirmation card. It ships in this phase because it is a safety fix for integrations that already write today (Jira comments and transitions), and it is announced in the changelog as such.

1. `IntegrationDefinition`, `ConfigField`, `InstalledIntegration`, `Connection` schemas (Zod) and files.
2. Adapters for `mcp-remote`, `mcp-stdio`, `openapi`, `a2a`, `storage`, `websearch`; `native` with Jira, Microsoft 365, iFinder, Entra on the adapter contract.
3. `OAuthUserClient` generalized from `mcpOAuthService`; `ConnectionService` with re-index of existing tokens; Jira and the three storage providers switched to it.
4. Migrations V1xx (MCP, A2A, platform, groups, apps) with fixtures from real customer configs.
5. `ApprovalGate` in `AgentLoop.preTool` with `InteractionService`; the `ApprovalCard` in chat. Default *ask* for write and destructive.
6. `GET /api/integrations`, connect/disconnect/reconnect routes with callback aliases, one `ConnectCard`.
7. Docs: `docs/integrations.md` (new, in `SUMMARY.md`), update `mcp-integration.md`, `integration-development.md`; changelog entry.

Exit: every existing integration runs through the new layer; e2e suite green; no user re-connects.

## Phase 2 · The visible product (5 to 6 weeks)

1. Admin: Integrations list (`DataTable`), Catalog tab with the built-in catalog converted, install wizard, instance page (Overview, Actions, Connections, Bindings, Audit, Settings), group permissions, platform policy rules, "Inbound" tab. Remove MCP servers, A2A agents and hub pages.
2. App editor: one `IntegrationsConfigSection`.
3. User: Settings → Integrations "Available to you"; chat `IntegrationPicker`, chips, lazy connect that returns to the same chat and retries; server-side preferences.
4. Marketplace type `integration`; shipped definitions moved to `server/defaults/integrations/`; IntraFind registry gets its first integrations (Jira and Confluence Data Center, SharePoint on-prem, Nextcloud, DeepL).
5. Shared `Switch`, `Badge`, `StatusDot`, `Drawer`; i18n en/de complete; dark mode.
6. Member requests ("Request → Requested" and the admin queue).

Exit: an admin installs Confluence Data Center from the catalog, scopes it to a group, a user connects from the chat and writes a page after confirming.

## Phase 3 · What the directories lack (ongoing, 2 to 3 weeks each)

- **Enterprise-managed auth** (ID-JAG) as auth mode, first with Okta/Entra-issued assertions; Keycloak issuance when it lands.
- **iFinder as MCP server** (IPD-618) with search and fetch, served through the inbound gateway with RFC 9728 metadata; and iFinder as a *search* capability inside integrations so `sources` and integrations converge.
- **Public MCP registry** sub-registry adapter (community, off by default).
- **Native connectors from the epic**: Outlook Mail and Calendar, cloud file tools, Teams, SAP OData, DMS (d.velop, enaio, nscale, ELO, M-Files), ServiceNow, Personio, DATEV; each as a definition plus adapter module, published through the IntraFind registry.
- **Triggers** (`02-triggers.md`) as a capability once scheduled tasks can receive events.
- **Per-user API keys for OpenAPI integrations** (`ConfigField.scope: user`), several connections per integration with a default.
- **Auto vs on-demand tool mode** for apps with many integrations: deferred action definitions with `search_tools` / `call_tool` ([intrafind/ihub-apps#2889](https://github.com/intrafind/ihub-apps/issues/2889)), surfaced per integration in the picker.

## Risks

| Risk | Mitigation |
| --- | --- |
| Migration breaks customer configs | Fixtures from real `mcpServers.json`, `platform.json`, `groups.json`; migration dry-run command; keep callbacks stable |
| Users must reconnect | Re-index tokens in place; never change `TokenStorageService` keys in phase 1 |
| Per-user MCP tool lists differ per user | Keep the shared catalog for admin configuration; show "actions may vary by account" on the instance page (the spec allows credential-scoped lists) |
| Approval fatigue | Read actions never ask; "allow for this chat" memory; admin can set *allow* per action; new write tools default to *ask* but are flagged, not silently blocked |
| Untrusted annotations | `trusted` flag per instance; untrusted + no annotation = write |
| Scope creep into a connector marketplace business | Phase 1 and 2 are the platform; connectors are a separate, demand-driven backlog |
| Two concepts drift apart | This folder supersedes the enablement, connection and UI parts of `third-party-integrations/01-framework.md`; the per-connector drafts there stay valid |

## Open questions for the team

1. ~~**Name on the sidebar**: "Integrations" (this concept) or "Connectors" (Claude, Microsoft, Glean)?~~ Decided 2026-10-20: "Integration" and "Connection" everywhere; "MCP server" and "tool" leave the end-user UI.
2. **Shared OAuth connections**: forbid entirely (Langdock: only via an app's pre-selected connection) or allow an admin to share their own OAuth connection with a group for service-like use?
3. **Web search as an integration row** in the picker, or keep the dedicated switch? Concept says row, with the same look as today.
4. **Sources**: fold `ifinder`, `url` and future "search" capabilities into integrations in phase 3, or keep knowledge sources a separate feature for good?
5. ~~**Clean break of admin routes** vs aliases, per CLAUDE.md.~~ Decided 2026-10-20: clean break for `/api/admin/mcp/servers` and `/api/admin/a2a/agents`; stable OAuth callbacks. The release notes for the phase that ships it carry a breaking-change entry in `docs/releases/next/breaking-changes.md`.
6. **Community registry**: do we ever show the public MCP registry to customers, or only our curated catalog plus their own registries?
