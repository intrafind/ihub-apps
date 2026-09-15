# Features — 5.4.23

## Users Can Generate Their Own API Keys

**Settings → Integrations** now offers a **Personal API Key** card. A user clicks once and gets
credentials that let external tools call iHub Apps as them, plus the endpoint URLs those
credentials work against — no ticket to an administrator, no shared service account.

- A personal key acts as its owner: calls made with it see exactly the apps, models and prompts
  that user sees in the web UI, and never get admin access, even when the owner is an
  administrator.
- Each key comes with a long-lived API key and, optionally, a client ID and secret for the
  OAuth token endpoint. Both are shown once, when the key is created or rotated.
- The card lists the endpoints the key works against — the base URL, the OpenAI-compatible API,
  the MCP gateway when it is enabled, and the token endpoint — so there is no URL to look up.
- Users can rotate a key (fresh credentials, everything older stops working) or revoke it
  outright. Rotating also refreshes the group membership the key acts with.
- Keys show up in **Admin → OAuth → Clients** next to service accounts, so administrators keep
  full visibility and can suspend or delete any of them. Create, rotate and revoke are audit-logged.

Personal keys are off by default. Turn them on under **Admin → OAuth → Authorization Server**,
where you also set who may create keys, how many each user may hold, and the default and maximum
lifetime. The feature requires OAuth clients to be enabled. See
[Personal API Keys](../../personal-api-keys.md) for the full reference.

## One Agent Loop Behind Chats, Workflows, Agents and the Inference API

Chats, workflow prompt and agent steps, app-as-tool calls, the MCP gateway and the
OpenAI-compatible inference API now run through the same two building blocks: one model client
(`LLMClient`) and one tool loop (`AgentLoop`). Behaviour that used to differ by surface — retries,
rate-limit handling, tool-call repair, context compaction, budgets, abort handling, error codes —
is now the same everywhere, and every run is recorded the same way.

- **Consistent model calls.** Every call to a model resolves its key, throttles, retries transient
  failures (honouring `Retry-After`) and reports usage identically, whichever surface triggered it.
  Provider failures map to the same HTTP status codes and error shape across chat, workflows,
  admin tools and the inference API.
- **Consistent tool loops.** Round, token and wall-clock budgets, tool circuit breakers (rate
  limits, repeated failures), automatic context compaction and hallucinated-tool recovery apply to
  chats and workflow/agent steps alike. Agent profile budgets (`maxTokensPerRun`,
  `maxToolRoundsPerNode`) are enforced.
- **Real usage everywhere.** Workflow and agent steps and the inference API report the provider's
  actual token counts (they used to be zero or missing), so usage tracking and budgets reflect
  reality.
- **Chat tool turns keep their settings.** Follow-up model calls in a tool turn keep native web
  search, extended thinking and image settings; hitting the round cap forces a final answer
  instead of ending the turn silently.
- `LLM_TRANSIENT_RETRIES` configures transient retries for every caller (the old
  `WORKFLOW_LLM_TRANSIENT_RETRIES` is still honoured). `MAGIC_PROMPT_MODEL` and
  `MAGIC_PROMPT_PROMPT` are now actually read.

See [Agent Loop](../../agent-loop.md) and [LLM Client](../../llm-client.md).

## Run Ledger: Every Run Is Recorded and Replayable

Every chat turn, workflow execution, agent run, app-as-tool call and inference request is a
**run** on an append-only ledger: what was sent to the model, what came back, which tools ran,
every question and approval raised and answered, and how the run ended. The ledger is off by
default (`features.runLog`) and ships with identity modes (`default` id-only, `full`,
`pseudonymized`), retention and cascade delete.

- `GET /api/runs`, `GET /api/runs/:runId`, `GET /api/runs/:runId/events` and
  `DELETE /api/runs/:runId` read, replay and erase runs; owners see their own runs, admins see all,
  anonymous runs are readable only by id possession.
- A live stream that missed frames re-syncs from the ledger
  (`GET /api/runs/:runId/events?after=<seq>&view=sse`).
- Workflow executions and agent runs are runs too (run id = execution id), so one API covers
  chat, workflows and agents.
- A tool loop records only the messages it appended per step (`request/header` with
  `messagesDelta`); reconstruction replays the deltas and reports a tampered context as a
  mismatch. Nothing is hashed or recorded while the ledger is off and nobody is listening.

See [Run Ledger](../../run-ledger.md).

## One Streaming Dialect for Chat, Workflow and Agent Streams (SSE v2)

Every Server-Sent Events stream — chat, workflow execution, agent run — now carries the same
envelope: `{ v: 2, seq, runId, ts, type, data }` with fifteen event types (`run/started`,
`step/delta`, `tool/started`, `interaction/raised`, `run/ended`, …). One client reducer folds any
stream into run state; integrations write one parser instead of three.

- Sequence numbers per stream let a client detect a gap and re-sync from the run ledger; the
  `stream/connected` frame reports the last sequence number the server has.
- A workflow launched from a chat (`@mention` or workflow tool) is its own run on the chat
  stream, with its progress, checkpoints and result attributed to it.
- Payloads are validated against a published contract before they leave the server.

See [SSE v2 Streaming](../../sse-v2.md).

## One Place to Answer Questions, Approvals and Checkpoints

A chat clarification (`ask_user`), a workflow `human` node checkpoint and an agent approval are
now the same thing: an **interaction** of a run. Each is raised through one service, survives a
server restart, is answered through one endpoint and shows up in one queue.

- `POST /api/runs/:runId/interactions/:id/answer` answers any interaction; the server validates
  the option or form data, enforces approver groups (agent profiles' `hitl.approverGroups`),
  resumes the paused execution and records the answer on the ledger. A rejected answer leaves the
  interaction pending so the human can try again.
- `GET /api/interactions/pending` lists what the caller may answer — admins see everything,
  approvers their groups', users their own. **Admin → Agents → Pending Approvals** reads this
  queue and links each entry to its run.
- `POST /api/runs/:runId/human-events` records a `steer`, `stop` or `feedback` event on a run;
  `stop` aborts it. The chat stop button and message feedback record the same events.
- Chat clarifications keep their flow: the next chat message answers the pending question;
  unanswered ones are cancelled by the next message or expire after a day. Either way the run
  the question paused ends (`finishReason` `clarification_answered` / `clarification_superseded`
  / `clarification_expired`), so it never lingers as running.
- Pending interactions are stored whether or not the run ledger is enabled, and in a cluster
  exactly one worker accepts an answer: a concurrent second answer is rejected instead of
  resuming the same execution twice.
