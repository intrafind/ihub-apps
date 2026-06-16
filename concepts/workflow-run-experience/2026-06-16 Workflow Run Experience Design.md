# Workflow Run Experience — Design Concept

**Date:** 2026-06-16
**Status:** Draft / proposal
**Author:** Design exploration (iHub)
**Related:** `concepts/2026-02-27 iHub Workflows PRD.md`, `concepts/agentic-workflows/`,
`concepts/agent-factory/`, `concepts/admin-workflow-management/`

---

## 1. Motivation

iHub already has a capable workflow engine (`server/services/workflow/`): ~23 node
types, a DAG scheduler with loops and sub-workflows, human-in-the-loop checkpoints,
per-node retries/timeouts, disk checkpointing, an execution registry, and cron/webhook
triggers. It also has a React-Flow visual editor and an admin executions dashboard.

**The problem:** every surface we expose is *technical*. Authors see a node graph;
admins see an execution transcript / node-by-node timeline. There is no surface built
for a **non-technical end user** who needs to *run* a workflow and *act on its output* —
review AI findings, accept or reject them, supply missing input, and assemble a result.

### What SPARK gets right

The SPARK Workflow product (German public-sector planning/permitting tool) runs on a
Temporal engine that is **completely invisible** to the user. Its frontend repo even
keeps the generic node-graph under `dev-tools/node-graph`, while the real product
surface is a set of **per-phase review screens**. Observed UX patterns:

1. **Stage-based navigation, not a canvas.** A numbered stepper (phases 1→2→3→4) is the
   primary IA. Each phase is a dedicated screen for the artifacts that phase produced.
2. **AI output as a reviewable worklist with explicit per-item status.** Findings render
   as cards with status chips (`Open / Reviewed / Requested / Irrelevant / In decision`).
   This operationalizes the principle "every AI output must be accepted, edited, or
   discarded."
3. **Progress as a first-class visual.** Donut counters everywhere
   ("3 of 4 findings reviewed", "2 of 39 topics complete").
4. **Evidence/provenance inline.** Side-by-side document comparison for contradictions;
   extracted-text + original-file + decomposed-arguments panes; assessment cards with a
   **verdict badge**, cited justification with inline reference markers, and a citations
   list with **per-citation 👍/👎 feedback**.
5. **Structured cards over freeform text**, each with actions (status dropdown,
   accept/reject, "request missing document").
6. **Document assembly via outline + per-section approval** (an outline tree with an
   "approve" toggle per section, plus a contextual reference panel).

None of this requires a different engine. It is a **presentation layer** over primitives
we already have.

### Goal

Add a declarative **Workflow Run Experience** so a workflow author can describe *how a
run should be reviewed*, and iHub renders a consumer-grade UI — without touching the
engine and while staying true to iHub's config-driven design.

### Non-goals

- Replacing the React-Flow authoring editor (it stays — it is the *authoring* tool).
- Domain-specific logic (legal-norm DBs, document extraction). Those are separate.
- Changing the execution engine's scheduling/durability model (tracked separately).

---

## 2. What we can reuse (engine-side primitives already exist)

| SPARK UX pattern | Existing iHub primitive | File |
| --- | --- | --- |
| Hidden engine, run lifecycle | `WorkflowEngine` start/pause/resume/cancel | `server/services/workflow/WorkflowEngine.js` |
| Per-item human review | `human` node → checkpoint → `respond` API | `server/services/workflow/executors/HumanNodeExecutor.js` |
| Live updates | SSE events via `actionTracker` (`workflow.*`, `agent.*`) | `server/actionTracker.js` |
| Progress counters | `_currentStep`, `_totalNodes`, `_nodeIterations` in state | `WorkflowEngine.executeNode()` |
| Citations | agent citation ledger | `server/agents/runtime/*`, `AgentRunDetailPage.jsx` |
| Artifacts | artifact store + viewer | `server/agents/runtime/artifactStore.js` |
| Per-result feedback | existing feedback mechanism | `server/routes/.../feedback` |
| Triggers / phases source | `workflowConfigSchema` (`nodes`, `triggers`, `status`) | `server/validators/workflowConfigSchema.js` |

The gap is the **consumer rendering layer** + a small amount of schema to drive it.

---

## 3. Design

### 3.1 Core idea: `reviewView` hints on the workflow definition

Stay declarative. A workflow author tags nodes (and groups them into stages) with hints
that the run experience uses to pick the right component. The engine ignores these
fields entirely — they are presentation metadata.

#### Stage grouping (new, optional field on each node `config`)

```jsonc
{
  "id": "formal-check",
  "type": "human",
  "config": {
    "stage": {
      "id": "completeness",
      "label": { "en": "Formal completeness", "de": "Formale Vollständigkeit" },
      "order": 2
    },
    "reviewView": "worklist"
  }
}
```

Nodes sharing a `stage.id` collapse into one stepper step. Nodes without a `stage`
default to a single "Run" stage (backward compatible — existing workflows still render,
just as one stage).

