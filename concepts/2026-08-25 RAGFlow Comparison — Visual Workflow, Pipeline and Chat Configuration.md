# RAGFlow vs. iHub Apps — Visual Configuration of Pipelines, Agents and Chats

**Date:** 2026-08-25
**Status:** Analysis / recommendation
**Sources analyzed:**

- RAGFlow `infiniflow/ragflow` @ `b380728` (nightly, docs describe v0.27.0, released 2026-08-19), including the in-repo documentation under `docs/` (the source of https://ragflow.io/docs)
- iHub Apps current `main` (workflow editor, workflow engine, agents, apps, sources)

RAGFlow positions itself as "the leading open-source RAG engine" — an ETL ingestion pipeline,
hybrid search, and a visual agent-orchestration canvas with MCP support. This document compares
its **visual configuration capabilities** (agent canvas, ingestion pipelines, chat assistants)
against iHub, and derives concrete recommendations — with a focus on making iHub workflow nodes
usable by non-technical authors, especially **iteration over results** ("search → analyze each
result → report").

---

## 1. Executive summary

1. **RAGFlow's node model is form-driven; iHub's is expression-driven.** In RAGFlow every node is
   a right-side form built from variable *pickers*, sliders, toggles and morphing value widgets —
   the only place a user types code is the dedicated Code node. In iHub, authoring beyond trivial
   cases requires knowing three expression dialects (`$.data.x`, `${...}`, `{{var}}`), writing raw
   JS conditions, and editing JSON textareas.
2. **RAGFlow's Iteration/Loop are visual containers** — a resizable box on the canvas; body nodes
   live *inside* it (React Flow `parentId` + `extent: 'parent'`), with an inner "start" chip
   exposing exactly two variables (`item`, `index`). iHub's Loop node is engine-only: the body is
   an inline JSON array (`config.body`) that the visual editor can neither display nor edit, and
   the LoopForm doesn't even expose it.
3. **Surprising finding:** despite the container UX, **none of RAGFlow's 19 shipped agent
   templates uses Iteration or Loop**, and their docs for these components are structurally broken
   (Iteration is nested under the Switch heading; the Loop section describes Iteration). Their
   flagship "deep research" template fans out via LLM-planned sub-agents instead. Loops are a
   *discoverability* failure for them — which means iHub can leapfrog rather than chase.
4. **iHub's engine is already ahead of its own editor.** for/forEach/while/drain loop modes with
   hard caps, cron + webhook triggers, resume/checkpoints, HITL, per-iteration SSE events, and a
   run view that already groups iterations — none of it reachable from the canvas. 9 of 24 node
   types have no palette entry or form; shipped workflows hand-build loops from 3 plumbing nodes +
   a decision + back-edges because the real Loop node can't be authored visually.
5. **On RAG, the products are architecturally different.** RAGFlow owns the full ingestion path
   (parse → chunk → extract → index, visually editable, with RAPTOR/GraphRAG/re-ranking and ~38
   data-source connectors). iHub deliberately delegates retrieval to iFinder and stuffs/loads
   sources at prompt time. The recommendation there is *not* to rebuild RAGFlow's ETL, but to
   adopt its **configuration UX** (test runs, retrieval playground, pipeline-as-canvas for iFinder
   ingestion if that becomes strategic).
6. **Top recommendation:** ship a visual **Iteration container** on the existing engine (the drain
   mode already resolves body nodes by id — the pattern exists), a **typed variable picker + prompt
   editor with variable chips**, and **friendly node creation** (`+` on handles, categorized
   searchable menu with icons/descriptions). Those three changes convert the user story
   "search → iterate → analyze → report" from a 13-node JSON-only cursor idiom into 6 nodes,
   zero expressions.

---

## 2. What RAGFlow offers visually

### 2.1 Product surfaces

RAGFlow splits into five first-class surfaces, each with its own visual configuration:

| Surface | What it is | Visual configuration |
|---|---|---|
| **Dataset** (knowledge base) | Ingest → parse → chunk → index → test | Forms + optional visual pipeline; retrieval-testing playground |
| **Agent** | The no-code canvas (3 kinds: workflow, ingestion pipeline, compilation operator) | Full React Flow canvas with container loops, sub-agents, debug |
| **Chat** | Multi-turn RAG assistant over datasets | 440px slide-in settings panel (no graph) |
| **Search** | Single-turn branded search app | Slide-in settings panel |
| **Memory** | First-class semantic/episodic/procedural store | Form-based; written by Message node, read by Retrieval node |

Plus **chat channels** (bind a Chat to Discord/Telegram/WhatsApp/DingTalk/Feishu/WeCom/QQ — notably
*no* Slack/MS Teams) and **data sources** (~38 connectors: Confluence, Notion, SharePoint, S3,
Jira, Salesforce, Gmail, REST, RSS… with interval-based sync into datasets).

### 2.2 The agent canvas — node UX

The palette groups ~30 operators into five categories (Foundation: Agent, Retrieval; Dialogue:
Message, Await Response; Flow: Switch, Iteration, Loop, Exit Loop, Categorize; Data: Code,
Text Processing, Data/List Operations, Variable Assigner/Aggregator; Tools: Tavily, Google,
ArXiv, SQL, HTTP, Email, Browser, DocGenerator…). The important part is *how* nodes are created
and configured:

- **Node creation happens on the connection gesture, not a sidebar.** Every source handle is a
  `+` button opening a categorized, searchable "next step" menu; dragging a wire into empty canvas
  and releasing opens the same menu. A skeleton placeholder node + highlighted edge previews where
  the node will land (`web/src/pages/agent/canvas/node/handle.tsx`, `hooks/use-connection-drag.ts`).
- **Context-sensitive palette:** "Exit Loop" only appears when adding *inside* a Loop; in pipeline
  mode Parser/Tokenizer disappear once one exists.
- **Every operator has an icon, a human name, and a prose description** shown as tooltip in the
  menu and repeated in the config panel header.
- **Configuration is a non-modal side sheet**, so canvas + form + chat + log can be visible at
  once. Forms are react-hook-form + zod with:
  - **Variable pickers** fed from *upstream nodes' declared output schemas* (BFS over edges),
    grouped per node with the node's icon and the value type on each row.
  - **Type filtering:** Iteration's "items" field only offers array-typed variables; numeric
    conditions only offer numbers. Type errors become impossible, not validated-after-the-fact.
  - **A Lexical-based prompt editor**: typing `/` inserts a variable rendered as an
    `[icon] Node / output` chip; the serialized value stays `{node_id@variable}`.
  - **Morphing value widgets:** boolean → Yes/No pills, number → number input, string → textarea,
    object/array → Monaco JSON editor, "Variable" mode → picker. Switching type resets the value
    to a type-appropriate default.
  - **Sliders for bounded numbers** (similarity thresholds, max loop count 1–100), and an
    "Advanced settings" collapse hiding tuning knobs by default.
  - **Per-node error handling as form fields:** max retries, delay after error, exception method
    (fallback value or goto-branch).
- **Node cards preview their configuration inline** (selected datasets with avatars, message text
  with variable chips, model chip, conditions) with a "first 3 + expand" overflow, and **broken
  references render visually** (deleted dataset → red border + warning triangle).
- **Sub-agent delegation is a first-class visual axis:** an Agent node has a *bottom* handle
  (`agentBottom → agentTop`) for attaching sub-agents, and a `tool` handle for tools/MCP — i.e.
  the canvas expresses both horizontal control flow and vertical delegation. Collapsible subtrees
  tame large graphs.
- Sticky **notes** are first-class canvas nodes; their flagship template ships with 5 of them.

### 2.3 Iteration & Loop — the container model

This is the feature the user story centers on. Mechanics (verified in code):

- **Iteration** = "for each element of an array".
  - The node renders as a **transparent bordered resizable box**; the title bar sits above the box
    (absolutely positioned at `top:-38px`), so the interior is pure body area.
  - Creating an Iteration auto-creates an **inner "start" chip** (`IterationItem`) inside the box,
    which exposes exactly two read-only outputs: `item: unknown` and `index: integer`. That chip
    *is* the mental model of the loop.
  - Children carry `parentId` + `extent: 'parent'` (React Flow), so dragging is clamped to the
    box; the box **auto-grows** when a child would overflow; edges crossing the container boundary
    are hard-blocked in `isValidConnection`; deleting the container cascade-deletes the body;
    duplicating it re-parents cloned children.
  - Form: **three fields.** "Items" = variable picker restricted to arrays; "Output" = a list of
    named collected results, each bound to a body node's output via picker, with the type
    **auto-derived** as `Array<childType>`; a read-only output preview. No syntax anywhere.
  - Execution: strictly sequential; the parent node aggregates one list per declared output
    (append per round). Inside the body, `{item}`/`{index}` shorthand aliases resolve to the
    iteration chip.
- **Loop** = "repeat until a condition is met".
  - Same container visual. Form: **loop variables** (name/type/initial value rows with morphing
    widgets), a **termination condition builder** (variable picker + type-appropriate operator
    dropdown + value; AND/OR combinator; the value input disappears for `empty/not empty`), and a
    **max loop count slider (1–100)**.
  - **Exit Loop** node = visual `break` — zero configuration, only offered inside a Loop.
- **Weaknesses worth knowing (and not copying):**
  - Two asymmetric primitives: Iteration aggregates outputs but has no break and no max cap; Loop
    has break + cap but **no output aggregation at all** (state must be hand-carried via Variable
    Assigner on `env.*` globals). Neither runs items in parallel (global concurrency is a fixed
    pool of 5).
  - The **loop back-edge is invisible** — it's inferred at runtime from "last body node has no
    downstream", never drawn. Debugging "why did it only run once" is hard.
  - **The docs for both components are broken** (Iteration nested under Switch; the Loop section
    describes Iteration) and **zero of the 19 shipped templates uses either primitive** — their
    flagship deep-research template fans out via sub-agent tool calls instead. The capability
    exists; the on-ramp doesn't.

### 2.4 Run, debug and lifecycle

- **Run from the canvas**: save → open run sheet. If Begin declares inputs, a typed form is
  generated at runtime from the declared input types (line/paragraph/options/file/number/boolean →
  matching widget + zod schema).
- **Live canvas feedback**: spinner on the currently-executing node; executed edges highlight.
- **Log sheet**: a vertical timeline (same operator icons as the canvas) with per-node status dot,
  elapsed seconds, and expandable **Input/Output** JSON viewers; nested tool-call traces for agent
  nodes; every component also emits a one-line human `thoughts()` narration on start ("Need to
  process 12 items.").
- **Single-node debug**: a Play button on each node fetches that node's input contract from the
  server, renders the same generated form, runs just that node, and (for Code nodes) shows
  expected-vs-actual output types with red borders on mismatch.
- **Pipeline test-run**: upload one sample file, watch step-by-step results, then open a result
  page showing the **document preview with chunk highlighting** next to the step timeline;
  re-run button included.
- **Lifecycle**: debounced **autosave (20s)** with an "Autosaved <time>" indicator; undo/redo
  (50 snapshots, Cmd/Ctrl+Z); explicit Save + separate **Publish** (release) action; **version
  history dialog rendering each version as a read-only live canvas preview** (view/download only —
  no rollback button); JSON import/export; embed-into-web-page dialog; **template gallery** with
  category sidebar and localized (en/de/zh) title/description cards.
- **Webhook trigger**: configured on the Begin node (methods, request schema, auth
  none/token/basic/jwt, IP allowlist, rate limit, response template); the run button then opens a
  sheet with the **copyable webhook URL** and live request traces. Notably: **no cron/scheduled
  agents at all** — webhook, conversational, task only.

### 2.5 Ingestion pipeline & dataset configuration

- The ingestion pipeline editor **is the same canvas** with a swapped palette (`canvas_category =
  dataflow_canvas`): `File → Parser → Token/Title Chunker → Extractor (summary/keywords/questions/
  metadata) → Tokenizer (indexer)`, plus `Compiler` for Knowledge Compilation. Handles become
  single-use so pipelines stay linear; a starter graph (File → Parser) is pre-seeded.
- Parser form: per-file-family setup (PDF: DeepDoc/MinerU/Naive; image: OCR/VLM; email: field
  selection; spreadsheet → HTML…). Chunkers: token-based (size 512, overlap %, delimiters) or
  title-based (hierarchical). Indexer: full-text / embedding / **hybrid**, retrieval strategy,
  filename-weight slider.
- Datasets can alternatively use 10 **built-in chunk methods** (General, Q&A, Table, Paper, Laws,
  …) without a pipeline; advanced toggles for **RAPTOR**, **knowledge graph** (GraphRAG/LightRAG),
  **auto-keyword/question/metadata**, **table-of-contents extraction**.
- **Retrieval testing** playground per dataset (threshold, vector weight, rerank, metadata
  filters) with the explicit caveat that test settings don't propagate to chats/agents.
- **Knowledge Compilation** (v0.27 flagship): declarative entity/relation/claim schemas compile
  documents into artifacts — Wiki, knowledge graph, tree, mind map, timeline, page index — plus
  "To Skills" conversion. Configured via forms, no code.

### 2.6 Chat assistant configuration

A 440px slide-in panel next to the live chat (not a modal): basics (avatar/name/description, model
+ sampling, opener, datasets), then one "Advanced settings" collapse (empty response, quote,
keyword, TTS, multi-turn optimization switches; web search; metadata filters; similarity/top-N/
rerank sliders; cross-language). Deep Research is a single toggle + Tavily key. Weak spots: the
system prompt is a bare textarea (no variable chips — the canvas got the good editor, chat didn't),
and **custom chat variables can only be supplied via the HTTP/Python API** — a documented dead end
for no-code users.

---

## 3. Where iHub stands today

### 3.1 What exists and is good

- **Engine (server) is genuinely strong** — arguably ahead of RAGFlow's runtime in several places:
  - `loop` node with **four modes**: `for`, `forEach`, `while`, `drain` (task-queue with dynamic
    task creation), hard cap 500, per-iteration SSE events (`agent.loop.iteration.*`)
    (`server/services/workflow/executors/LoopNodeExecutor.js`).
  - `parallel`/`join` nodes, checkpoints/resume, cancellation with reasons, restart-from-last-step.
  - **Cron schedule + webhook triggers** in the engine (`services/workflow/triggers/`) — RAGFlow
    has no cron at all.
  - 24 node types incl. domain nodes RAGFlow lacks (`query-plan`, `corpus-search`,
    `structured-record`, `quote-validator`, `template-render`, `verifier`, `planner`).
  - Sub-workflows (`SubWorkflowMaterializer`), per-node model overrides (`nodeModels` in agents).
- **Run view UX** is genuinely non-technical:
  - `TechnicalDetailsToggle` — a persisted "show technical details" switch, default off.
  - `HumanCheckpoint` renders checkpoint data as prose/forms, explicitly "NOT JSON" (markdown,
    Yes/No chips, humanized keys).
  - `ExecutionProgress` already **groups repeated node runs into an "N iterations" card** with
    expandable per-iteration rows — the exact mental model a container loop needs, already built.
- **Apps (chat) configuration is ahead of RAGFlow's chat UX**: a 21-section form editor with a
  synced Form ⇄ JSON `DualModeEditor`, live schema validation, an **8-step creation wizard with
  AI generation from a description**, app **templates + inheritance** (`parentId`,
  `overriddenFields`). RAGFlow has nothing comparable for chats.
- **Sources admin** has connection testing, iFinder query preview, dependency tracking (which apps
  use a source), usage stats.

### 3.2 The gaps (all verified in code)

**The workflow editor is a skeleton compared to both our own engine and RAGFlow's canvas:**

- **Loop bodies cannot be authored or even seen.** `config.body` is an inline JSON array of full
  node definitions inside the loop node (`LoopNodeExecutor.js:135`); `LoopForm.jsx` exposes
  mode/count/array/condition/output — **but not the body**. The editor's `workflowToFlow` /
  `flowToWorkflow` have no notion of `body`, `parentId`, or containment at all.
- Consequence: **none of the 12 shipped workflows uses the loop node.** The canonical
  "per-document analysis" (`corpus-analysis-direct.json`) hand-builds iteration from a cursor
  idiom: `init-cursor` (transform) → `pick-doc` (transform, `arrayGet`) → body →
  `advance-doc` (transform, `increment`) → `more-docs` (decision, `$.data._docIndex <
  $.data._docsTotal`) with two conditional back-edges — **3 plumbing nodes + 1 decision + 2 edge
  conditions + 6 underscore convention variables per loop**, and several of those configs are
  authorable only in raw JSON.
- **9 of 24 node types have no palette entry and no form** (`query-plan`, `corpus-search`,
  `structured-record`, `quote-validator`, `template-render`, `progress`, `inbox-load`,
  `inbox-finalize`, `memory-finalize`) — exactly the nodes the shipped workflows are made of.
- **No edge/branch editing:** `onConnect` hardcodes `{type:'always'}`; decision nodes have a
  single source handle, so true/false branches are visually indistinguishable and conditions are
  JSON-only.
- **Three expression dialects** (`$.data.x` conditions, `${...}` interpolation, `{{var}}`
  templates) plus raw JS in `code`/`while` — none discoverable in the UI, and several form
  placeholders suggest syntax the evaluator rejects (e.g. `state.score > 0.8`, `${items}`).
  Expression errors silently evaluate to `false`.
- **No variable system in the UI:** nothing lists which variables exist at a given node; no
  autocomplete; a typo'd `{{searchResults}}` fails at runtime only.
- **No run/test from the canvas** — no run button, no per-node test, no live node status, no
  validation panel. (All the SSE events needed for a live overlay already exist.)
- **No lifecycle UX:** no autosave, no undo/redo, no copy/paste, no version history UI (the
  server already exposes `GET /workflows/:id/versions` and `POST /workflows/:id/activate/:version`
  with **zero client callers**), no templates gallery, no AI generation (apps have both).
- Papercuts: the admin list's "Visual editor" action links to `/admin/workflows/:id/editor` while
  the route is `/edit` (dead link); new-workflow IDs are collected via `window.prompt()`;
  `flowToWorkflow` silently drops node descriptions, execution settings (timeout/retries),
  non-English names and edge handles; palette entries are raw type identifiers with colored dots
  (no icons/descriptions/i18n).
- **Agents' generated workflows are invisible** — the profile editor never shows the 6–12 node
  graph the serializer produces, and migration V052 proves hand-edits to embedded definitions
  aren't upgrade-safe.
- **Triggers have no UI** (schedule/webhook are JSON-only), despite full engine support.

### 3.3 RAG architecture difference

iHub has **no embedding, no vector store, no chunking** — by design. Sources (filesystem, URL,
iFinder, page) are either stuffed whole into the system prompt (`exposeAs: 'prompt'`) or exposed
as callable tools (`exposeAs: 'tool'`); real retrieval/ranking is delegated to **iFinder**; file
uploads are client-side-extracted and prepended verbatim. RAGFlow owns the entire ETL+retrieval
stack in-product. This is a strategy difference, not a bug — but it means "compare the pipeline
editors" is really "decide whether iFinder ingestion/retrieval configuration should get a visual
surface inside iHub" (see R9).

---

## 4. Head-to-head summary

| Capability | RAGFlow (v0.27) | iHub today |
|---|---|---|
| Canvas tech | React Flow, containers via `parentId`/`extent` | React Flow, flat graph only |
| Node creation | `+` on handles / drag-wire → categorized searchable menu w/ icons+descriptions, placeholder preview | Sidebar list of raw type names, click to drop at center |
| Loop authoring | Visual Iteration/Loop containers, body inside the box, `item`/`index` chip, ExitLoop | Engine-only `config.body` JSON; invisible in editor; shipped flows use manual cursor+back-edge idiom |
| Loop semantics | Iteration: sequential, aggregates outputs, no cap/break; Loop: condition builder + cap + break, **no aggregation**; no per-item parallelism | for/forEach/while/drain, cap 500, `outputVariable` aggregation, per-iteration SSE; no per-item parallelism (yet); parallel/join exist for static branches |
| Variables | Typed output schemas per node; pickers filtered by type; `/`-chips in prompt editor; `env.*` globals UI | Three string dialects, no picker, no validation, silent failures |
| Branching | Switch/Categorize with per-case handles, condition builder w/ typed operators | Decision node, single handle, conditions JSON-only |
| Debug | Whole-flow run w/ generated input form, live node spinner, timeline log (I/O per node), single-node debug, webhook test sheet | Rich run page (timeline, iteration grouping, HITL) but **nothing** on the canvas |
| Lifecycle | Autosave+undo, publish/release, version dialog w/ canvas preview (no rollback), import/export, embed, template gallery (localized) | Save/Publish buttons only; version API exists w/o UI; no templates/AI-gen (apps have both) |
| Triggers | Conversational / task / webhook (rich config + test); **no cron** | Cron + webhook **in engine**, no UI |
| Ingestion/RAG | Visual pipeline (same canvas), 10 built-in chunk methods, RAPTOR/GraphRAG/auto-metadata, retrieval testing, ~38 source connectors, memory store | Delegated to iFinder; 4 source types; prompt-stuffing or tool exposure; strong source admin (tests, dependencies) |
| Chat config | Slide-in panel; friendly but system prompt is a bare textarea; custom variables API-only | 21-section form editor + wizard + AI generation + inheritance — **stronger** |
| Multi-agent | Sub-agents as visual first-class axis + MCP + structured output | Agent profiles generate hidden workflows; apps/tools/skills pickers; no visual delegation |

---

## 5. Recommendations for iHub

Ordered by impact on the stated goal: *a non-technical person designs a workflow by adding a few
nodes and iterating over any node's results.*

### R1 — Iteration as a visual container (the headline feature)

Build one container node type ("Repeat / For each") that combines the best of RAGFlow's two
primitives and avoids their asymmetry:

- **Editor:** container = group node; children get `parentId` + `extent: 'parent'`; an inner
  "Each item" chip exposes `item`/`index` (read-only); the container auto-grows; edges may not
  cross the boundary; deleting/duplicating the container takes its body along. Support both
  add-from-inside (`+` on the chip/handles) *and* drop-into-the-box adoption (RAGFlow designed the
  hit-test helper but never wired it — we can go one better).
- **Form (three plain fields + advanced):**
  - *"What to repeat over"* — variable picker, arrays only (forEach), with "repeat N times" and
    "repeat until…" as alternate modes behind a segmented control; the "until" mode uses a
    condition *builder* (typed operators), not a JS string.
  - *"Collect results into"* — a name; aggregation = existing `outputVariable` (list per
    iteration). Default it; don't make it optional-and-hidden like RAGFlow's Loop.
  - *Advanced:* max iterations **slider** (respecting the engine's 500 cap), "stop early when…"
    (ExitLoop equivalent as a condition on the container, not a magic body node), error policy
    (stop / skip item / collect errors).
- **Engine mapping — small delta, big payoff:** keep `LoopNodeExecutor` as-is and let the workflow
  schema mark body membership. Two options:
  1. *(preferred)* Add optional `parentId` to node schema; `LoopNodeExecutor` resolves its body
     from `context.workflow.nodes.filter(n => n.parentId === node.id)` in edge order — **the
     `drain` mode already resolves `config.child` by id lookup, so the precedent exists**
     (`LoopNodeExecutor.js:295-303`). Bodies become first-class nodes: visible, positioned,
     individually configurable, and the run view's existing iteration grouping just works.
  2. *(fallback, zero engine change)* Editor compiles container children into `config.body` on
     save and explodes them on load. Works, but layout/metadata round-tripping is fragile.
- **Differentiator:** add `concurrency` (1 = sequential, N = parallel batch) on the container.
  Neither RAGFlow primitive can parallelize per item (their global pool is a fixed 5); iHub's
  executor already isolates per-iteration state, so a bounded `Promise` pool in
  `executeBodyNodes` is a contained change. "Analyze 40 documents, 5 at a time" is a demo RAGFlow
  cannot match today.
- **Ship it with templates** (see R6): RAGFlow's biggest loop failure is that no template and no
  working doc shows one. Our first template should be exactly the user story: *Search → For each
  result: Analyze → Report* — which also finally exercises the engine's loop node in a shipped
  artifact.

**Before/after for the user story** (today: `corpus-analysis-direct.json`, 13 nodes, 6 JSON-only
configs; after: 6 nodes, no expressions):

```
start → search (corpus-search)
      → [ repeat for each {search results}:  analyze (prompt) ]   ← container
      → report (prompt) → end
```

### R2 — A typed variable system in the UI

The single biggest "code-like" factor is that variables are invisible strings.

- Declare an **output schema per node type** (name + type + description; `prompt` nodes emit
  `outputVariable: string`, `corpus-search` emits `_corpus: Array<Document>`, etc.). Much of this
  is already implicit in executors — make it explicit metadata next to the executor registry.
- Build a **VariablePicker** (extend the existing `ResourcePicker` pattern): options gathered by
  walking upstream edges (plus loop-item scope inside containers), grouped per node with icon and
  type badge; **filtered by the field's expected type** (arrays for iteration items, booleans for
  switches…).
- Add a **prompt editor with variable chips**: insert via `/` or a `{}` toolbar button; serialize
  to the existing `{{var}}` syntax so the engine is untouched; unresolved references degrade to
  plain text and render as a warning chip.
- **Hide the three dialects.** Forms generate `$.data.x` / `${…}` / `{{…}}` under the hood; an
  "advanced expression" escape hatch remains for experts. Fix the wrong placeholders and surface
  expression evaluation errors in the run view instead of silently taking the false branch.

### R3 — Friendly node creation and node cards

- `+` button on node handles and drop-a-wire-on-empty-canvas → **categorized, searchable node
  menu** with icon, localized name, one-line description (context-sensitive: loop-only nodes only
  inside containers). Keep the sidebar palette as a secondary path.
- Drop-node-on-edge to insert between two nodes; placeholder skeleton preview before the pick.
- Node cards render a **content preview** (model chip, tool name, first line of the prompt,
  selected sources with icons, condition summary) and **red-border warnings for broken
  references** (deleted model/tool/source) — the data for that already exists in configCache.
- Give all 24 node types palette entries + forms (R7), with palette naming that says what the node
  *does* ("Search knowledge", "Ask a person", "Write report section") rather than the executor name.

### R4 — Branch/edge editing

- Decision/switch nodes get **one labeled source handle per branch** (True/False; one per case +
  "otherwise"), so branches are visible and conditions attach to handles, not naked edges.
- Clicking an edge opens a small **condition builder**: variable picker + operator dropdown
  (operator set derived from the variable's type; value input hidden for `empty/not empty`) —
  RAGFlow's pattern, backed by iHub's existing `equals/expression` edge conditions.

### R5 — Run and debug on the canvas

Everything needed already streams over SSE (~30 event types) — it's only rendered on the separate
execution page today.

- **Run button** on the editor (reuse `StartWorkflowModal`, which already generates typed forms
  from `start.inputVariables`).
- **Live overlay:** spinner on the running node, highlight executed edges, error badge on failures
  (consume `workflow.node.start/complete/error` + `agent.loop.iteration.*`).
- **Log side-sheet:** adapt `ExecutionProgress` (it already does iteration grouping and the
  technical-details toggle) into a non-modal sheet next to the canvas.
- **Single-node test run:** an endpoint that executes one node with user-supplied/sampled state
  (executors are already independently invocable), plus a form generated from the node's input
  schema. RAGFlow's expected-vs-actual type diagnostic for Code nodes is worth copying verbatim.
- **Validation panel:** client-side Zod + reference checks (unknown variables, unreachable nodes,
  missing `end`, edges into containers) with click-to-focus — instead of a red toast after save.

### R6 — Lifecycle: autosave, versions, templates, AI generation

- **Autosave** (debounced ~20s) + "Autosaved <time>" indicator; **undo/redo** snapshots;
  copy/paste including containers.
- **Version history UI** on the existing endpoints — list, read-only canvas preview per version
  (RAGFlow's nicest lifecycle touch), diff of node/edge counts, and **restore** via the existing
  `activate/:version` endpoint. That last button leapfrogs RAGFlow (view/download only).
- **Workflow template gallery**: ship the 12 default workflows as localized template cards with
  category chips + "Use template" (apps already have templates + wizard — reuse those surfaces).
  Add a small graph thumbnail; RAGFlow's gallery is text-only.
- **AI-generate workflow from a description**: apps already have AI generation in the wizard;
  extending it to emit a workflow draft (nodes + edges + a container where iteration is implied)
  would be a genuine differentiator — RAGFlow has nothing like it.
- Fix the papercuts now (cheap): dead "Visual editor" link (`/editor` → `/edit`),
  `window.prompt()` → proper dialog, lossy `flowToWorkflow` round-trip.

### R7 — Close the form gap

Forms for the 9 missing node types (the ones shipped workflows actually use); missing fields on
existing forms (`decision.conditions` builder, `human.showData/inputSchema`, `verifier.mode`,
`start` variable labels, `end.outputMapping`, `chatVisible` as a "Show in chat" toggle,
`thinking`); sliders for bounded numbers; "Advanced" collapses; morphing value widgets; hide
irrelevant fields instead of disabling them; per-node error handling (retries/delay/fallback)
as form fields — the schema already carries `execution` settings that the editor currently drops.

### R8 — Trigger UI (engine is already there)

A "Triggers" panel on the workflow: schedule (cron builder + timezone + next-run preview) and
webhook (generated URL with copy button, secret management, method allowlist, and a test sheet
showing the last received payloads). RAGFlow cannot schedule agents at all — surfacing what the
engine already supports turns a hidden feature into a visible advantage.

### R9 — RAG/ingestion: adopt the UX, not the stack (strategic, separate decision)

Rebuilding RAGFlow's embedding/vector stack contradicts iHub's iFinder delegation strategy. What
*is* worth adopting:

- A **retrieval playground** per source/app ("run this query, see what the model would receive"),
  extending the existing iFinder query preview — mirrors RAGFlow's retrieval testing.
- If iFinder ingestion configuration becomes an iHub concern, reuse the same canvas with a swapped
  palette (RAGFlow proves one canvas can serve both) rather than building a second editor.
- Be aware of the connector-breadth story in competitive situations: ~38 sync connectors vs.
  iHub's 4 source types; counter with iFinder's enterprise search depth and iHub's
  source-dependency/testing tooling.

### R10 — What *not* to copy from RAGFlow

- The invisible runtime back-edge (loop repetition inferred from "no downstream") — always render
  the repetition affordance on the container.
- Two asymmetric loop primitives — ship **one** container with items + condition + cap + break +
  aggregation.
- Their module-level shared start-node object (duplicate-id bug when creating two containers),
  docs drifting from code (their Variable Assigner docs list 3 of 11 operators), Message's
  "randomly pick one of several texts", and Categorize's substring-count routing.

### Suggested phasing

| Phase | Content | Effect |
|---|---|---|
| 1 | R1 container (option 1 schema change), loop/parallel forms, R3 friendly palette + node cards, R4 branch handles, papercut fixes | The user story becomes demoable: 6 nodes, no JSON |
| 2 | R2 variable picker + prompt chips + output schemas, R7 forms for all node types, validation panel | "No expressions unless you want them" |
| 3 | R5 canvas run/debug, R6 autosave/undo/versions/templates | Author-test-iterate loop entirely visual |
| 4 | Parallel iteration (`concurrency`), R8 trigger UI, AI workflow generation, R9 retrieval playground | Differentiators RAGFlow doesn't have |

---

## 6. Appendix — reference snippets

**RAGFlow Iteration DSL (from `agent/test/dsl_examples/iteration.json`)** — body nodes are flat
components with `parent_id`; the graph carries them as React Flow children:

```json
"iteration:0":     { "obj": { "component_name": "Iteration",
                       "params": { "items_ref": "generate:0@structured_content" } } },
"iterationitem:0": { "obj": { "component_name": "IterationItem" }, "parent_id": "iteration:0" },
"tavily:0":        { "obj": { "component_name": "TavilySearch",
                       "params": { "query": "iterationitem:0@result" } }, "parent_id": "iteration:0" },
"generate:1":      { "obj": { "component_name": "Agent", "params": { "sys_prompt":
                       "…{tavily:0@formalized_content}…" } }, "parent_id": "iteration:0" }
```

**iHub today — the manual cursor idiom** (from `server/defaults/workflows/corpus-analysis-direct.json`):

```jsonc
// init-cursor (transform)
{ "operations": [ { "lengthOf": "_corpus", "to": "_docsTotal" },
                  { "set": "_docIndex", "value": 0 } ] }
// pick-doc (transform)
{ "operations": [ { "arrayGet": "_corpus", "index": "_docIndex", "to": "_currentDoc" } ] }
// advance-doc (transform)
{ "operations": [ { "increment": "_docIndex", "by": 1 } ] }
// more-docs (decision) + two conditional edges back to pick-doc / on to validate
{ "type": "expression", "expression": "$.data._docIndex < $.data._docsTotal" }
```

**Proposed iHub workflow JSON after R1 (option 1)** — same engine, bodies as first-class nodes:

```jsonc
{ "id": "analyze-results", "type": "loop",
  "config": { "mode": "forEach", "array": "searchResults",
              "outputVariable": "analyses", "maxIterations": 100 } },
{ "id": "analyze-one", "type": "prompt", "parentId": "analyze-results",
  "config": { "system": { "en": "Analyze this document: {{_loopItem.title}} …" },
              "outputVariable": "analysis" } }
```

**Key file references**

- iHub: `client/src/features/workflows/editor/` (editor), `server/services/workflow/executors/LoopNodeExecutor.js` (loop modes, `config.body`, drain's node-id lookup), `server/validators/workflowConfigSchema.js`, `client/src/features/workflows/components/ExecutionProgress.jsx` (iteration grouping), `server/routes/workflow/` (unused version endpoints).
- RAGFlow: `web/src/pages/agent/` (canvas, forms, run/log/debug sheets), `agent/component/{iteration,iterationitem,loop,loopitem,exit_loop}.py`, `agent/canvas.py:830-843` (the loop router), `docs/guides/agent/agent_workflow/flow_components.md` (the broken loop docs), `agent/templates/` (19 templates, zero loop usage).
