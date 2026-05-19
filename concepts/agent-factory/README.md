# Agent Factory

**Status:** V1 spec — approved, awaiting implementation
**Date:** 2026-05-19
**Branch:** `claude/agent-factory-ihub-160t3`

## Why we are doing this

iHub today is a control plane for AI **chat apps** — stateless config that users open and converse with. We want iHub to also be the control plane for an organization's **AI workforce**: autonomous agents that wake up on their own, do multi-step work using iHub's apps/tools/sources/models, ask a human only when they need approval, and leave durable artifacts behind.

> **"What an iHub App is to a chat session, an iHub Agent is to a job that runs by itself."**

The V1 lighthouse: a scheduled **TODO worker** agent that wakes every N minutes, reads an iHub-stored TODO list, picks the next item, works it using its tools and the iHub Apps it's allowed to call (decomposing into dynamic sub-tasks if needed), writes a Markdown artifact, marks the TODO done, and reflects on what it learned into a per-Profile memory file.

## Key architectural decisions

- **An Agent Profile owns a workflow.** Profile = (workflow definition + agent-specific metadata: memory file, inbox, service-account identity, artifacts, HITL config). The workflow is the agent's playbook; the agent improvises within via tools, apps, and dynamic tasks.
- **Workflow engine (v2) is the runtime.** No separate worker daemon, no file-based queue, no custom scheduler. Triggers, checkpoints, executors, and the editor UI all reuse what PR #1139 and PR #1480 built.
- **Dynamic Task Extension is the V1 differentiator.** Agents can `createTask(...)` at runtime; a new `drain` mode on `LoopNodeExecutor` processes the queue. Bounded by per-Profile `maxDepth` and the existing 200-iteration loop cap.
- **End-of-run consolidation node** is mandatory and structural. A separate (typically cheaper) LLM pass at the end of every agent run reviews the trajectory and writes structured updates to the memory file. This is what makes agents *improve* across runs rather than just *run*.
- **Tripartite memory file** with mandated `## Semantic` / `## Episodic` / `## Procedural` sections. Per-entry `{source: agent|human}` markers — consolidation can only edit `source: agent`; human entries are immutable to the agent.
- **Version snapshots of the memory file** (default 10 retained) give us cheap LangGraph-time-travel-style rollback.
- **In-process, single-replica** for V1 — matches workflow v2's deployment model. No deployment-shape change.

## Documents

- **[V1 Requirements and Architecture](./2026-05-19%20V1%20Requirements%20and%20Architecture.md)** — the full spec. Start here.

## Reference frameworks researched

- **Workflow v2 (PR #1139)** and **review pass (PR #1480)** — the runtime foundation we build on.
- **LangGraph + LangMem** — thread state vs cross-thread Store; reflection as a graph node; semantic/episodic/procedural memory tripartition.
- **Hermes Agent (Nous Research)** — daemon + heartbeat; `_spawn_background_review` post-run reflection; Curator guardrail (agent-authored skills mutable, human-authored immutable).
- **OpenClaw / ClaudeClaw** — disk-as-truth principle ("if it's not on disk it doesn't exist"); workspace files (MEMORY.md, daily episodic notes, skills/).
- **Lessons from AutoGPT / BabyAGI** — what unbounded autonomy without consolidation and budgets actually breaks.

## V1 → V2 → V3 trajectory

- **V1** (this spec): Profile + tripartite memory + consolidation + inbox + dynamic tasks + App-as-tool + HITL finished + service-account identity + artifact store + agent admin UI.
- **V2**: Skills as first-class entities; within-run reflection/verifier loops; consolidation dry-run + approval queue; heartbeat trigger; chat-invoked agents via `chatBridge.js`.
- **V3**: Weekly Curator pass; cross-agent shared memory namespaces; sandboxed code-exec; eval harness.

## Build order

10 tickets (T1 → T10, plus T4.5 for the consolidation node) — ~16–22 days focused work. T1 (Foundation + schema + Profile CRUD) is genuinely independent and is the suggested starting point.