#### `reviewView` values (v1)

| value | renders | typical node |
| --- | --- | --- |
| `worklist` | list of review items, each with status + accept/edit/discard | `human` |
| `comparison` | two-pane source-vs-source (or claim-vs-source) | `human` / `verifier` |
| `assessment` | verdict badge + cited justification + citations w/ feedback | `human` / `prompt` |
| `outline` | document outline tree with per-section approve toggle | `human` over an artifact |
| `cards` | grid of topic/category cards with per-card progress + status | `human` / `transform` |
| `document` | rendered artifact (md/json/text) — the current default viewer | `end` / artifact nodes |
| `progress` | read-only progress/log (current transcript behaviour) | any |

`reviewView` only changes *rendering*. The accept/reject/edit actions all funnel through
the **existing checkpoint `respond` API** (see 3.3).

### 3.2 The Review Item model (item-level HITL)

Today `HumanNodeExecutor` emits a single checkpoint with `options` (e.g. approve/reject)
and optional `inputSchema` + `showData`. SPARK's worklist needs **many items, each
independently triageable**. We generalize the checkpoint payload with an optional
`items` array — fully backward compatible (no `items` ⇒ today's single-decision
behaviour).

```jsonc
// checkpoint payload (extends current HumanNodeExecutor checkpoint)
{
  "id": "ckpt-…",
  "nodeId": "formal-check",
  "type": "human_input",
  "reviewView": "worklist",
  "message": { "…": "…" },
  "progress": { "reviewed": 3, "total": 4 },     // drives the donut
  "items": [
    {
      "id": "finding-001",
      "title": "Missing: species protection map",
      "summary": "Referenced in the table of contents but not found in the documents.",
      "status": "open",                          // open | accepted | edited | discarded | requested
      "severity": "medium",                       // low | medium | high  (optional)
      "category": "completeness",                 // optional, drives grouping/cards
      "evidence": [                               // drives comparison/assessment panes
        { "kind": "citation", "ref": "U00_TOC.pdf", "locator": "p.3", "excerpt": "…" },
        { "kind": "source", "sourceId": "doc-123", "excerpt": "…" }
      ],
      "actions": ["accept", "discard", "request"],// allowed per-item actions
      "editable": true
    }
  ],
  "options": [ /* still supported for whole-checkpoint decisions */ ]
}
```

Producing `items` is the responsibility of the node *before* the human node (a `prompt`
or `verifier` node writes a structured array into state via its `outputVariable`), and
the human node surfaces it via `showData`/a new `itemsFrom: "$.findings"` config. So:

```
[prompt/verifier produces findings array] → [human node renders them as a worklist]
```

This keeps the engine generic: the human node does not know about "legal findings" —
it knows about *review items*.

### 3.3 Responding (reuse the existing API)

The current resume API stays the contract:

- `POST /api/workflows/executions/:executionId/respond` (and the agent equivalent).

We extend the request body to carry per-item decisions:

```jsonc
{
  "checkpointId": "ckpt-…",
  "response": "submit",            // overall checkpoint action (unchanged)
  "data": {
    "itemDecisions": [             // new, optional
      { "id": "finding-001", "status": "requested", "note": "Ask applicant for the map" },
      { "id": "finding-002", "status": "discarded" }
    ]
  }
}
```

`HumanNodeExecutor.resume()` already validates `response` and `inputSchema` and writes
`humanResponse_<nodeId>` into state. We add: write `itemDecisions` into state so
downstream nodes (and the next stage) can read the human-curated result. No engine
change required — this is executor + route-validation work.

### 3.4 Stepper / navigation

The run view derives a **stepper** from the distinct `stage` groups in the workflow
definition, ordered by `stage.order`. Each step shows:

- a status (pending / active / paused-awaiting-you / complete / failed), driven by which
  nodes in that stage have completed in `state.completedNodes`;
- a progress donut when the active checkpoint carries `progress`.

When the engine pauses at a `human` node, the stepper jumps to that node's stage and
renders the configured `reviewView`. This is the entire "interactive" loop:
**run → pause at stage → user triages items → respond → engine continues → next stage**.

### 3.5 Evidence & citations

- `comparison` view: render two `evidence` entries side-by-side (claim vs. source, or
  doc-A vs. doc-B), highlighting `excerpt`. Click-to-open the source via existing
  source/file viewers.
- `assessment` view: verdict badge from `item.status`/a `verdict` field, justification
  body with inline reference markers, and a citations list reusing the existing
  **citation ledger** component from `AgentRunDetailPage`, with per-citation 👍/👎 wired
  to the existing feedback endpoint.

---

## 4. Component breakdown (client)

New feature module: `client/src/features/workflows/run/`

