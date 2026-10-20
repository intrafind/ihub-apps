# 06 · Implementation kickoff prompt

**Date:** 2026-10-20 · Part of [Unified Integrations](README.md) · Epic [intrafind/ihub-apps#2911](https://github.com/intrafind/ihub-apps/issues/2911) · Jira [IPD-641](https://intrafind.atlassian.net/browse/IPD-641)

Paste the prompt below into a new Claude Code session (cloud or local) on `intrafind/ihub-apps` to start Phase 1. It is written for one session per issue; the model table says which model to run each issue on.

## Model recommendations

| Work | Model | Why |
| --- | --- | --- |
| #2912 schemas and files, #2913 adapters, #2914 ConnectionService and OAuth client, #2915 migrations, #2916 approval gate | **Claude Fable 5.1** (`claude-fable-5-1`), default effort | Cross-cutting design, security-sensitive token handling, migration correctness against real configs. The cost of a wrong abstraction here is the whole epic. |
| #2917 connect flow, #2919 admin section, #2920 catalog and wizard, #2923 chat picker, #2924 marketplace type, #2927 enterprise-managed auth, #2928 MCP registry adapter | **Claude Opus 5.5** (`claude-opus-5-5`) | Large but well-specified feature work with existing patterns to follow. Use fast mode (`/fast`) for the UI iterations. |
| #2918 docs and changelog, #2921 app editor section, #2922 user settings page, #2925 shared components and i18n, #2926 member requests, #2929 per-user API keys | **Claude Sonnet 5.5** (`claude-sonnet-5-5`) | Pattern-following implementation and documentation; the concept and the earlier issues fix the design. |
| Subagents inside any session: `Explore`, `i18n-checker`, lint and format fixes, test scaffolding | **Claude Haiku 5.5** (`claude-haiku-5-5`) or Sonnet 5.5 | Cheap fan-out; the parent session verifies. |
| Final review of each PR (`/code-review`, `security` agent on #2914, #2916, #2917, #2927) | **Claude Fable 5.1** | A reviewer that is not anchored on the implementation. |

Run issues in this order; each one is one PR: #2912 → #2913 → #2914 and #2915 (parallel, separate branches) → #2916 and #2917 (parallel) → #2918. Phase 2 starts when #2918 is merged.

## The prompt

```text
You are implementing the "Unified Integrations" platform in intrafind/ihub-apps. Work on ONE
GitHub issue per session. The issue number for this session is: #____ (fill in).

## Read first, in this order
1. CLAUDE.md (repository rules: license headers, lint/format before commit, migrations via the
   create-migration skill, changelog via /document-feature, KNOWN_ROUTES + index.html for new
   routes, breaking-change rule).
2. concepts/2026-10-20 Unified Integrations/README.md, then 03-product-concept.md and
   04-architecture.md in full. 01-current-state.md is the map of today's code; 05-roadmap.md
   has phases, risks and the issue list.
3. The GitHub issue for this session and the epic #2911 (decisions, phases, done criteria).
4. The code the issue names. Do not skim: open every file the issue or the architecture doc
   references and the tests next to it.

## Decisions already taken (do not reopen them)
- Vocabulary: Integration, Connection, Action. "MCP server" and "tool" do not appear in
  end-user UI.
- Write policy: every write or destructive action asks by default, MCP included; read never
  asks; unknown or untrusted effect counts as write.
- Per-chat enabled state lives on the server: per-user default per app, per-chat override,
  snapshot per scheduled task. No localStorage.
- Marketplace type `integration`; the built-in MCP catalog becomes shipped definitions.
- Clean break for /api/admin/mcp/servers, /api/admin/a2a/agents and the platform.jira /
  platform.cloudStorage writes. No aliases, no compat wrappers. The only aliases that stay are
  the OAuth callback URLs registered in vendor consoles.

## Non-negotiables
- Definitions live in contents/integration-definitions/<id>/, tokens stay in
  contents/integrations/<service>/. Never mix the two trees; never move or re-encrypt a token.
- Secrets only by reference (credential store for admin secrets, TokenStorageService for user
  secrets). A sensitive value in a config file is a bug.
- Nobody reconnects after the upgrade. The re-index mapping in 04-architecture.md §7 is the
  contract; test it with fixtures from all four legacy stacks.
- An action with no annotation on an untrusted integration is a write.
- Never retry a call automatically after an adapter or transport failure; only a pre-execution
  INTEGRATION_AUTH_REQUIRED result is retried after connecting.
- Outbound calls go through safeFetch and the SSRF guard; route ids are validated against the
  registry, never used to build paths.
- Tool ids stay <instanceId>__<action> so isToolSelected and Answer Sources keep working.
  Do not touch the Answer Sources contract (server/services/sources/*).
- Every user-facing string has en and de in shared/i18n; every new component works in dark
  mode; axe-core and jsx-a11y must pass.
- SPDX header on every new source file (see CLAUDE.md). Migrations are forward-only and never
  edited after merge.

## Working method
1. Start on a fresh branch from origin/main named claude/<issue-number>-<short-slug>.
2. Before writing code, post a short plan as your first message: files you will add or change,
   the schema or contract you will introduce, the tests you will write, and anything in the
   issue you believe is wrong or underspecified. If the issue conflicts with the architecture
   doc, the architecture doc wins; say so and continue.
3. Implement in small commits with conventional-commit messages. Keep the PR to the issue;
   if you find adjacent problems, note them in the PR description or open a follow-up issue,
   do not fix them in this PR.
4. Tests are part of the deliverable: unit tests for every new service and adapter, fixtures for
   every migration, an e2e test for every user-visible flow (login with admin/password123 for
   admin endpoints). Existing tests must pass unchanged unless the issue explicitly removes a
   feature.
5. Before every push: npm run lint:fix && npm run format:fix, the changed-package unit tests,
   timeout 10s node server/server.js (server boots), and the e2e tests you touched.
6. Open a draft PR with: summary, what changed per file group, how to verify manually, the
   migration or breaking-change notes, and "Closes #<issue>". Run /document-feature for the
   changelog entry when the change is visible to admins or users.
7. Then run /code-review on the diff and, for #2914, #2916, #2917 and #2927, the `security`
   agent. Fix what they find before asking for human review. Mark the PR ready for review.
8. Report back in one message: what is done, what is verified and how, what you left out and
   why, and the open questions that need a human decision.

## Definition of done for this issue
Every acceptance-criteria checkbox in the issue is ticked in the PR description with a pointer
to the test or the manual step that proves it. CI is green. The PR touches only what the issue
scopes. Docs and changelog are updated where the issue says so.

## If you are blocked
Say exactly what blocks you and what you need (a decision, a credential, a vendor tenant).
Do everything that does not depend on it first. Do not invent a compat shim, do not widen the
PR, do not skip or quarantine a test.
```

## Per-issue first messages

Append one of these lines after "The issue number for this session is" to point the session at the right place to start.

| Issue | Start here |
| --- | --- |
| #2912 | `server/validators/mcpServerConfigSchema.js`, `a2aAgentConfigSchema.js`, `cloudStorageSchema.js`, `credentialSchema.js`, `server/utils/authorization.js`; model the new schemas on them, then add `IntegrationRegistry`. |
| #2913 | `server/toolLoader.js` (`loadTools`, `getToolsForApp`, `runTool`), `server/services/mcp/McpClientManager.js`, `server/services/tools/OpenApiToolRunner.js`, `server/services/a2a/A2aClientManager.js`, `server/tools/jira.js`, `server/services/integrations/*Service.js`. |
| #2914 | `server/services/mcp/mcpOAuthService.js`, `McpUserOAuthProvider.js`, `mcpUserTokens.js`, `server/services/TokenStorageService.js`, `server/services/integrations/OAuthIntegrationBase.js`, `JiraService.js`, `server/routes/integrations/oauthIntegrationFactory.js`, `concepts/2026-05-11 Cloud Storage Provider Security Parity.md`. |
| #2915 | `server/migrations/README.md`, the latest `V1xx` migrations, `server/defaults/config/*.json`, `server/utils/toolSelection.js`; build fixtures before writing the migration. |
| #2916 | `server/services/loop/contracts/loop.js` (`requireApprovalFor`), `AgentLoop` `preTool`, `InteractionService`, `client/src/features/chat/components/ChatMessage.jsx` (`ClarificationCard` as the pattern for the card). |
| #2917 | `client/src/features/chat/hooks/useIntegrationAuth.js`, `client/src/features/chat/mcpApps/McpConnectCard.jsx`, `server/routes/mcpOAuth.js`, `server/routes/integrations/*.js`, `client/src/features/settings/pages/IntegrationsPage.jsx`. |
| #2918 | `docs/SUMMARY.md`, `docs/mcp-integration.md`, `docs/integration-development.md`, `docs/marketplace.md`, `docs/releases/next/`. |
