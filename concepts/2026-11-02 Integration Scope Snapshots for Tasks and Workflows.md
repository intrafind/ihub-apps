# Integration Scope Snapshots for Tasks and Workflows (#3057)

Part of #2911, follow-up of #3050 (per-chat scopes). It applies the rule of #2923 ("scheduled
tasks and workflows capture their integration set, including scopes, when they are created") to
scopes only, on the current architecture. Status: implemented on
`claude/exciting-feynman-2aju98-scope-tasks`.

## The rule

A run outside a chat has no chat state to read, so it carries its own scope:

| Run | Where the scope comes from | When it is checked |
|---|---|---|
| Scheduled task | `task.integrationScopes`, snapshotted on save (chat or form) | on save, and before every run |
| Workflow step (prompt/agent, tool) | `node.config.integrationScopes`, fixed or `$.data.…` | when the step runs |

The scope is passed to `runTool` as `integrationScopes` **after** the tool arguments, exactly as
the chat does, so the model cannot choose another one. A scope the user may not use fails the run
(code `INTEGRATION_SCOPE_NOT_ALLOWED`, message naming the scope); it never falls back silently.

## Scheduled tasks

- **Data:** `task.integrationScopes` — `{ [integrationId]: scopeId }` or `null` (same shape as
  `chat.settings.integrationScopes`). No migration: tasks without it run as before.
- **Save:** `taskService.validateTaskFields` → `taskScopes.validateTaskScopes()`:
  shape check (`normalizeChatSettings` scope map; bad entries are refused, not dropped) →
  `resolveChatScopes` for the task's app and model (pinned scopes win, integrations the app does
  not use are dropped). Field error `integrationScopes` on refusal. An edit that does not send the
  field keeps and re-checks the stored one. `duplicateTask` copies it.
- **Run:** `taskExecution.authorizeRun` → `taskScopes.resolveRunScopes()` → `RunFailure('failed',
  code, message, { extra: { integrationId } })` on refusal. The scopes go to
  `prepareChatRequest({ integrationScopes })` (tools, model guidance, iAssistant adapter) and into
  the run chat's settings. Every run has its own `chatId`, so an iAssistant scope starts a new
  iFinder conversation per run.
- **Sources of the snapshot:**
  - "Schedule this…" (`ScheduleThisAction.jsx`) — the chat's current `integrationScopes`, passed
    down `AppChat` → `ChatMessageList` → `ChatMessage` (`scheduleIntegrationScopes`).
  - `schedule_task` tool (`server/tools/scheduledTaskTools.js`) — `params.integrationScopes`
    (reserved key, set by iHub) when the task targets the chat's own app.
  - Task editor — `TaskScopesSection.jsx` with the chat's `useIntegrationScopes` hook
    (`GET /api/integrations/scopes?appId&modelId`). A stored scope no longer offered is named.
    If the list cannot load, the stored scopes are sent unchanged (never dropped).

## Workflows

- `server/services/workflow/nodeScopes.js` — `resolveNodeScopes(node, state, context, executor)`
  resolves `$.data.…` references (an empty result leaves that integration unscoped), then
  `resolveNamedScopes()` (new in `services/integrations/scopes/index.js`).
- `resolveNamedScopes` differs from `resolveChatScopes`: a node names its integrations itself, so
  it does not ask `appliesTo` (a workflow has no app binding), and an integration without a
  registered scope provider is refused.
- `ToolNodeExecutor` — fails the node before the call (even when `optional`), passes
  `integrationScopes` after `parameters`, and shows it in `resolvedInputs`.
- `PromptNodeExecutor` — resolves once per step, applies `applyIntegrationScopes` (model note,
  hides `iFinder_listProfiles`), passes `context.integrationScopes` to every tool call.
  `options.runTool` is injectable for tests.
- `workflowConfigSchema.js` — `config.integrationScopes` typed (`record<id, string 1..256>`).

## Known limits

- A prompt step whose **model** is an iAssistant does not get the scope as a provider option
  (the workflow loop does not pass `user`/`integrationScopes` to model adapters today); node scopes
  bind integration tools.
- App-as-tool calls from an agent step (`app__*`) run the other app without the node's scopes.
- Schedule-triggered workflows run as `system`; their scopes are checked for that principal.

## Tests

- `server/tests/scheduled-tasks-integration-scopes.test.js` (in `npm run test:scheduled-tasks`)
- `server/tests/runtime-workflow-integration-scopes.test.js` (in `npm run test:runtime`)
- `tests/unit/client/task-editor-scopes.test.jsx` (Jest, `npm run test:unit`)