```
run/
├── WorkflowRunView.jsx          # top-level: subscribes to SSE, owns stepper + active stage
├── RunStepper.jsx               # stage stepper with status + progress donuts
├── stages/
│   ├── WorklistView.jsx         # list of ReviewItemCard + bulk submit
│   ├── ComparisonView.jsx       # two-pane source comparison
│   ├── AssessmentView.jsx       # verdict + justification + citations(feedback)
│   ├── OutlineView.jsx          # outline tree + per-section approve toggle
│   ├── CardsView.jsx            # topic/category grid with per-card progress
│   └── DocumentView.jsx         # wraps existing artifact viewer (default)
├── components/
│   ├── ReviewItemCard.jsx       # title, summary, status chip, actions, evidence toggle
│   ├── EvidencePane.jsx         # excerpt + click-to-source
│   ├── StatusChip.jsx           # open/accepted/edited/discarded/requested/severity
│   └── ProgressDonut.jsx
└── hooks/
    └── useReviewItems.js        # local decision state, optimistic, posts to respond API
```

Reuse where possible:
- live updates: existing `useWorkflowExecution` hook + SSE handlers;
- citation ledger + artifact viewer: lift shared pieces out of `AgentRunDetailPage.jsx`
  into `shared/` so both run-view and agent-run-detail use them;
- routing: add a user route `/workflows/:executionId/run` (remember to update
  `knownRoutes` in `client/src/utils/runtimeBasePath.js`).

The existing `WorkflowExecutionPage.jsx` (technical transcript) stays available as a
"details / debug" tab toggle inside the run view, so power users keep the node-level
view.

---

## 5. Server changes (small, additive, backward compatible)

1. **Schema** (`server/validators/workflowConfigSchema.js`): add optional `config.stage`
   and `config.reviewView` to the node schema; add optional `itemsFrom` to human-node
   config. All optional ⇒ no migration needed for existing workflows.
2. **`HumanNodeExecutor`**: when `config.itemsFrom` (or `showData` pointing at an array)
   resolves to an array, attach it to the checkpoint as `items`; compute `progress`.
3. **`HumanNodeExecutor.resume()`**: persist `data.itemDecisions` into state as
   `itemDecisions_<nodeId>` alongside the existing `humanResponse_<nodeId>`.
4. **Respond route**: extend request validation to accept `data.itemDecisions`.

No changes to `WorkflowEngine`, `StateManager`, `DAGScheduler`, or the executor registry.

---

## 6. Example: a "Document completeness review" workflow

```
start
  → prompt:classify        (LLM assigns each uploaded doc a type + topic → state.docs)
  → verifier:completeness  (compares docs vs. required list → state.findings[])
  → human:review-findings  (stage=completeness, reviewView=worklist, itemsFrom=$.findings)
  → transform:apply        (drops discarded, flags "requested" items)
  → end                    (reviewView=document → assembled summary artifact)
```

The end user sees: a 2-step stepper → opens at "Formal completeness" → a worklist of
findings with progress "0 of N reviewed" → accepts/discards/requests each, with source
excerpts inline → submits → run completes → final summary document. They never see
`classify`, `verifier`, `transform`, or any edge.

---

## 7. Phased plan

- **Phase 1 — Stepper + worklist (MVP).** `stage`/`reviewView` schema, `items` on the
  human checkpoint, `WorkflowRunView` + `RunStepper` + `WorklistView` + `ReviewItemCard`,
  item-level respond. Delivers the core "run + triage" loop.
- **Phase 2 — Evidence.** `EvidencePane`, `ComparisonView`, `AssessmentView`, lift the
  citation ledger into `shared/`, wire per-citation feedback.
- **Phase 3 — Assembly.** `OutlineView` with per-section approve over an artifact;
  `CardsView` for topic/category breakdowns.
- **Phase 4 — Polish.** Stage progress persistence, deep-linking to a stage, mobile
  layout, a11y pass (SPARK ships an accessibility statement — we should match WCAG).

---

## 8. Open questions

1. **Where do `items` originate canonically** — always via an upstream node's
   `outputVariable`, or do we allow a node type to emit them directly? (Proposed: upstream
   `outputVariable`, to keep the human node domain-agnostic.)
2. **Edit semantics** — when a user edits an item, do we store the edited copy and let a
   downstream node consume it, or re-run a node with the edit? (Proposed: store edit in
   `itemDecisions`; re-run is a later enhancement.)
3. **Stage status for parallel branches** — how to show progress when a stage spans
   parallel nodes. (Defer to Phase 4.)
4. Should the run experience be selectable per-workflow (`config.experience: "run" |
   "technical"`) so authors opt in? (Proposed: yes, default `technical` for existing
   workflows, `run` when any node declares a `stage`.)

---

## 9. Summary

The engine is not the gap — the **shell around it** is. SPARK demonstrates that a good
workflow product is a stage stepper wrapping per-stage review screens, with explicit
human acceptance per item and inline provenance. iHub can deliver this as a purely
additive, config-driven presentation layer (`stage` + `reviewView` hints, an `items`
extension to the existing human checkpoint, and a new `features/workflows/run/` module)
without modifying the execution engine.
</content>
