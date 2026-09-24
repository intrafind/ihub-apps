TITLE: Integrations: shared connection framework — per-user OAuth and shared credentials, one connect/reconnect flow, user-confirmed write actions
LABELS: enhancement, backend, frontend, admin, security
---
Part of #EPIC.

## Summary

Every integration needs the same parts:

- a way to connect: per-user OAuth, a per-user token, or a credential an admin shares;
- token storage and refresh;
- a connection status and a reconnect flow;
- a way for a tool to tell the chat "this user has to connect first";
- a confirmation step before anything is written to the external system;
- admin enablement per group.

Today each integration builds these itself. Before we add a dozen more integrations (see #EPIC), build them once and move Jira, Office 365, Google Drive and Nextcloud onto the shared version.

## Current state

- **Four hand-rolled OAuth stacks.** `JiraService.js`, `Office365Service.js`, `GoogleDriveService.js` and `NextcloudService.js` (`server/services/integrations/`) each have their own `exchangeCodeForTokens`, `refreshAccessToken`, `storeUserTokens`, `getUserTokens`, `deleteUserTokens` and `getTokenExpirationInfo`. Each has its own route file in `server/routes/integrations/`. The cleanup side of this is already tracked in #1742 (token lifecycle) and #1746 (route files).
- **Per-user token storage already exists:** `TokenStorageService` (AES-256-GCM, keyed by user, service and provider). It is the right base.
- **Admin-owned credentials exist:** `CredentialService` and `contents/config/credentials.json` support `oauth2` (client credentials), `bearer`, `basic`, `apiKeyHeader`, `apiKeyQuery` and `secret`. They are used by the OpenAPI tool runner (`type: "openapi"`, #1462) through a `credentialRef`. There is no per-user variant, so a user cannot bring their own API key or personal access token for a service.
- **The connect prompt only knows Jira.** `client/src/features/chat/hooks/useIntegrationAuth.js` hardcodes one entry (`jira`). A comment there says "Future integrations can be added here: microsoftGraph, googleWorkspace, slack". Tools signal "not connected" with provider-specific strings such as `JIRA_AUTH_REQUIRED`.
- **UI is per integration.** Users get `/settings/integrations` (`IntegrationsPage.jsx`, `IntegrationCard.jsx`). Admins get one page per integration (`AdminIntegrationsJiraPage.jsx`, `AdminIntegrationsOffice365Page.jsx`, …).
- **Write actions are not confirmed by the user.** `server/tools/jira.js` has a `requireConfirmation` parameter on `addComment` and `transitionTicket`, but it only writes a log line ("In a real implementation, confirmation would be handled by the UI"). The loop contract has `requireApprovalFor` (`server/services/loop/contracts/loop.js`) and the `AgentLoop` `preTool` seam is meant for an "approval gate", but no seam enforces it. `InteractionService` already supports durable `approval` interactions.
- **Tool naming convention:** function-style tools such as `jira_searchTickets` are matched by their base id (`jira`) in `getToolsForApp` (`server/toolLoader.js`), so an app can enable a whole integration with one entry.

## Proposal

### 1. Connector definition

A connector is a server module, for example `server/services/integrations/connectors/<id>/`, that declares:

- `id`, name, icon, description (en/de).
- `auth`: one or more supported methods:
  - `oauth2` authorization code with PKCE: authorize and token URLs, scopes (which can depend on the enabled capabilities, like `Office365Service._buildScopes` does today), and a refresh strategy;
  - `apiKey` or personal access token, entered by the user or by an admin;
  - `basic`;
  - `serviceAccount`: client credentials or a key file, admin only;
  - `none`.
- `deployment`: cloud, self-hosted base URL, or both. Self-hosted URLs go through the SSRF guard (`safeFetch`).
- `actions`: tool definitions. Each has an `effect` of `read`, `write` or `destructive`.
- Optional `triggers`: see the triggers issue in #EPIC.
- Optional `files` capability (search and download), used by the cloud storage file tools issue in #EPIC.

### 2. Connections

A connection is an authenticated instance of a connector.

- **Personal (default).** Per-user OAuth, API key or token. Actions run with that user's permissions in the external system. Stored in `TokenStorageService`.
- **Shared.** An admin-owned API key or service account, shared with groups, for example a DeepL key or a read-only database user. Stored in the credential store.
- **OAuth connections are never shared.** They represent one person's consent.
- A user can have several connections to one connector (two Jira sites, a personal and a work Google account) and marks one as the default.

### 3. Binding connections to apps

App config lists the integrations it uses and how:

```jsonc
"integrations": [
  { "id": "jira", "connection": "user" },            // each user's own connection (default)
  { "id": "deepl", "connection": "shared:deepl-pro" } // a preselected shared connection
]
```

Tools resolve the connection from this binding. Existing `tools: ["jira"]` entries keep working (they mean `connection: "user"`).

### 4. One connect/reconnect flow

- Tools return a structured error: `{ error: "INTEGRATION_AUTH_REQUIRED", integrationId, reason: "not_connected" | "expired" | "insufficient_scope" }`.
- The chat renders one generic connect card, generalizing `useIntegrationAuth`. After the user connects, the failed call is retried.
- Adding a scope to an existing connector (for example Outlook mail on top of OneDrive files) shows "Reconnect to grant new permissions" instead of failing.

### 5. User-confirmed write actions

- Actions with `effect: write` or `destructive` go through an approval seam in `AgentLoop` `preTool`. This implements the existing `requireApprovalFor` contract field with `InteractionService` `approval`.
- The chat shows a confirmation card with the exact payload (recipients and body of an email, Jira fields, page diff). The user can approve, edit or reject.
- For each connector, the admin chooses: always confirm (default), allow without confirmation, or disable write actions.
- This replaces Jira's log-only `requireConfirmation`.
- In headless runs (#2521), approvals become durable interactions the owner answers later.

### 6. Admin

- `/admin/integrations` becomes one catalog. Each connector shows its status, its enabled groups, and its OAuth client config: client id, and client secret encrypted like the other platform secrets.
- It also shows the self-hosted base URL, the enabled capabilities (which drive the requested scopes), the write-action policy, and the shared connections.
- A per-connector overview lists connected users, with a revoke action.
- A group permission (`groups.json`, resolved through inheritance) decides who may use each connector.

### 7. User

`/settings/integrations` lists every connector the user is allowed to use. For each, the user can connect, disconnect, reconnect, pick the default connection, and see when access expires and which permissions were granted.

### 8. Headless and audit

- Scheduled tasks (#2521), workflows and triggers run with the owner's connection. A failed refresh produces an actionable "Reconnect <integration>" error.
- The audit log records connection created and revoked, and every executed write action (connector, action, target id, user). It does not record payload contents.

### 9. Migration

- Move Jira, Office 365, Google Drive and Nextcloud onto the framework. Existing stored tokens must keep working, so reuse the `TokenStorageService` keys.
- Move config into the new structure with a versioned migration in `server/migrations/`.
- Whether the old per-integration routes stay as aliases is a breaking-change decision to make explicitly (see open questions).

## Technical notes

- **Generic routes:** `/api/integrations/:connectorId/auth|callback|status|disconnect`, with `state` and the PKCE verifier kept server-side. Validate `connectorId` against the registry (path-injection guidance in the `api-security` skill).
- **Outbound calls:** go through `safeFetch` and `requestThrottler`. Response size caps and truncation work like `OpenApiToolRunner`.
- **Tool ids:** keep the `<connector>_<action>` convention so base-id matching in `getToolsForApp` keeps working. Note that existing agent tools are called `create_task`, `list_tasks` and `mark_task_done`, so connector action names must be prefixed.
- **OpenAPI tools:** a connector can back its actions with the OpenAPI tool runner, so a new REST integration can be mostly declarative.
- **Content is untrusted.** Treat external content (emails, tickets, pages) as untrusted input to the model. Tool results carry a marker the prompt can use, and write actions always pass the confirmation gate.
- **Feature flag:** the `integrations` feature flag already exists. i18n en/de for all UI.

## Acceptance criteria

- [ ] Connector registry with oauth2 (PKCE), apiKey/PAT (user or admin), basic, serviceAccount and none.
- [ ] Personal and shared connections; several connections per connector with a default; OAuth connections cannot be shared.
- [ ] Apps bind integrations to "each user's own" or a preselected shared connection; existing `tools: ["jira"]` configs keep working.
- [ ] One generic connect/reconnect card in chat, driven by a structured error; the failed tool call is retried after connecting; insufficient scope leads to reconnect.
- [ ] Write/destructive actions require user confirmation with the exact payload by default; admin policy per connector; Jira's `requireConfirmation` is replaced.
- [ ] `/admin/integrations` catalog with group enablement, OAuth client config, capabilities, write policy, shared connections, and connected-user overview with revoke.
- [ ] `/settings/integrations` lists all allowed connectors with status, default connection and granted permissions.
- [ ] Jira, Office 365, Google Drive and Nextcloud run on the framework without users having to reconnect; config migration included.
- [ ] Audit entries for connection lifecycle and write actions.
- [ ] Unit tests for token refresh, scope upgrade, connection resolution, approval gating; E2E for connect → tool call → confirm write.
- [ ] Docs (`docs/` + `docs/SUMMARY.md`) and a changelog entry in `docs/releases/next/`.

## Open questions

1. **Old routes:** keep `/api/integrations/jira/*` and the other per-integration routes as aliases, or make a clean break? This needs an explicit decision before implementing any compatibility shim.
2. **Default write policy:** "always confirm" for every connector, or can low-risk writes (a comment, a draft) default to no confirmation?
3. **Per-user API keys:** allow users to enter personal API keys for any connector, or only for connectors the admin opts in?
4. **Scope of v1:** land the framework together with one new connector (for example Outlook Mail) to prove it, or migrate the four existing integrations first?

## Related

- #1742 and #1746: code-level deduplication that this framework absorbs.
- #1462: the OpenAPI tool runner, which can back connector actions.
- #2521: scheduled tasks, which need headless connections and durable approvals.
- #2485: marking tools read-only, which lines up with `effect: read`.

---
_Generated by [Claude Code](https://claude.ai/code)_
