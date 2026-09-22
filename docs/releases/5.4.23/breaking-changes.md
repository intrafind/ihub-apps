# Breaking Changes — 5.4.23

## Chat, Workflow and Agent Streams Speak SSE v2 Only

The legacy Server-Sent Events dialects are gone. Chat streams no longer emit `session.start`,
`chunk`, `thinking`, `tool.call.start` / `tool.call.end`, `clarification`, `answer.source` or
`done`; workflow and agent streams no longer emit `workflow.*` / `agent.*` events. Every frame on
every stream is now an SSE v2 envelope `{ v: 2, seq, runId, ts, type, data }` whose `event:`
field carries the v2 type (`run/started`, `step/delta`, `tool/started`, `interaction/raised`,
`run/ended`, …).

- The bundled web client, the Office add-in and the embedded chat are updated; nothing to do for
  them.
- The non-streaming chat POST (`POST /api/apps/:appId/chat/:chatId` without an open stream)
  answers with `{ messageId, model, content, finishReason, usage }` instead of the raw provider
  body.

**Before upgrading:** Update any custom client, script or integration that consumes the chat,
workflow or agent SSE streams to the v2 envelope (see [SSE v2 Streaming](../../sse-v2.md) for the
mapping from every legacy event), and any code that parsed the non-streaming chat response body.

## Checkpoint and Approval Endpoints Replaced by the Answer Endpoint

`POST /api/workflows/executions/:id/respond`, `POST /api/agents/runs/:id/approve` and
`GET /api/agents/approvals` are removed. A workflow checkpoint and an agent approval are
interactions of the run; answer them with `POST /api/runs/:runId/interactions/:checkpointId/answer`
(`{ value, data? }`, run id = execution id) and list what is waiting with
`GET /api/interactions/pending?kind=approval`.

- The web UI (workflow execution page, chat checkpoints, agent run page, Pending Approvals) uses
  the new endpoints.
- Approver groups (`profile.hitl.approverGroups`) are enforced by the answer endpoint exactly as
  before; the option and form validation is unchanged.

**Before upgrading:** Update scripts or integrations that called the three removed endpoints. A
pending checkpoint's id is the interaction id, so `{ checkpointId, response }` becomes
`POST /api/runs/<executionId>/interactions/<checkpointId>/answer` with `{ "value": response }`.

## Provider Failures Map to Uniform HTTP Status Codes

Every route that calls a model reports provider failures the same way: a provider rejecting the
server's API key is `502` (it used to be `401`, which logged the browser out), an unknown model is
`404`, an invalid request or context-window overflow is `400`, a rate limit is `429` with
`Retry-After`, a timeout is `504`. Error bodies are `{ error, code, details }`.
`GET /api/models/:id/chat/test` returns `{ success, model, content, finishReason, usage }`; the
admin model test and translate endpoints report `{ error, details, code }` instead of silently
falling back.

**Before upgrading:** Monitoring or client code that keyed off the old status codes (in
particular `401` for provider key problems) needs the new mapping.

## Agent Profile Budgets Are Enforced and Node Tool Calls Run Sequentially

`budgets.maxTokensPerRun` and `budgets.maxToolRoundsPerNode` on agent profiles were accepted but
never applied; they now stop a run or a step when exceeded. Tool calls issued by one workflow or
agent step run one after another (they mutate shared run state) unless the step sets
`parallelToolCalls: true`.

**Before upgrading:** Review agent profiles whose budgets were set low as placeholders — they now
take effect — and set `parallelToolCalls: true` on steps that relied on parallel tool execution.
