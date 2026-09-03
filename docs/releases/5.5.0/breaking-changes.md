# Breaking Changes — 5.5.0

## `config/tools.json` Is Removed

Tool configuration no longer supports the shared `contents/config/tools.json` array. Every tool
now lives in its own file under `contents/tools/`, and there is no fallback to the old file.

- A configuration migration runs automatically on upgrade: it splits any existing
  `contents/config/tools.json` into individual `contents/tools/<toolId>.json` files and deletes
  the old file. No manual action is required.
- `deepResearch`, `answerReducer`, `evaluator`, `queryRewriter`, and `researchPlanner` have been
  retired and are removed by the same migration, whether they were still in the legacy file or
  already split into their own file.
- Custom tools you added directly to `config/tools.json` are preserved — they're carried over into
  their own file with the same ID.

**Before upgrading:** No action needed; the migration handles the conversion automatically. If you
have external tooling that reads or writes `contents/config/tools.json` directly, update it to
manage individual files under `contents/tools/` instead.

## Electron Desktop App Target Removed

The `npm run electron:dev` and `npm run electron:build` scripts, the `electron/` source directory,
and the `electron`/`electron-builder` dev dependencies have been removed. This target never
produced a working packaged app — the desktop build had no valid entry point and could not reach
the local API server once packaged — so no functioning deployment is affected.

- Use the Progressive Web App (installable from the browser), the standalone binary, Docker, or
  npm for deployment instead.

**Before upgrading:** No action needed. If you had scripts or documentation referencing
`electron:dev`/`electron:build`, remove those references — the commands no longer exist.

## iFinder Source Configuration Schema Simplified

The `config` block of `ifinder` sources no longer accepts `baseUrl`, `apiKey`, `queryTemplate`,
or `filters`. These fields were never used when loading documents — the connection has always
come from the central iFinder integration — but they are now rejected on save instead of being
stored silently. Document selection moves to the new `documentId` / `query` fields, and sources
exposed as prompt context must set one of them.

- Migration V083 cleans stored sources automatically: it removes the dead connection fields,
  carries a non-empty `queryTemplate` over to `query`, and drops the auto-injected
  `searchProfile: "default"` so the platform-wide profile applies.

**Before upgrading:** No action needed for stored configurations; the migration converts them
automatically. If external tooling creates or updates iFinder sources through
`/api/admin/sources`, remove the `baseUrl`/`apiKey`/`queryTemplate`/`filters` fields from its
payloads and set `documentId` or `query` instead. Verify the central iFinder integration
(Admin → Providers → iFinder) is configured, since sources rely on it for connectivity.

## Filesystem Sources Must Live Under `contents/sources/`

Filesystem-source file operations (browse, read, write, delete, "Test connection") are now
hard-scoped to `contents/sources/`, closing a privilege-escalation gap where a restricted
**Content Admin** could reach any file under `contents/` — including `.encryption-key` and
`config/groups.json` — through the source file editor. A filesystem source's `config.path` must
now be `sources` or start with `sources/`, and no path segment may start with `.`.

- All bundled default sources already use the `sources/` prefix and are unaffected.
- A custom filesystem source you created with a `config.path` outside `sources/` (for example
  `data/file.txt`) will fail to load, and will be rejected if re-saved, after upgrading.

**Before upgrading:** If you have a custom filesystem source whose path is not under `sources/`,
move the target file into `contents/sources/` and update the source's `config.path` to match
(e.g. `sources/data/file.txt`) before or immediately after upgrading.

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
