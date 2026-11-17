# Agents, Sub-Agents and Workflow Steps — Target Model

Status: decided on 2026-11-17 after a panel review by eight roles · epic #3771 · the sub-issues
carry the detail · builds on #3196, #3197, #3365, #3687, #1495

## Why

iHub has a solid loop, a run ledger, approvals, integrations and scheduled tasks. It does not yet
have an agent in the sense users now expect: something lasting that you give a goal, that works on
its own, that you can talk to, that knows what it did, and that gets better. This document says
what is really there today, what an agent is, how sub-agents and background work fit in, and which
workflow steps stand next to today's node types.

This is the overview. Each part is specified in a sub-issue of #3771; the issues are linked by
number.

Out of scope: sandboxed code execution (#2663), evals and the tool job queue (#1495). Later: admin
hooks and approval rules (#3195, #2411), cost per run (#2401), MCP 2026-07-28 and A2A 1.0
migration.

## Decisions

**Agents**

- iHub builds its own agents; no agent framework is embedded.
- An agent is a lasting entity, not a run. It has one memory and many chats. A run is one moment
  it is awake.
- An agent is a separate definition. It is not built from an app.
- One agent definition, three modes: free, with a plan, fixed procedure. They differ only in who
  decides the steps.
- There is no default assistant for every user.
- The Agent Factory (profiles, inbox, admin pages) is removed without a check or a migration;
  nobody uses it.
- Self-improvement is gated. Personal agents apply memory changes with a diary and undo; provided
  agents need approval. Changes to instructions and skills are versioned.

**Sub-agents**

- Delegation is a property of every run and is on by default. It is not a group permission.
  Whether and how much an agent, workflow or app may delegate is a setting on that definition.
- The tool is `delegate`. The `apps` list on an app is the one allow-list; the `appAsTool` flag
  is dropped.
- A sub-agent has only the rights that both the parent and the app allow.
- Sub-agents are read-only in the first release. Background sub-agents are always read-only.
- A sub-agent's report, and every event no person typed, enters the parent as data, never as the
  user's voice.
- A delegation over the limit is refused with a message the model can read. It is not queued.

**Runs**

- One run service and one run executor carry chat, scheduled runs, new workflow steps, agents and
  sub-agents. The OpenAI-compatible API, MCP inbound and A2A inbound run on the run service too.
- "Behaves as before" means the same events, evidence, usage and approval prompts, plus a signed
  list of accepted differences. Model input need not be byte-equal.
- Several workers on one host are supported. Several pods are not required.
- A write tool call in flight at a crash is never run again by the system. The run stops as
  `needs attention` and shows what was in flight. The user may choose "run again".
- Interactive turns have a time ceiling, configurable, 60 minutes by default.
- A message typed during a run steers it by default; "send afterwards" is an option. Only the
  chat owner may steer; admins may not.
- Every `needs attention` carries a reason and the action expected from the user.
- The chat is where things persist; the run ledger is only for running runs. The evidence record
  (`docs/chat-evidence.md`) is the audit record. A summary never replaces the original.

**Workflows and plans**

- An agent's plan is a workflow. An agent with a plan builds and amends it; an agent with a
  fixed procedure follows one an admin authored and locked.
- Ten steps named for what they do form the new step set. The step contract is accepted with
  eight additions; `transform` has no successor.
- The engine drives the steps in both modes. The agent's controlling run owns the transcript and
  changes the plan only through plan tools.
- A plan written by the model may contain whatever is necessary: tools and integrations, writing
  artifacts, asking the user, loops and nested plans.
- A write inside a loop the model wrote is approved once for the whole loop.
- Whether plan approval also covers later changes is a setting chosen when the agent is saved.
- Who may author workflows stays as today.

**Legacy workflows**

- The 26 old node types and their engine path stay runnable in the first release as a frozen
  legacy path. Old node types can no longer be added.
- The new steps are a second set on the new engine. A workflow is either legacy or new.
- Rebuilt default workflows ship next to the old ones. The legacy path is removed in a later
  release.

**Trust and approval**

- Three group permissions exist: use agents, unattended work, publish agents.
- New feature flags are preview and off. The permission migration never overwrites a value an
  admin set.
- For an unattended run woken by untrusted input the platform may force approval.
- An agent may run without approval only after an explicit consent per agent: by the owner for a
  personal agent, by an admin for a provided one.

**Retention and identity**

- An agent's own identity is never an admin and has its own quota. A provided agent a user starts
  runs as that user and counts against that user's quota.
- One limits block holds all run limits, with a smaller pool for unattended runs.
- Agent chats have their own retention class and do not count against the user's chat cap.
- Chats of scheduled runs keep their own setting with today's default: the newest 20 per task.
- Personal agents and their turns are deleted with the user, and the evidence with them.

**Sequence against other epics**

- The admin rework (#3739, #3742) goes in before this epic, and this epic is re-checked against
  it afterwards. The agent-editor items of #3742 are skipped.
- The memory epic (#3365), non-destructive summarisation (#3192) and the later phases of #3687
  come after this epic.
- Browser push (#3198) is deferred; in-app notifications come first.

## Where iHub stands (code read on 2026-11-17)

**One loop, three harnesses.** `server/services/loop/AgentLoop.js` is the only tool-calling loop.
It has three callers, and each wraps it differently:

| Caller | Wrapper | Own tool runner | Own prompt assembly |
|---|---|---|---|
| Chat, scheduled tasks | `ChatService.runTurn` (`services/chat/ChatService.js:958`) | `runTool` | yes |
| Workflow and agent nodes | `PromptNodeExecutor.executeLLMWithTools` (`:1613`, file is 3,545 lines) | `executeToolCall` (`:2038`) | yes |
| App as tool | `ChatService.invokeAppInternal` (`:1743`–`:1989`) | `runTool` | a third copy of the chat pipeline |

Planner, verifier, query plan and memory composer are single model calls outside the loop. A chat
turn runs inside the HTTP request that started it: it survives a closed tab, not a restart. There
is no job runner (#1495).

**Four recovery and lease mechanisms exist side by side.** Scheduled runs hold a token and a
lease (`services/scheduler/tasks/taskModel.js`). Workflows use `resumeManager.js`,
`orphanSweeper.js` and `triggers/schedulerLock.js`. Chats use `chatRecovery.js`. Interactions use
`locks.withLock`. The filesystem storage provider reports `multiInstance: false`.

**Workflows are a preview feature and off by default** (`server/defaults/config/features.json`).
A run started from the workflows page or from chat stores its full definition in its state
(`routes/workflow/workflowRoutes.js:874`, `tools/workflowRunner.js:276`). An agent run does not,
and crash recovery always resolves the definition again from the profile or `contents/workflows`.
So an admin edit changes what a recovered run or an agent run continues on. Crash recovery also
runs the step that was in flight again (`WorkflowEngine.js:474`), including a step that writes.

**"Agents" are research pipelines.** An agent profile is compiled into a workflow
(`server/agents/profile/profileWorkflowSerializer.js`): start → planner (one call, JSON plan) →
one task node per plan item → synthesize → end. The model does not steer the run, cannot be talked
to, and starts manually only (`routes/agents/runs.js:211`). The schedule field in the editor is
saved in a shape the trigger source does not read, so it never fires (#3742).

**The closest thing to an agent is a chat app with tools**; a scheduled task is that same turn
without a user, with an owner, a schedule, notes and run history. Scheduled tasks are on by
default (`server/featureRegistry.js:158`) and hold live user data. Each run has its own chat.
These chats are outside the user's cap of 200, and the newest 20 per task are kept
(`maxRunChatsPerTask`, `services/scheduler/tasks/taskPolicy.js:49`).

**Sub-agents exist only as `app__<id>`** (`services/chat/appToolsGateway.js`): a blocking call to
another app, 3 minutes wall clock, one level, approvals denied, no questions. Nothing runs in the
background and nothing wakes the caller.

**Evidence** (`docs/chat-evidence.md`) already records, per answer, every model call with its
messages, tools, settings and output, and every tool call with arguments and result. It covers
chat answers and runs without a chat. Workflow and agent runs are not covered.

**Permissions and limits.** `server/defaults/config/groups.json` has no permission for agents,
delegation, background work or unattended triggers. Limits are spread over
`platform.scheduledTasks`, `platform.requestConcurrency`, per-model `concurrency`, `usageLimits`
and `profile.budgets`. Usage records have no dimension for an agent, a trigger or a sub-agent.

**The Claude-style agent** (`server/defaults/workflows/claude-style-agent.json`) plans with
`set_plan`, works, then an adversarial verifier sends it back. Read, not run, the reasons it does
not finish are:

1. The reviewer is told to "try to break it" against open-ended criteria, so it always finds gaps.
2. A retry restarts the work step with the old draft pasted in. The agent has lost what it
   learned and rewrites the whole draft, which opens new gaps.
3. The loop ends only on a stall (2 rounds without fewer gaps) or 6 retries, as a failure.

Built but not wired: steering has a server queue and no UI, and a steer id, a cancel and an
"applied" event are missing (#3191); parallel read-only tool calls are hard-coded off in chat
(#2485); tool search sits behind a preview flag (#2889).

## Target model

### What an agent is

An agent is its own definition (#3773). It does not wrap an app.

| Part | Meaning |
|---|---|
| Profile | Name, description, owner, who may use it |
| Goal | What it is for; standing, not per run |
| Instructions | How it works |
| Model, tools, skills | What it works with |
| Memory | What it has learned (see below) |
| Triggers | Schedule, webhook, event, a message |
| Mode | Free, with a plan or fixed procedure |
| Delegation | Whether and how much it may delegate |
| Approval | Whether it may run without approval (explicit consent) |
| Identity | Whose rights it runs with |
| Version | Every change to the above is a version |

A personal agent belongs to one user. A provided agent is set up by an admin and used by users:
the admin marks which parts a user may set (goal, inputs, schedule, connections), the rest is
locked, and each user's settings are stored per user. No user gets a default assistant.

**One agent, many chats.** What is single is the agent's knowledge, not its conversation. A chat
that belongs to an agent is an ordinary chat, so every discussion and every piece of work can be
reopened. The UI word is "chat". There are three kinds:

| Chat | Started by | Content |
|---|---|---|
| Conversation | The user, as many as they like, named | A discussion with the agent |
| Scheduled run | A trigger of a standing job | A fresh chat per run |
| Handoff | A mention of the agent in another chat | The work the agent took over |

**No timed reset.** A long chat is compacted without deleting anything; a finished topic gets a
new chat. Nothing is cleared, so a specific discussion can always be found again.

**Scheduled runs** are standing jobs, each with its own goal and trigger. Every run starts a
fresh chat. It knows what was done before through the agent's memory and the job's own
scratchpad: notes kept for this job, plus the result and end state of the last run.

A scheduled run may exist without an agent, as a scheduled task does today. A migration converts
the existing scheduled tasks and creates no agent; the user can attach one later (#3783). The
`scheduledTasks` flag and permission keep gating scheduled work without an agent. The UI entry is
called "Scheduled", and `/tasks` redirects. `/api/scheduled-tasks` is replaced in a clean break
with a release note and no shim.

**Handoff from another chat.** The user mentions the agent in any chat and tells it to take care
of something. The agent receives the instruction and a read-only snapshot of that chat up to this
point, and continues in a chat of its own. The source chat gets a link to that chat and a note
when the work ends. A personal agent may read the snapshot because it runs as the user; a
provided agent under its own identity sees only what the handoff passes.

**The agent's home** is a view, not a context window: a feed across all its chats showing what
ran, how it ended and what is open. Running and waiting work of all kinds also has its own
sidebar entry, with stop (#3782).

**Everything that wakes it is an event.** A message, a schedule tick, a webhook, a handoff and a
returning sub-agent are handled the same way: the event arrives in the chat's durable event
queue (#3197), the agent wakes in that chat, reads the event and acts. One run per chat is active
at a time; chats of the same agent run side by side. A message typed while a chat works steers
the run at its next step (#3191); the user can choose "send afterwards" instead. Only the chat
owner may steer.

**State is assembled per wake, not carried.** Each run starts from: profile, goal and
instructions; memory; open items (todo list or plan); for a scheduled run, its scratchpad; the
chat's own history; a digest of recent activity in the agent's other chats; the new event.
Anything else is fetched with tools that search the agent's chats and artifacts.

**Each run ends by writing down what it did**: result, what is open, and an end state.

| End state | Meaning |
|---|---|
| `done` | The work is finished |
| `blocked` | The agent cannot continue |
| `needs attention` | The agent needs something from the user; it says what and why |
| `no change` | Nothing new; no notification |

Every `needs attention` carries a reason and the expected action. A result delivered with open
points ends as `needs attention`, and the agent says what it needs.

### Three modes

| Mode | German UI | Who decides the steps | What can be inspected |
|---|---|---|---|
| Free | Frei | The agent, turn by turn, with a non-binding todo list | Evidence record |
| With a plan | Mit Plan | The agent writes a plan as a workflow, follows and amends it | Evidence record, step graph, plan revisions |
| Fixed procedure | Fester Ablauf | An admin authors and locks the workflow | Evidence record, step graph, identical every run |

A free-mode scheduled run is the scheduled task grown up. Plan approval before start is a setting
per agent. Whether that approval also covers later changes to the plan is chosen when the agent
is saved (#3775).

### Identity, quota and permissions

| Agent | Started by | Runs as | Counts against |
|---|---|---|---|
| Personal | Owner or owner's trigger | The owner, with the owner's connections | The owner's quota |
| Provided, started by a user | The user | That user | That user's quota |
| Provided, on a trigger | Schedule, webhook, event | Its own identity | Its own quota |

An agent's own identity is never an admin, and its quota is never the creating admin's. It is a
countable principal that shows in the usage reports (#3781). When an agent runs with a person's
rights, the record names both the agent and the person. Rights are built again each time a run
is picked up, so a change to the owner's groups reaches the next run (#3777).

Access to the chats of an agent that runs under its own identity can be granted to users and
groups.

| Group permission | Allows |
|---|---|
| Use agents | Create personal agents and use provided ones |
| Unattended work | Triggers and runs with nobody present |
| Publish agents | Provide an agent to other users |

A migration writes the permissions and never overwrites a value an admin set. New feature flags
are preview and off (#3780). Delegation is not a permission.

All run limits live in one block, `platform.runs`: caps per installation and per user, group
overrides, and a smaller pool for unattended runs so interactive chat keeps its capacity. One
quota spans a run, its sub-agents, its follow-ups and its scheduled runs (#3781).

### Sub-agents

Every run has a `delegate` tool unless its definition switches delegation off (#3196). The
setting sits on the agent, workflow or app and says whether and how much it may delegate, in the
way an effort level does.

- **Brief, optional app, wait or background.** With an app the sub-agent uses that app's
  instructions, model and tools. Without one it gets a worker prompt, the parent's model and a
  subset of the parent's tools. The `apps` list of the calling app is the allow-list.
- **Rights are the intersection.** A sub-agent may do only what both the parent and the app
  allow. The run service computes this, not the caller.
- **Fresh context, own budget** taken from the parent's quota.
- **Read-only first.** No sub-agent writes in the first release. Background sub-agents are
  always read-only. Sub-agents cannot write memory or send messages out.
- **Approvals and questions surface in the parent's chat** with a sender the server sets.
- **It reports through an artifact**: findings, evidence, open questions, what it did not do. The
  tool result is a summary plus the artifact reference. The parent can ask the same sub-agent a
  follow-up.
- **The report is data.** It enters the parent as a tool result or an event, never as a user
  message.
- **Limits.** Delegation from a chat goes one level deep, with capped concurrency per user. A
  delegation over the limit is refused with a message the model can read; nothing is queued.

**Background.** The tool returns a handle at once. When the sub-agent ends, its report is
delivered to the parent's chat as an event and a turn of the parent starts by itself. The parent
has tools to list, check, message and cancel its sub-agents; the UI shows them as running. A
handoff uses the same mechanism with a named agent as the target; the target runs as a linked
run of its own, so it can delegate.

### Trust rules

Text that no person typed must not be able to act as the user (#3785).

- **Origin.** Every event that wakes or feeds a run carries an origin the server sets: `person`,
  `child_report`, `webhook`, `schedule`, `handoff` or `followup`. Only `person` becomes a user
  message.
- **Taint.** A run that has read untrusted content is marked as tainted; tools declare whether
  they return untrusted input.
- **Forced approval.** A tainted run with nobody present parks a write to an external system for
  approval. Depending on the mode the platform forces this whatever the configured approval mode
  says.
- **Consent.** An agent runs such writes without approval only with an explicit consent on that
  agent. The owner gives it for a personal agent, an admin for a provided one.
- **Rights are enforced in the run service**, so no surface can skip them.

### Crash and unknown outcome

A run is a job with a stored record, claimed by one worker, and it continues after a restart
(#3777). The ledger is flushed before a tool that is not read-only starts.

| In flight at the crash | On resume |
|---|---|
| A model call | The call is repeated |
| A read-only tool or step | It runs again |
| A write tool or step | It is never run again by the system |

After a write with unknown outcome the run stops as `needs attention` and shows what was in
flight. The user may choose "run again" as an explicit choice.

### Memory and improvement

The memory layers, the background pass and gated improvement are built with the memory epic
(#3365), which follows this epic. Memory keyed by agent and user is a new partition and needs a
decision record there. The target is two layers, as OpenClaw and Hermes both have:

- **Notes**: cheap, dated, appended by the agent during work. Notes belong either to the agent
  or to one scheduled job (its scratchpad).
- **Curated memory**: small, loaded on every wake, changed only by a background pass.

**The background pass ("dreaming")** runs when the agent is idle. It reads only the owner's own
turns and the agent's notes, never tool output, web content or other users' turns. The model
decides add, merge or supersede; the server writes the text from the source with a reference back.
The previous version is kept, and a rewrite that loses a large share of entries is rejected.
Because chats only append notes and the pass alone changes curated memory, parallel chats cannot
overwrite each other.

| What changes | Personal agent | Provided agent |
|---|---|---|
| Curated memory | Applied, shown in a diary, undo | Proposed, approved by an admin |
| Skills, instructions, goal | Proposed, approved by the owner | Proposed, approved by an admin |

Every accepted change is a new agent version, and each run records the version it ran with.

### Summaries and artifacts

Run files are artifacts in the single artifact repository (#3556). Tool results that are too
large, sub-agent reports and step outputs are stored in full and are readable by the agent.
Compaction (#3192) and digests are views: each summary carries references to what it summarises,
and the original is never deleted by summarising.

### Evidence

**Persistence lives in the chat, not in the ledger.** The run ledger exists so a run can be
followed, reattached and recovered while it is active; its journal goes once the result is stored
(#3687). What lasts is the chat: messages, activity, artifacts and the evidence record per answer.
A workflow or agent run stores its steps, results and evidence there. History search reads chats
and evidence, never the journal.

No new format. The existing record is extended by:

1. Records for sub-agent runs (#3196) and agent runs (#3773).
2. Links from a parent record to each sub-agent's record.
3. The workflow definition a run used, and the plan at each revision with the model call that
   caused it (#3788).
4. The agent version: profile, memory and skills in force.

Reasoning is stored as far as the provider returns it, labelled as what the model stated.

### Retention and offboarding

| What | Rule |
|---|---|
| Agent chats | Own retention class and own cap; not counted against the user's chat cap (#3787) |
| Chats of scheduled runs | Own setting, default the newest 20 per task (`maxRunChatsPerTask`) |
| Evidence | Lives with the turns and is deleted with them; no separate longer-lived store |
| A user leaves | Personal agents and their turns are deleted with the user |

A legal hold is not a precondition of this epic. Each new store adds a step to the user cleanup
and a row in `docs/pii-data-handling.md`.

### Finishing

- The plan states what "done" means; a Check grades against exactly those criteria.
- A revision continues the same run and edits the result; it does not start over.
- After two check rounds with gaps the run ends as `needs attention`, lists the open points and
  says what the agent needs from the user.

## Workflow steps

Today: 26 node types (`server/services/workflow/executors/index.js`). The new set has ten steps
(#3774). It is a second set next to the old one, not a rename.

| Step | Does | Covers what today is |
|---|---|---|
| Start | Inputs or a trigger | `start`, `inbox-load` |
| Agent step | Instructions, tools, skills; runs the loop; may delegate and plan | `prompt`, `planner`, `query-plan`, synthesizer |
| Find documents | Search a project, iFinder or the web, with optional refinement rounds | `corpus-search`, `project-items`, `project-read` |
| Extract | Structured data from documents by schema, one record per document | `prompt` with schema, `structured-record`, `quote-validator` |
| For each | Repeat steps per item, optionally in parallel; a repeat mode runs rounds | `loop`, `parallel`, `join` |
| Check | Grade a result against criteria: pass, revise, or open points | `verifier` |
| Ask a person | Approval or input | `human` |
| Branch | Condition | `decision` |
| Action | Call an action of a connected system | `tool`, `http`, `memory` |
| Write result | Report from a template, artifact, project item, delivery | `template-render`, `project-write`, `end`, `inbox-finalize` |

The Check step ships with the workflow steps, not with the plan modes.

### Step contract

- Every step has one output of a fixed shape for its kind.
- A step declares its inputs as references and cannot write anywhere but its own output.
- There is no shared variable bag, no `set`, no `assign` option and no `transform`. What
  `transform` did is a step output, a value the loop provides or a step option.
- Progress messages, counters, coverage and error collection are options or fixed outputs of a
  step, not nodes.

| Reference | Meaning |
|---|---|
| `input.<name>` | A workflow input |
| `steps.<id>.output.<field>` | A field of an earlier step's output |
| `item`, `index`, `number`, `total` | Inside For each: the item, its position from 0 and from 1, the count |
| `round`, `previous.<step>.output.<field>` | In repeat mode: the round and the last round's output |

The contract has eight additions:

| # | Addition | Content |
|---|---|---|
| 1 | Extract | `documents` is a list or one item; optional `content` input or loader with `maxChars`; each record has a fixed envelope with `source`, `data`, `quotes`, `status`, `failures`; `coverage`; `onInvalidOutput: record \| fail` |
| 2 | For each | Outputs `items[]` in input order, `failed[]`, `count {total, processed, failed, skipped}`; options `onItemError`, `retries`, `limit`, `collect` with one-level flatten |
| 3 | Find documents | `queries` takes several references and literals, de-duplicated; options `filters`, `limit`, `perQueryLimit`, `refine {maxRounds, judge}`; `coverage`; first-seen order |
| 4 | Repeat | A mode of For each, not an eleventh step; outputs `rounds[]` and `count` |
| 5 | Write result | Named `variables` bound to references, no access to anything else; output `artifact {name, text, bytes}` |
| 6 | Conditions | Equals, not equals, greater, less, contains, exists, and, or, not; a reference on both sides; no arithmetic, no `length`; evaluated without `vm` |
| 7 | Action | Output `result`; a built-in `memory.read-section`; `onError: empty` |
| 8 | Start and workflow | File inputs are always lists; defaults also apply to empty values; a workflow may return several named results |

Two more rules: Ask a person works inside For each and its repeat mode. Action calls connected
systems only; a free URL is for admins only.

Agent step outputs `text`, optional `data` (with an output schema), `sources` and `artifacts`.
Check outputs `verdict` and `criteria`. Ask a person outputs `answer`.

### Law consultation workflow

| Variant | Today | Rebuilt |
|---|---|---|
| Upload (`stellungnahmen-review-v2`) | 7 nodes | 3 steps: Start → Extract over the uploaded documents → Write result |
| iFinder (`stellungnahmen-review-ifinder-v2`) | 13 nodes | 8 steps, 6 at the top level: Start → Action (corpus map) → Agent step (query plan) → Find documents with refinement → For each document: Action (load), Extract → Write result |

If Extract loads the documents itself, the iFinder variant needs no For each and is six steps.
The four `transform` operations in the two files are all plumbing and need no mapping step.

The rebuilt report differs from today's in five points. They are accepted as fixes:

| Point | Today | Rebuilt |
|---|---|---|
| Truncation notice | Never printed | Printed for a document above the length limit |
| Row numbers | Start at 0 | Start at 1 |
| Search judge | Sees only the expansions from round 2 on | Sees the full query list every round |
| Retries | Not applied inside loops | Applied inside loops |
| No uploaded file | The run fails | The report shows "0 of 0" |

The rebuilt workflows ship next to the old ones, so both can be run on the same documents. The
product owner signs off the rebuilt report. Implementation starts without a fixed document set;
owner and team verify together when it is done.

### Legacy workflows

- **Old node types stay runnable.** The 26 node types and the engine path that runs them stay in
  the first release as a frozen legacy path. Existing workflows, defaults and customer-built
  ones, can be opened and run.
- **Old node types cannot be added.** The editor offers only the new steps for new work. Models
  never write legacy nodes.
- **Two sets, not mixed.** A workflow is legacy or new by its schema version. The new steps run
  on the new engine (#3788) and the run service (#3772).
- **Rebuilt defaults ship next to the old ones.** Each existing workflow is challenged first: is
  it needed, can it be simpler. The two `claude-style-agent` defaults become one agent with a
  plan.
- **No new guarantees for legacy runs.** They do not get the run service, resume by the
  executor, the "never run a write again" rule or the trust rules. The UI labels them as legacy.
- **Removal comes in a later release**, together with the "not runnable" marking, the admin
  banner and the handling of stored runs. In the first release #3784 is an inventory, a "legacy,
  will be removed" notice and a version gate for marketplace workflows.
- **Fallback.** The implementing team confirms in the first pull request that freezing the engine
  is possible. If it is not, old workflows are left in place and marked "not runnable", an admin
  banner says so, stored runs stay readable and each default gets a migrated version.

## Workflow engine change

The engine cannot change a running workflow today, and a run does not own its definition. #3788
changes both. The new engine is built beside the frozen legacy engine; a workflow's schema
version decides which one runs it.

| Part | What it does |
|---|---|
| Definition per run | Every run stores a copy of its workflow definition and reads only that copy, also after a restart. An admin edit applies to new runs only. |
| Amend | One operation changes that copy while the run is active: add, update or close a step. Started steps and locked workflows cannot be changed. Everything is validated before anything is stored. |
| Revisions | Every change is a revision record that names the model call that caused it. The evidence record links to it. The plan and its history can be read per run. |
| Ready set | The engine works out the steps that can run from the definition and the step states; it stores no frontier. |
| Durable step start | A step that writes is marked as running and flushed before it starts, so it is never run twice. |

**The engine drives the steps in both modes.** The agent's controlling run is the job and owns
the transcript. An Agent step runs as a segment of that run, or as a sub-agent when it needs a
fresh context. The only call in the other direction is a plan tool that amends the plan. In a
fixed procedure the plan tools answer that the plan is locked.

**Nested plans.** An Agent step inside a plan may delegate and may plan again. Steps it adds
hang under it in the same definition; a sub-agent with a fresh context gets its own run,
definition and revisions, linked to the parent step. One depth limit counts both forms.

**Loops written by the model.** A For each in a plan may contain a write Action and an Ask a
person. Approval for a write inside such a loop is given once for the whole loop and shows what
the loop will act on. An item that was not shown is not covered. Finished items are stored per
item, so a restart does not redo them.

**Check rounds** are rounds of the Check step, not changes to the plan, so they also work in a
fixed procedure.

Limits for steps, revisions, depth and loop size are configured under `platform.workflows.plan`
with ceilings in code. Beyond a limit the plan tools return an error the model can read, and the
agent must ask.

## What the others do

From their source and docs, read on 2026-11-17 by a research pass; not re-verified line by line.

| Mechanism | Where | What iHub takes | What changes for a multi-user server |
|---|---|---|---|
| Nightly memory consolidation in phases; promotion by repeated retrieval, not model judgement; model returns decisions, host writes sourced text; preimage kept | OpenClaw `extensions/memory-core` | The whole shape of the background pass | Per agent and user; approval for provided agents |
| Notes written freely, curated memory changed only in the background | OpenClaw, Hermes | Two layers | Rows with owner and revisions, not files |
| Review after N turns or tool steps by a background copy; patch a skill before creating one | Hermes `agent/background_review.py` | Trigger and "patch first" | Staged by default |
| Per-job scratch plus last result fed into the next run; "no change" is silent | OpenClaw automations | End-of-run log and end states | Rights re-checked at fire time |
| Non-blocking spawn, completion pushed to the parent; children cannot write memory or message out | OpenClaw `sessions_spawn`, Hermes `delegate_task` | Sub-agent rules | Quotas per user |
| Steering as the default queue mode | OpenClaw | Message during work | Only the chat owner may steer |
| Stable prompt order and a frozen memory snapshot per session, for caching | Hermes `agent/prompt_builder.py` | Shared content first, user content after | — |
| A 190-line loop with one tool reaches over 74% on SWE-bench Verified | mini-swe-agent | Keep the loop simple; planning and checking are steps, not engine | — |
| Done criteria agreed up front; evaluator bounded to a few rounds | Anthropic harness posts, Claude Code | Finishing rules | — |

## Build order

The work ships in seven release slices. Each slice is usable on its own. F depends only on B and
runs in parallel with C–E.

| Slice | What the user gets | Issues |
|---|---|---|
| A | Steer a running answer; long answers no longer cut off; parallel read-only tool calls | #3191, #2712, #2485 |
| B | Answers survive a restart; one run service and one run executor | #3772, #3777, #3781, #3786 |
| C | Blocking sub-agents; a place for running and waiting work | #3196, #3780, #3782 |
| D | Background sub-agents and follow-ups in the same chat, with in-app notifications | #3196, #3197, #3785 |
| E | Personal agents in free mode; scheduled tasks converted | #3773, #3783, #3787 |
| F | New workflow steps and the rebuilt law consultation, next to the legacy workflows | #3774, #3784, #3788 |
| G | Fixed procedure first, then agents with a plan | #3775, #3788 |

Nine further issues under the epic carry work that spans the units:

| Issue | Content |
|---|---|
| #3780 | Permissions and feature flags |
| #3781 | Run limits, quotas and usage metering |
| #3782 | Running work: tray, admin Runs page, pause and drain |
| #3783 | Scheduled tasks |
| #3784 | Upgrade path for workflows |
| #3785 | Trust rules |
| #3786 | Test foundations |
| #3787 | Retention |
| #3788 | Workflow engine change |

The event queue of #3197 is built before background sub-agents and before #3773. The old
workflow nodes are not moved onto the run service; #3774 builds the new steps on it directly.

Not in this epic: browser push (#3198) is deferred. Non-destructive summarisation (#3192), the
memory epic (#3365) and the later phases of #3687 follow after it.

## Open points

1. **Legacy path.** Whether the old engine can be frozen beside the new one is confirmed in the
   first pull request of #3788. The fallback is described under "Legacy workflows".
2. **Chat store for plans.** What exactly the chat holds for a plan and its history (steps,
   revisions, sub-agent links) is specified with #3788 and #3775.
3. **Depth limit.** Nested plans need a depth limit. #3788 proposes 2; the value is not decided.
4. **Agent memory.** Memory keyed by agent and user needs a decision record in #3365.
5. **Compaction checkpoint.** #3192 stores it as a run-ledger event, and #3687 deletes the
   journal after the answer is stored. The checkpoint has to live in the chat.
6. **Step contract, other workflows.** Two cases from the rebuilt defaults are not covered yet:
   how coverage adds up when Find documents runs inside a For each, and a "results so far"
   reference inside a running For each. Customer workflows may also use `transform` for real
   computed values; the inventory of #3784 shows whether they do.

## Sources

- OpenClaw: `github.com/openclaw/openclaw` — `docs/concepts/dreaming.md`,
  `extensions/memory-core/src/`, `docs/tools/subagents.md`, `docs/concepts/queue.md`,
  `docs/automation/cron-jobs/how-it-works.md`
- Hermes Agent: `github.com/NousResearch/hermes-agent` — `agent/background_review.py`,
  `agent/prompt_builder.py`, `tools/memory_tool.py`, `cron/scheduler.py`,
  `website/docs/user-guide/features/delegation.md`
- mini-swe-agent: `github.com/SWE-agent/mini-swe-agent` — `src/minisweagent/agents/default.py`,
  `docs/faq.md`
- Anthropic: `anthropic.com/engineering/managed-agents`,
  `anthropic.com/engineering/harness-design-long-running-apps`
- deepagents: `github.com/langchain-ai/deepagents` — `libs/deepagents/deepagents/middleware/`
- Earlier iHub analyses: `concepts/2026-08-26 Agent Harness Comparison — DeepSeek Harness, Hermes,
  Deep Agents vs iHub.md`, `concepts/2026-08-26 One Agentic Loop — Unified Runtime for Chats,
  Workflows and Agents.md`
