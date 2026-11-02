# Action detail, guidance and the test runner (#2974): implementation notes

**Date:** 2026-11-02
**Status:** Implemented (draft PR, stacked on the per-action approval PR #3141)
**Issue:** [intrafind/ihub-apps#2974](https://github.com/intrafind/ihub-apps/issues/2974)
**Concept:** [03-product-concept.md §6.5a](03-product-concept.md), [04-architecture.md §4 and §5](04-architecture.md)
**Builds on:** [2026-11-02 Action approval and fingerprints.md](2026-11-02%20Action%20approval%20and%20fingerprints.md) (#2916), [2026-11-02 Tool approval.md](2026-11-02%20Tool%20approval.md) (#2945), [2026-11-02 Example apps and chat test for integrations.md](2026-11-02%20Example%20apps%20and%20chat%20test%20for%20integrations.md)
**User docs:** [docs/integrations.md → Action detail](../../docs/integrations.md#action-detail-what-it-does-how-to-use-it-test-it)

These notes say where things are and why, for whoever continues this work (most likely the
user-side Settings → Integrations rows of #2922, which will show the example prompts).

## What the admin gets

On the installation page every action has **Details**: a drawer (shared `Drawer`) with five
sections — What it does, Side effect / data flow / approval, How to use, Test, Usage — and a
**Try in chat** button. The Overview also gets an **Instructions for the model** card. See the
user docs for the full description; this file is about the code.

## Where the pieces are

| Piece | File | Notes |
| --- | --- | --- |
| Override texts, instructions, prompt block | `server/services/integrations/actionGuidance.js` | Pure. `withActionOverrides`, `integrationInstructionsOf`, `buildIntegrationGuidance`, `appendIntegrationGuidance`. |
| Tools carry the guidance | `server/services/integrations/integrationTools.js` | `toolFromAction` (native, OpenAPI, script) and `withToolOverrides` (MCP, A2A) put the guidance on `_integration.guidance` and the instructions on `tool.instructions`; the description is the override or the vendor's, **without** the guidance. |
| Prompt builder | `server/services/chat/RequestBuilder.js`, `server/services/workflow/executors/PromptNodeExecutor.js` | `appendIntegrationGuidance(messages, tools)` right after `applyIntegrationScopes`. Scheduled runs go through `RequestBuilder` (`prepareChatRequest`). |
| MCP `instructions` | `McpServerConnection.js` (`this.instructions` after connect), `McpClientManager.serverInstructions`, `McpAdapter.serverInstructions` | Shared connections only; a per-user server has none until someone connects. |
| Action detail | `server/services/integrations/actionDetail.js` | `describeAction` builds the tool definition the way the tool loader does and runs the real resolver (`resolveToolApproval`), so the detail cannot drift from what a chat does. Bindings: apps, workflow nodes, scheduled tasks. |
| Test runner | `server/services/integrations/tester/ActionTester.js` | `testAction` → adapter `run()` directly. Confirmation gate, argument check, deadline, sources, redaction. |
| Request recording | `server/utils/outboundRecorder.js` | `AsyncLocalStorage`; `httpFetch` and `safeFetch` report every request through `withOutboundRecording`. Outside a recording it costs one lookup. |
| Redaction | `server/utils/secretRedaction.js` | By name (headers, keys, query params), by value (known secrets), URL user info. |
| Usage counter | `server/services/integrations/actionUsage.js` | Daily JSONL files in `contents/data/integration-action-usage/`; `startActionUsageTracking(interactionService)` in `server.js`. |
| Store | `InstalledIntegrationService.setActionOverride` / `setInstructions`, `keepGuidance` in `update()` | Schema: `actions.overrides[a].{description,guidance,examples}`, installation `instructions` (`integrationsConfigSchema.js`). |
| Routes | `server/routes/admin/integrations.js` | `GET/PUT …/installed/:id/actions/:action`, `POST …/actions/:action/_test`, `PUT …/installed/:id/instructions`; `GET …/installed/:id` adds `instructions` and applies the description override to `actions[]`. |
| Client | `IntegrationActionDrawer.jsx`, `ActionTestPanel.jsx`, `actionTestForm.js` (pure helpers), `IntegrationInstructionsCard.jsx`, `AdminInstallationPage.jsx` (`?action=` opens the drawer), `integrationsAdminApi.js` | en + de in `shared/i18n`. |
| Built-in guidance | `server/defaults/integration-definitions/com.intrafind__{ifinder,jira,entra-directory,ihub,brave-search,staan-search,qwant-search}` | 1.0.0 → 1.1.0 with a release entry and `releases/1.1.0/features.md` each. |

## Decisions and why

- **Guidance moved from the tool description to the system prompt.** Before, `toolFromAction`
  appended the guidance to the description, and `tool.instructions` was set but read by nobody.
  The concept says guidance is "added to the system prompt when the integration is active", and
  the issue's acceptance criterion tests exactly that. Keeping it in both places would pay twice
  in tokens. One block per installation, only for the tools the turn really offers (after app
  binding, group grants, scopes), so a switched-off action never adds text.
- **Guidance is not fingerprinted.** Fingerprints (#2916) cover name, declared side effect and
  schema; descriptions are dropped from the schema. Editing guidance or the description therefore
  never makes an action "changed". The same holds for the built-in 1.1.0 bump.
- **Web search instructions were rewritten.** The three engine definitions carried an
  admin-facing sentence ("Web search is switched on per app…") as `instructions`. Nobody read it
  before; with this change it would have reached the model, so it is model guidance now.
- **No config migration (V213 not used).** Every new field is optional and absent means "the
  definition's text". The built-in definition bumps need no definition migration either:
  installations are stamped 1.1.0 at startup.
- **A test bypasses the approval seam, not the server's own gate.** A test is an explicit admin
  action, so it does not raise an approval card. In exchange the server refuses every test of an
  action that is not a *trusted* read without `confirm: true` (409 `CONFIRMATION_REQUIRED`): write,
  destructive, unknown, and a read that only an untrusted MCP annotation claims. An admin
  override to `read` is trusted. `confirm` must be the boolean `true`.
- **The test calls `adapter.run()` directly, never `runTool`.** It is not listed among the
  `runTool` callers in `server/tests/loop/approvalSeam.test.js` because it does not call it. It
  mirrors `runIntegrationTool`'s context (`user`, `params`, `tool`) so MCP and A2A adapters find
  the tool id and the user's token.
- **Disabled actions can be tested.** The concept calls the detail "the place where an admin
  understands a tool before switching it on". An action whose requirements are not met or whose
  connector does not implement it is refused (409 `ACTION_UNAVAILABLE`).
- **Redaction is defence in depth.** Three layers: names (`Authorization`, `password`, `apiKey`,
  …), every secret value the run resolved (`resolveSecret` is wrapped; the installation's
  credential profile is read too) and every credential header value found, scrubbed from URLs,
  bodies, response, error messages. The audit entry records the arguments redacted and capped at
  500 characters (the audit schema has only a `summary` field; `action.test` is its prefix, with
  `action: 'execute'`, because the audit `action` is an enum).
- **"Run as"** follows the installation's sign-in mode: `me` (per-user OAuth: the admin's own
  token; or no sign-in) or `shared` (service account / OAuth client). Shared connections that an
  admin picks from a list (04-architecture §1.4) do not exist yet, so there is never more than one
  option today. The API already takes `connection`, so the list can grow without a route change.
- **Usage needed its own counter.** Nothing counted per action: usage events are per app and
  model, the audit log has no payload, the run ledger has no totals. A daily JSONL file is the
  smallest thing that works across workers (append-only) and cleans itself (14 days). Calls and
  errors are counted in `runIntegrationTool`; approvals from the interaction service's `answered`
  and `expired` events; tests separately, never as calls.
- **Try in chat reuses the chat test of #3125** (`?test=chat`). It runs an app bound to the
  installation, not "only this integration" in a scratch chat; building a scratch app per click
  would leave apps behind, and the example-app flow already handles the "no app yet" case.

## Known limits / follow-ups

- **iAssistant `ask`**: its definition on this base has no actions (the `ask` action of #3132 is
  not on this branch), so it got no guidance here. Add guidance and examples when #3132 lands.
- **Example prompts for users**: shown to admins only. Settings → Integrations rows (#2922) and
  the chat picker should read `actions[].examples` (already applied with overrides by
  `withActionOverrides`).
- **Usage before this version** is not known; the counter starts empty. The 7-day window is fixed
  in the UI; the API takes `days` internally (max 14).
- **HTTP recording** covers `httpFetch` and `safeFetch`. MCP stdio servers, and connectors using
  another client, show their call and arguments only. An MCP call over a long-lived SSE stream
  records the POSTs of the call, not the stream.
- **The a11y check** of the drawer is in `tests/e2e/accessibility.spec.js` (opens
  `/admin/integrations/jira?action=searchTickets`); it needs a running server and Playwright.
- **The installation's `instructions`** are edited per language like labels: a string override
  applies to every language; editing one language turns it into `{ en, <lang> }`.
