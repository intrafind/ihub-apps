# Agents, Sub-Agents and Workflow Steps — Target Model

Status: proposal · 2026-11-17 · builds on #3196, #3197, #3365, #3687, #1495 · task breakdown
follows separately

## Why

iHub has a solid loop, a run ledger, approvals, integrations and scheduled tasks. It does not yet
have an agent in the sense users now expect: something lasting that you give a goal, that works on
its own, that you can talk to, that knows what it did, and that gets better. This document says
what is really there today, what an agent should be, how sub-agents and background work fit in,
and which workflow steps replace today's node types.

Nothing here has to stay compatible with the current agent profiles, node types or default
workflows. Only the law consultation workflow (Stellungnahmen review) is migrated.

Out of scope for now: sandboxed code execution (#2663) and evals. Later: admin hooks and approval
rules (#3195, #2411), cost per run (#2401), MCP 2026-07-28 and A2A 1.0 migration.

## Decisions

1. **An agent is a lasting entity, not a run.** It has one timeline. A run is one moment it is
   awake.
2. **One agent definition, three modes**: free, planned, fixed. They differ only in who decides
   the steps.
3. **An agent's plan is a workflow.** Planned agents build and amend it; fixed agents follow one
   the admin locked. Both give the same step-by-step record.
4. **Sub-agents are a property of every run**, with or without an app, blocking or in the
   background. A background sub-agent wakes its parent when it is done.
5. **One run service and one run executor** carry chat, tasks, workflow steps, agents and
   sub-agents.
6. **A summary never replaces the original.** Full results stay as artifacts; summaries point to
   them.
7. **The chat is where things persist; the ledger is only for running.** An agent's timeline is
   a chat, and the chat store is extended for agents and workflows. The existing evidence record
   is the audit record, extended to agent, workflow and sub-agent runs; no second format.
8. **Self-improvement is gated.** Personal agents apply memory changes with a diary and undo;
   admin agents need approval. Changes to instructions and skills are always versioned.
9. **Planner, verifier, synthesizer, inbox and memory nodes leave the engine.** Workflows get a
   small set of steps named for what they do.
10. **Clean cut.** The Agent Factory (profiles, inbox, admin pages) is replaced, not migrated;
    nobody uses it today. The default and marketplace workflows are rebuilt on the new steps.

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

**"Agents" are research pipelines.** An agent profile is compiled into a workflow
(`server/agents/profile/profileWorkflowSerializer.js`): start → planner (one call, JSON plan) →
one task node per plan item → synthesize → end. The model does not steer the run, cannot be talked
to, and starts manually only (`routes/agents/runs.js:211`). The schedule field in the editor is
saved in a shape the trigger source does not read, so it never fires (#3742).

**The closest thing to an agent is a chat app with tools**; a scheduled task is that same turn
without a user, with an owner, a schedule, notes and run history.

**Sub-agents exist only as `app__<id>`** (`services/chat/appToolsGateway.js`): a blocking call to
another app, 3 minutes wall clock, one level, approvals denied, no questions. Nothing runs in the
background and nothing wakes the caller.

**Evidence** (`docs/chat-evidence.md`) already records, per answer, every model call with its
messages, tools, settings and output, and every tool call with arguments and result. It covers
chat answers and runs without a chat. Workflow and agent evidence is a later phase of #3687.

**The Claude-style agent** (`server/defaults/workflows/claude-style-agent.json`) plans with
`set_plan`, works, then an adversarial verifier sends it back. Read, not run, the reasons it does
not finish are:

1. The reviewer is told to "try to break it" against open-ended criteria, so it always finds gaps.
2. A retry restarts the work step with the old draft pasted in. The agent has lost what it
   learned and rewrites the whole draft, which opens new gaps.
3. The loop ends only on a stall (2 rounds without fewer gaps) or 6 retries, as a failure.

Built but not wired: steering has an API and no UI (#3191); parallel read-only tool calls are
hard-coded off in chat (#2485); tool search sits behind a preview flag (#2889).

## Target model

### What an agent is

| Part | Meaning |
|---|---|
| Profile | Name, description, owner, who may use it |
| Goal | What it is for; standing, not per run |
| Instructions | How it works |
| Model, tools, skills | What it works with |
| Memory | What it has learned (see below) |
| Triggers | Schedule, webhook, event, a message |
| Mode | Free, planned or fixed |
| Identity | Whose rights it runs with |
| Version | Every change to the above is a version |

**One timeline.** Everything lands in one conversation per agent and user: the user's messages,
scheduled work, sub-agent reports, incoming triggers. Scheduled runs no longer open a new chat
each time.

**Everything that wakes it is an event.** A message, a schedule tick, a webhook and a returning
sub-agent are handled the same way: the event arrives, the agent wakes, reads it and acts. One run
per agent is active at a time. A message that arrives while it works reaches it at the next step
through the existing steering queue (`services/loop/steering.js`).

**State is assembled per wake, not carried.** Each run starts from: profile, goal and
instructions; curated memory; open items (todo list or plan); a digest of recent activity; the new
event. Anything older is fetched with tools that search the agent's own past runs, artifacts and
conversation.

**Each run ends by writing down what it did**: result, what is open, and an end state of `done`,
`blocked`, `needs attention` or `no change`. `no change` suppresses the notification. Scheduled
tasks already do a simpler version (`services/scheduler/tasks/memoryComposer.js`).

### Three modes

| Mode | Who decides the steps | What can be inspected |
|---|---|---|
| Free | The agent, turn by turn, with a non-binding todo list | Evidence record |
| Planned | The agent writes a plan as a workflow, follows and amends it | Evidence record, step graph, plan revisions |
| Fixed | The admin authors and locks the workflow | Evidence record, step graph, identical every run |

Free mode is the scheduled task grown up. Plan approval before start is a per-agent setting for
planned mode, off by default for personal agents.

### Ownership and identity

| Agent | Started by | Runs as |
|---|---|---|
| Personal | Owner or owner's trigger | The owner, with the owner's connections |
| Admin agent a user starts | The user | That user |
| Admin agent on a trigger | Schedule, webhook, event | Its own identity (default) or the creating admin (option) |

An admin agent is a template: the admin marks which parts a user may set (goal, inputs, schedule,
connections), the rest is locked, and each user's settings are stored per user. When an agent runs
with a person's rights, the record names both the agent and the person.

### Sub-agents

A `delegate` tool on every run:

- **Brief, optional app, wait or background.** With an app the child uses that app's
  instructions, model and tools. Without one it gets a worker prompt, the parent's model and a
  subset of the parent's tools.
- **Fresh context, own budget** taken from the parent's, never more rights than the parent.
- **Approvals and questions surface in the parent's timeline** instead of being denied.
- **It reports through an artifact**: findings, evidence, open questions, what it did not do. The
  tool result is a summary plus the artifact reference. The parent can ask the same child a
  follow-up.
- **Read-only tools by default, one writer.** Sub-agents never write in parallel.
- **Depth 1, capped concurrency per user.** Children cannot write memory or send messages out.

**Background.** The tool returns a handle at once. When the child ends, its report is delivered to
the timeline and a turn of the parent starts by itself. The parent has tools to list, check,
message and cancel its children; the UI shows them as running.

### Memory and improvement

Two layers, as OpenClaw and Hermes both do:

- **Notes**: cheap, dated, written freely by the agent during work.
- **Curated memory**: small, loaded on every wake, changed only by a background pass.

**The background pass ("dreaming")** runs when the agent is idle. It reads only the owner's own
turns and the agent's notes, never tool output, web content or other users' turns. The model
decides add, merge or supersede; the server writes the text from the source with a reference back.
The previous version is kept, and a rewrite that loses a large share of entries is rejected.

| What changes | Personal agent | Admin agent |
|---|---|---|
| Curated memory | Applied, shown in a diary, undo | Proposed, approved by an admin |
| Skills, instructions, goal | Proposed, approved by the owner | Proposed, approved by an admin |

Every accepted change is a new agent version, and each run records the version it ran with.
Memory is keyed by agent and user; a shared layer exists only for reviewed content. This follows
the memory epic's decisions (#3365, phase 4 in #3378).

### Summaries and artifacts

Run files are artifacts in the single artifact repository (#3556). Tool results that are too
large, sub-agent reports and step outputs are stored in full and are readable by the agent.
Compaction (#3192) and digests are views: each summary carries references to what it summarises,
and the original is never deleted by summarising.

### Evidence

**Persistence lives in the chat, not in the ledger.** The run ledger exists so a run can be
followed, reattached and recovered while it is active; its journal goes once the result is stored
(#3687). What lasts is the chat: messages, activity, artifacts and the evidence record per answer.
The agent timeline is a chat, and a workflow or agent run stores its steps, results and evidence
there. History search reads chats and evidence, never the journal.

No new format. The existing record is extended (#3687 later phases) by:

1. Records for workflow, agent and sub-agent runs.
2. Links from a parent record to each child's record.
3. The plan at each revision: which steps existed, which were added, by which call.
4. The agent version: profile, memory and skills in force.

Reasoning is stored as far as the provider returns it, labelled as what the model stated.

### Finishing

- The plan states what "done" means; a check grades against exactly those criteria.
- A revision continues the same run and edits the result; it does not start over.
- After two check rounds the agent delivers with the open points listed.
- Every run ends in a named end state (above).

## Workflow steps

Today: 26 node types (`server/services/workflow/executors/index.js`). Target:

| Step | Does | Replaces |
|---|---|---|
| Start | Inputs or a trigger | `start`, `inbox-load` |
| Agent step | Instructions, tools, skills; runs the loop; may delegate | `prompt`, `planner`, synthesizer |
| Find documents | Search a project, iFinder or the web, with optional refinement rounds | `query-plan`, `corpus-search`, `project-items`, `project-read` |
| Extract | Structured data from a document by schema, quotes checked against the source | `prompt` with schema, `structured-record`, `quote-validator` |
| For each | Repeat steps per item, optionally in parallel | `loop`, `parallel`, `join` |
| Check | Grade a result against criteria: pass, revise, or accept with open points | `verifier` |
| Ask a person | Approval or input | `human` |
| Branch | Condition | `decision` |
| Action | Call an action of a connected system | `tool`, `http` |
| Write result | Report from a template, artifact, project item, delivery | `template-render`, `project-write`, `end`, `inbox-finalize` |

Counters, progress messages and error collection become options of a step. Memory becomes a
property of the agent. `transform`, `progress`, `memory`, `memory-finalize` disappear as node
types.

### Law consultation workflow

| Variant | Today | Target |
|---|---|---|
| Upload (`stellungnahmen-review-v2`) | 7 nodes | Start → For each document: Extract → Write result |
| iFinder (`stellungnahmen-review-ifinder-v2`) | 13 nodes | Start → Find documents → For each document: Extract → Write result |

The two v1 files are deleted.

### The other workflows

The remaining default workflows and the six in the marketplace are rebuilt on the new steps. Where
a default exists as an old version and a `-v2`, only the `-v2` is rebuilt. The two
`claude-style-agent` defaults become one planned-mode agent.

## What the others do

From their source and docs, read on 2026-11-17 by a research pass; not re-verified line by line.

| Mechanism | Where | What iHub takes | What changes for a multi-user server |
|---|---|---|---|
| Nightly memory consolidation in phases; promotion by repeated retrieval, not model judgement; model returns decisions, host writes sourced text; preimage kept | OpenClaw `extensions/memory-core` | The whole shape of the background pass | Per agent and user; approval for admin agents |
| Notes written freely, curated memory changed only in the background | OpenClaw, Hermes | Two layers | Rows with owner and revisions, not files |
| Review after N turns or tool steps by a background copy; patch a skill before creating one | Hermes `agent/background_review.py` | Trigger and "patch first" | Staged by default |
| Per-job scratch plus last result fed into the next run; "no change" is silent | OpenClaw automations | End-of-run log and end states | Rights re-checked at fire time |
| Non-blocking spawn, completion pushed to the parent; children cannot write memory or message out | OpenClaw `sessions_spawn`, Hermes `delegate_task` | Sub-agent rules | Quotas per user |
| Steering as the default queue mode | OpenClaw | Message during work | Another person's input queues under that person |
| Stable prompt order and a frozen memory snapshot per session, for caching | Hermes `agent/prompt_builder.py` | Shared content first, user content after | — |
| A 190-line loop with one tool reaches over 74% on SWE-bench Verified | mini-swe-agent | Keep the loop simple; planning and checking are steps, not engine | — |
| Done criteria agreed up front; evaluator bounded to a few rounds | Anthropic harness posts, Claude Code | Finishing rules | — |

## Build order

1. **Wire what exists**: steering UI (#3191), parallel read-only calls in chat (#2485), todo tool
   in chat.
2. **Run service**: one way to run the loop for a principal, instructions, tools and limits; one
   tool runner; `invokeAppInternal` removed.
3. **Run executor**: runs are jobs with a record, a lease, limits and pickup after restart
   (scoped-down #1495; fixes #2712).
4. **Sub-agents**, reporting through artifacts (#3196).
5. **Background sub-agents and wake-up** (#3197, #3198).
6. **Agent definition, timeline and state**: one definition, event inbox, per-wake assembly,
   end-of-run log, history search. Free mode ships here; personal agents grow out of scheduled
   tasks.
7. **Non-destructive summarisation** (#3192).
8. **Workflow steps** and the law consultation migration.
9. **Plan as workflow**: planned and fixed modes, check step, finishing rules.
10. **Evidence** for agent, workflow and sub-agent runs (#3687 later phases).
11. **Memory layers, background pass, gated improvement, versions** (#3365).

Steps 1–6 give a working free agent. Steps 8–9 give planned and fixed agents without reworking it.

## Open points

1. **Chat store for agents and workflows.** What exactly the chat has to hold for a workflow or
   agent run (steps, plan revisions, sub-agent links) is to be specified with step 6 and step 10.
2. **Multi-pod.** The run executor's leases must fit the plan in
   `concepts/2026-11-16 Scaling Beyond One Pod Without a Database.md`.
3. **Shared timelines.** Whether several users may share one agent conversation, and whose input
   may steer it, is undecided. Default here: one timeline per agent and user.

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
