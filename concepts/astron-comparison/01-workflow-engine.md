# Workflow Engine — astron-agent vs ihub-apps

Research date: 2026-05-13. Sources:
- astron-agent: `https://github.com/iflytek/astron-agent/tree/main/core/workflow` (Python, FastAPI-style)
- ihub-apps: `/home/user/ihub-apps/server/services/workflow/` (Node.js/ES modules)

---

## 1. astron-agent: what it offers

### 1.1 Project layout

`core/workflow/` is a full Python micro-service with the following modules
([tree](https://github.com/iflytek/astron-agent/tree/main/core/workflow)):

- `alembic/` — DB migrations
- `api/v1/` — FastAPI router; namespaces `/workflow/v1`, `/sparkflow/v1`, `/v1`; sub-routers
  `layout`, `auth`, `node_debug`, `file`, `sse_debug_chat`, `sse_openapi`
- `engine/` — execution engine (`dsl_engine.py`, `node.py`, `callbacks/`, `entities/`, `nodes/`)
- `repository/` — DAO layer (`flow_dao.py`, `license_dao.py`) — DB-backed persistence
- `service/` — business orchestration
- `cache/`, `configs/`, `consts/`, `domain/`, `exception/`, `extensions/`, `infra/`, `utils/`

### 1.2 Execution model

- **Async DFS over a DAG** orchestrated by `WorkflowEngine.async_run()` in
  `engine/dsl_engine.py`. `_depth_first_search_execution()` walks the graph;
  `_wait_predecessor_nodes()` enforces dependencies; `_get_next_nodes()` selects
  successors after each completion.
- **Per-node strategy** via `NodeExecutionStrategyManager`:
  `DefaultNodeExecutionStrategy` for async parallel-capable nodes,
  `QuestionAnswerNodeStrategy` for serial-only nodes (locking).
- **Compiled nodes**: `SparkFlowEngineNode.async_call()` wraps each DSL node;
  nodes are cached in `built_nodes`.
- **Branching**: outgoing edges include `sourceHandle` (e.g. fail-branch). Error
  strategies can route to a dedicated `FailBranch` instead of failing the whole
  flow.

### 1.3 Node types (28 total, from `engine/entities/node_entities.py` enum)

| Category | Node types |
|---|---|
| Core | START, END, FLOW, MESSAGE, AGENT |
| Processing | LLM, CODE, PLUGIN, DATABASE, RPA, MCP |
| Knowledge | KNOWLEDGE_BASE, KNOWLEDGE_EXPERT, KNOWLEDGE_PRO |
| Control flow | IF_ELSE, DECISION_MAKING, ITERATION (start/end), LOOP (start/end/exit) |
| Data | PARAMETER_EXTRACTOR, TEXT_JOINER, VARIABLE_AGGREGATION |
| Advanced | QUESTION_ANSWER, MEMORY_ADD, MEMORY_SEARCH |

Notable nodes:
- **LLM** (`engine/nodes/llm/spark_llm_node.py`) — multimodal inputs (image/audio/video),
  format-specific parsers (text/markdown/json), reasoning content, tool calling,
  token/price tracking.
- **Code** (`engine/nodes/code/code_node.py`) — Python only; `main()` function;
  pluggable `CodeExecutorFactory` (`CODE_EXEC_TYPE` env: local, sandbox, remote);
  typed I/O validated against schema.
- **Iteration** (`engine/nodes/iteration/iteration_node.py`) — executes a
  **subgraph** per batch item; sequential or **parallel** (`isParallel`,
  `maxConcurrency`, `asyncio.Semaphore`); error strategies `fail_fast`,
  `continue`, `ignore_error_output`; each parallel batch gets an isolated
  child engine + deep-copied `VariablePool`.
- **Loop** (`engine/nodes/loop/loop_node.py`) — stateful loop with `loopVariables`,
  multi-condition termination (`and`/`or`, operators `eq`, `gt`, `contains`,
  `regex_contains`, …), `maxLoopCount` (default 10, bounded 1-100).
- **Knowledge / Knowledge Pro / Expert** — RAG nodes with adaptive prompting
  (`adaptive_search_prompt.py`) and a knowledge client.
- **MCP** — Model Context Protocol integration node.
- **RPA** — robotic process automation.
- **Plugin/Tool** — external plug-in integration with versioning (`tool_id`, `version`).
- **Question/Answer** — serial-locked user-Q node.
- **Variable Aggregation / Text Joiner / Params Extractor** — pure data nodes.
- **Memory Add/Search** — persistent memory ops.

### 1.4 State and persistence

- `WorkflowEngineCtx` holds `variable_pool`, `node_run_status`,
  `msg_or_end_node_deps`, `built_nodes`, `callback`, `event_log_trace`.
- **`VariablePool`** (`engine/entities/variable_pool.py`) — `input_variable_mapping`
  & `output_variable_mapping` keyed `"{node_id}-{var_name}"`; resolves references
  via `NodeRef`; literals vs references; `deepcopy()` for parallel isolation;
  chat history (`history_mapping`, `history_v2`).
- **DSL schema** (`engine/entities/workflow_dsl.py`): top-level `nodes`,
  `edges`; node id pattern `^.*::[0-9a-zA-Z-]+`; `data.inputs`, `outputs`,
  `nodeParam`, `nodeMeta`, `retryConfig`.
- **Persistence**: DAO layer (`repository/flow_dao.py`) + Alembic migrations;
  flows stored in database (not flat files).

### 1.5 Streaming, retries, error handling

- **Streaming**: `support_stream_node_ids` set; per-node `stream_data` queue;
  `StreamOutputMsg` with `exception_occurred` flag. LLM/Agent/Knowledge Pro/Flow
  nodes are streaming-capable; the engine forwards tokens to callbacks while
  the DAG runs.
- **Retries (`RetryConfig`, `engine/entities/retry_config.py`)**:
  `timeout` (float, default 60), `should_retry` (bool, default False),
  `max_retries` (int, default 0), `error_strategy` (int — `Interrupted`,
  `CustomReturn`, `FailBranch`), `custom_output` (dict).
- **`ErrorHandlerChain`** (Chain of Responsibility) —
  `TimeoutErrorHandler` → `CustomExceptionInterruptHandler` →
  `RetryableErrorHandler` → `GeneralErrorHandler`. Mid-stream retries are
  blocked by `_stream_node_has_sent_first_token()` to avoid double-output.
- **Error continuation by node type**: some nodes can return a custom value and
  continue (DATABASE/PLUGIN/CODE/DECISION_MAKING/KB/PARAMETER_EXTRACTOR/MCP/RPA/MEMORY);
  streaming nodes (LLM/AGENT/KP/FLOW) emit an error message and continue.

### 1.6 Observability & debugging

- Per-node `WorkflowLog` event trace (`event_log_trace`).
- Token & price metrics tracked per node (`TOTAL_TOKENS`, `TOTAL_PRICE`,
  `CURRENCY`, `TOOL_INFO`, `ITERATION_ID`, `ITERATION_INDEX`).
- Dedicated `node_debug_router` (`/workflow/v1/...`) for single-node
  debug runs.
- SSE debug chat router (`sse_debug_chat_router`) and OpenAPI SSE router
  (`sse_openapi_router`).

### 1.7 Builder UI

- `layout_router` returns canvas layout for the frontend visual editor.
- Repository has `console-frontend/` (React) implementing the workflow builder
  (not in scope for this analysis).

---

## 2. ihub-apps: current state

### 2.1 Module layout

`/home/user/ihub-apps/server/services/workflow/`:
- `WorkflowEngine.js` — orchestrator
- `DAGScheduler.js` — DAG ops, condition evaluation
- `StateManager.js` — in-memory + disk checkpoints
- `ExecutionRegistry.js` — user → executions index
- `WorkflowLLMHelper.js` — adapter-option filter & streaming helper
- `executors/`: `BaseNodeExecutor`, `StartNodeExecutor`, `EndNodeExecutor`,
  `AgentNodeExecutor`, `ToolNodeExecutor`, `DecisionNodeExecutor`,
  `TransformNodeExecutor`, `HumanNodeExecutor`, `index.js`

Routes: `/home/user/ihub-apps/server/routes/workflow/workflowRoutes.js`
Schema: `/home/user/ihub-apps/server/validators/workflowConfigSchema.js`
Loader: `/home/user/ihub-apps/server/workflowsLoader.js`
Chat bridge: `/home/user/ihub-apps/server/tools/workflowRunner.js`

### 2.2 Execution model

- **Sequential MVP loop** (`WorkflowEngine.js:268-535`). Iterates with
  `MAX_EXECUTION_ITERATIONS = 100`, picks the first executable node from
  `state.currentNodes`, runs it, then computes next nodes
  (`DAGScheduler.getNextNodes`). Parallel execution is **explicitly TODO**
  (`DAGScheduler.js:239-241`).
- **Cycle handling**: opt-in via `workflow.config.allowCycles` (default true).
  Strict-DAG mode rejects cycles using Kahn’s algorithm. Looping is bounded by
  `maxIterations` per node (`WorkflowEngine.js:649-664`).
- **Edge conditions** (`DAGScheduler.js:363-409`): `always`, `never`,
  `expression` (using `===`/`!==`), `equals`, `contains`, `exists`, `llm`
  (placeholder — not implemented).

### 2.3 Node types (7 implemented)

| Type | File | Purpose |
|---|---|---|
| `start` | `executors/StartNodeExecutor.js` | input mapping/defaults |
| `end` | `executors/EndNodeExecutor.js` | output mapping, custom statusCode |
| `agent` | `executors/AgentNodeExecutor.js` | LLM call w/ tools, sources, files |
| `tool` | `executors/ToolNodeExecutor.js` | deterministic tool invocation |
| `decision` | `executors/DecisionNodeExecutor.js` | expression / switch / LLM (TODO) |
| `transform` | `executors/TransformNodeExecutor.js` | pure state ops: set, copy, increment, push, merge, arrayGet, lengthOf, conditional |
| `human` | `executors/HumanNodeExecutor.js` | pause for user input / approval |

Schema also enumerates `parallel`, `join`, `memory` (`workflowConfigSchema.js:106-117`)
but **no executors** exist for them — they would throw `EXECUTOR_NOT_FOUND`.

### 2.4 State & persistence

- `StateManager` singleton (`StateManager.js:68-73`) keeps `activeStates` Map
  in memory.
- Per-execution disk checkpoints under
  `contents/data/workflow-state/{executionId}/latest.json` via
  `atomicWriteJSON` (`StateManager.js:259-303`).
- 50 MB state size cap (`StateManager.js:23`).
- `ExecutionRegistry` keeps a JSON index of executions per user
  (`workflow-state/execution-registry.json`), recoverable on restart
  (`ExecutionRegistry.js:357-406`).
- State carries `currentNodes`, `completedNodes`, `failedNodes`, `data`,
  `data.nodeResults`, `data.executionMetrics`, `_nodeIterations`,
  `_pausedAt`, `_pauseReason`. Loop iteration outputs are keyed
  `{nodeId}_iter{N}` (`StateManager.js:458-465`).
- Workflows are **flat JSON files** under `contents/workflows/{id}.json`
  with no DB. Loader: `workflowsLoader.js` + `configCache`.

### 2.5 Streaming, retries, errors

- **SSE**: `workflowRoutes.js:1257-1408` per-execution SSE channel,
  identity-pinned for reconnect safety, 30 s heartbeat. Events:
  `workflow.start`, `workflow.iteration`, `workflow.node.{start,complete,error}`,
  `workflow.paused`, `workflow.human.{required,responded}`,
  `workflow.{complete,failed,cancelled}`, `workflow.checkpoint.saved`.
- **Chat bridge** (`tools/workflowRunner.js`) re-emits workflow events
  on the chat SSE channel and exposes workflows as tools.
- **Retry per node**: `node.execution.retries` / `retryDelay` /
  `errorHandler ∈ {fail, continue, llm_recovery}` in schema
  (`workflowConfigSchema.js:60-71`). Engine implements `retries` + `retryDelay`
  (`WorkflowEngine.js:399-456`) but `continue` and `llm_recovery` are
  **schema-declared only** — engine always fails the workflow after all retries
  (`WorkflowEngine.js:820-844`).
- **Workflow-level deadline**: `config.maxExecutionTime` (default 5 min, cap
  10 min) checked every loop iteration (`WorkflowEngine.js:312-343`).
- **Cancellation**: `AbortController` per execution.

### 2.6 Observability

- Per-node `tokens` and `metrics.duration` aggregated into
  `state.data.executionMetrics` (`StateManager.js:467-481`).
- Step history (`state.history`) for every `node_start` / `node_complete` /
  `node_error`.
- Admin endpoint `GET /api/admin/workflows/executions` with status/search/pagination
  (`workflowRoutes.js:1809-1883`).
- Per-execution export (`/executions/:id/export`) of full state JSON.
- No per-node debug runner; no built-in single-node debug API.

### 2.7 Builder UI

- Client lives at `/home/user/ihub-apps/client/src/features/workflows/` and
  contains list, execution, human-checkpoint, and live progress components but
  **no visual graph editor** — workflows are authored as raw JSON.
- The `canvas/` feature (`client/src/features/canvas/`) is a Quill-based text
  canvas, **not** a graph workflow editor.

### 2.8 Variable resolution

Two co-existing syntaxes:
- JSONPath-ish `$.data.field`, `${$.path}` — `BaseNodeExecutor.resolveVariable`
  / `resolveVariables` (`BaseNodeExecutor.js:120-217`).
- Handlebars-ish `{{var}}`, `{{#if}}`, `{{#each}}`, `{{#compare}}`, `{{this}}`,
  `{{@index}}` — `AgentNodeExecutor.resolveTemplateVariables` /
  `processEachBlocks` (`AgentNodeExecutor.js:383-623`).

Decision expressions use a sanitized `new Function()` evaluator
(`DecisionNodeExecutor.js:243-288`) with deny-list patterns and helpers
(`exists()`, `empty()`, `length()`).

---

## 3. Gap matrix

| Capability | astron-agent | ihub-apps | Severity | Notes |
|---|---|---|---|---|
| Parallel node execution | Yes (asyncio + strategy) | No (MVP sequential, TODO) | **High** | Major perf gap; iteration-style parallelism missing |
| Iteration over a list (subgraph per item) | Iteration node (serial+parallel) | No | **High** | Common pattern (e.g., per-query research) |
| Stateful loop with conditions | Loop node (`and`/`or`, regex, `eq`, `gt`, …) | Cycles + `maxIterations` only | **High** | No declarative loop termination |
| LLM/agent node | Spark LLM + Agent (separate) | Combined `agent` node | Low | Functional parity |
| Code node (sandboxed Python) | Yes (`CodeExecutorFactory`) | No | **High** | Big feature for power users / RPA |
| Knowledge / RAG node | Yes (Knowledge / Pro / Expert + adaptive prompts) | Via `sources` in `agent` config | Med | iHub does have sources, but no first-class RAG node with reranking |
| Tool / Plugin node with versioning | Yes | `tool` node, no versioning | Low | Adequate today |
| MCP node | Yes | No | Med | MCP momentum is growing |
| RPA node | Yes | No | Low | Niche |
| Memory add/search nodes | Yes | No | Med | iHub has chat memory but no node primitives |
| Decision / If-Else | Decision + If/Else nodes | `decision` (expression / switch / LLM TODO) | Low | LLM routing not implemented |
| Parameter extractor | Dedicated node | Done in `agent` w/ schema | Med | Reusable pattern is convenient |
| Variable aggregation / text joiner | Dedicated nodes | Doable via `transform` | Low | OK for now |
| Question/Answer node (in-flow user Q) | Yes (with serial lock) | `human` covers it | Low | Similar |
| Human-in-the-loop checkpoints | Implicit (Q/A) | First-class `human` node | None | iHub is ahead here |
| Edge conditions / branches | DAG edges + `sourceHandle`, fail-branch | Multiple condition types | Low | Parity-ish |
| Error strategy per node | `Interrupted` / `CustomReturn` / `FailBranch` | Schema enums declared but only `fail` works | **High** | `continue`/`llm_recovery` are stubs |
| Per-node retry config | Yes (timeout/maxRetries/strategy/customOutput) | Yes (retries/retryDelay/errorHandler) | Low | Implementation gap on errorHandler |
| Streaming intermediate output to client | Per-node streaming queue + token-aware retries | SSE per execution; no token-level streaming from agent nodes to UI | Med | LLM tokens are accumulated, not streamed |
| Persistence | Database (DAO + Alembic) | JSON files + checkpoint dir | Med | OK at small scale; weak for multi-instance |
| Multi-instance / horizontal scale | DB-backed state | Singleton in-memory `StateManager` | **High** | One process owns running executions |
| Node debug API (single-node run) | Yes (`node_debug_router`) | No | Med | Big DX win for builders |
| Versioned DSL (semver, schema versioning) | Workflow DSL with explicit DB schema | semver field in JSON | Low | Both have versions, no migration tooling on either side |
| Visual graph editor | Yes (console-frontend) | No (JSON only) | **High** | Adoption blocker for non-developers |
| Token / cost metrics | Per-node tokens + price + currency | Tokens + duration; no price | Med | Cost reporting missing |
| Observability log trace | `WorkflowLog` event trace + structured callbacks | `state.history`, SSE events | Low | Comparable |
| Cycle/loop safety | maxLoopCount per loop node | maxIterations per workflow + per-node | Low | Parity |
| Schema validation | Pydantic at boot + runtime | Zod at boot + runtime | None | OK |
| Sub-workflows / call-flow node | `FLOW` node | No | Med | Composition is currently impossible |

---

## 4. What we should reimplement (ranked)

Each row: rationale · scope (S/M/L/XL) · risk · key dependencies.

1. **Parallel execution in `DAGScheduler` / `WorkflowEngine`**
   *Rationale*: Unblocks every other parallel feature (iteration, branch fan-out).
   The current MVP picks one node per iteration — devastating for any non-linear
   graph.
   *Scope*: M · *Risk*: Med (state-merge races, error fan-in) · *Deps*: none — already
   gated by `workflow.config.parallel` flag we can add.

2. **Iteration node (subgraph per list item, serial + parallel modes)**
   *Rationale*: The biggest user-facing missing primitive. Today users hand-roll
   cycles to iterate, which is brittle. Astron’s `IterationNode` is the obvious
   blueprint.
   *Scope*: L · *Risk*: Med (deep-cloning state, isolated metrics) · *Deps*: #1.

3. **Loop node with declarative termination conditions**
   *Rationale*: Replaces the current “cycles + maxIterations” crutch. Cleaner
   semantics, safer, easier to validate, supports common patterns (until-converged,
   while-not-found).
   *Scope*: M · *Risk*: Low · *Deps*: none.

4. **Code node (sandboxed JavaScript/Python execution)**
   *Rationale*: Power-user requirement; enables data wrangling, custom validators,
   small adapters without writing a tool.
   *Scope*: L · *Risk*: High (sandboxing — recommend `isolated-vm` or sidecar)
   · *Deps*: none.

5. **Honour `errorHandler: continue` and add `customReturn` strategy**
   *Rationale*: Schema already promises it. Today it silently fails the workflow.
   *Scope*: S · *Risk*: Low · *Deps*: none. Quick win.

6. **Fail-branch routing on edges (`sourceHandle: "fail"`)**
   *Rationale*: Lets workflows recover gracefully without a separate decision node.
   *Scope*: S · *Risk*: Low · *Deps*: #5.

7. **Sub-workflow node (`flow` / `call_workflow`)**
   *Rationale*: Enables composition and reuse — today there’s no way to factor
   common sequences.
   *Scope*: M · *Risk*: Med (recursion budget, output mapping) · *Deps*: none.

8. **First-class knowledge/RAG node**
   *Rationale*: Sources are wired into `agent` nodes only. A dedicated RAG node
   that returns ranked chunks (and feeds into other nodes) is more flexible.
   *Scope*: M · *Risk*: Low · *Deps*: existing `SourceResolutionService`.

9. **LLM-based decision routing**
   *Rationale*: `decision.type === 'llm'` is declared and stubbed
   (`DecisionNodeExecutor.js:413-429`).
   *Scope*: S · *Risk*: Low · *Deps*: `WorkflowLLMHelper`.

10. **Memory add/search nodes**
    *Rationale*: Standard pattern for long-running agents.
    *Scope*: M · *Risk*: Med (persistence model) · *Deps*: new memory store.

11. **Single-node debug API + UI**
    *Rationale*: Builder productivity. Execute one node with synthetic input
    without running the rest.
    *Scope*: M · *Risk*: Low · *Deps*: existing executors.

12. **Visual graph editor (canvas)**
    *Rationale*: Major adoption blocker. Likely reuse React Flow + existing
    component infra.
    *Scope*: XL · *Risk*: High (UX surface) · *Deps*: stable DSL.

13. **DB-backed state & cross-instance execution**
    *Rationale*: Today `StateManager` is an in-memory singleton — only one
    process can own an execution. Blocks horizontal scaling.
    *Scope*: L · *Risk*: Med · *Deps*: choose store (SQLite/Postgres).

14. **Token-level streaming from agent nodes to client**
    *Rationale*: Today agent output is buffered and emitted on completion;
    astron streams tokens. Improves perceived latency in chat bridge.
    *Scope*: M · *Risk*: Low · *Deps*: actionTracker plumbing.

15. **Cost (price/currency) metrics in `executionMetrics`**
    *Rationale*: We track tokens but not cost. Easy add given model registry.
    *Scope*: S · *Risk*: Low · *Deps*: model pricing config.

---

## 5. Implementation outline (top 3)

### 5.1 Parallel execution

**Files to touch**
- `server/services/workflow/DAGScheduler.js` —
  `getExecutableNodes()` currently returns `[firstNode]`
  (`DAGScheduler.js:244`). Return **all** current nodes whose `incomingEdges`
  are satisfied; respect a new `workflow.config.parallel` and per-node
  `node.execution.sequential` opt-out (Q/A-style).
- `server/services/workflow/WorkflowEngine.js` —
  in `_runExecutionLoop`, replace the `for (const nodeId of executableNodes)`
  loop with `await Promise.all(executableNodes.map(...))` when parallel; gather
  results, then call `getNextNodes` for each. Wrap `markNodeCompleted` and
  state updates so concurrent writes go through a queue per execution to
  avoid `deepMerge` races.
- `server/services/workflow/StateManager.js` — add a small per-execution
  async mutex (or serialize via a `Promise` chain) around `update` /
  `markNodeCompleted`.

**API/module names**
- `WorkflowEngine._runParallelTier(executableNodes, …)`
- `StateManager._withLock(executionId, fn)`

**Schema changes** (`workflowConfigSchema.js`)
- Add `config.parallel: boolean` (default `false` for backward compat).
- Add `node.execution.sequential: boolean` to force serial.

**Migration**
- New `server/migrations/V0NN__workflow_parallel_default.js` setting
  `config.parallel = false` on existing workflow JSON files (no-op semantics).

**UI**
- `ExecutionProgress.jsx` already renders one node-card per result —
  no major change, but show concurrent nodes side-by-side in the same tier
  row.

**Tests**
- New unit tests in `server/tests/services/workflow/DAGScheduler.test.js`
  (parallel tier resolution).
- Engine integration test running a fan-out → fan-in diamond.
- Stress test ensuring `state.data.nodeResults` is consistent under
  10-way fan-out.

---

### 5.2 Iteration node (subgraph per item)

**Files to add**
- `server/services/workflow/executors/IterationNodeExecutor.js`
- (Optional) `server/services/workflow/SubExecutionRunner.js` —
  helper that re-uses `WorkflowEngine` to run a list of nodes as a
  sub-workflow with an isolated `StateManager` scope (or namespaced
  `state.data._iter[itemIdx]`).

**Files to touch**
- `executors/index.js` — register `iteration`.
- `WorkflowEngine.js` — accept a callback to spawn nested executions;
  share `actionTracker` so SSE events bubble.
- `DAGScheduler.js` — treat iteration node as a single scheduling unit
  (its inner subgraph runs inside the executor).

**Schema changes** (`workflowConfigSchema.js`)
- Extend `nodeTypeEnum` with `iteration`.
- Inside `config` (passthrough already allows it), document the contract:
  ```
  config: {
    items: "$.data.queries",            // JSONPath to iterable
    itemVariable: "query",              // exposed inside subgraph
    indexVariable: "i",
    subgraph: { nodes: [...], edges: [...] },
    isParallel: false,
    maxConcurrency: 5,
    errorStrategy: "fail_fast" | "continue" | "ignore",
    outputVariable: "results"
  }
  ```

**Migration**
- No backfill — additive.

**UI**
- `client/src/features/workflows/components/ExecutionProgress.jsx` —
  render iteration sub-results as a nested collapsible per index
  (we already key by iteration: `state.data.nodeResults` uses
  `{nodeId}_iter{N}` — extend with `{nodeId}_iter{N}_sub_{subNodeId}`).
- `WorkflowExecutionPage.jsx` — surface iteration progress (e.g. "3/10").

**Tests**
- Unit: executor with serial + parallel + each error strategy.
- E2E: workflow that iterates over a list of search queries and
  aggregates into a final report (mirrors `iterative-research-auto.json`
  but cleaner).

**Migration considerations**
- Existing `iterative-research-*` workflows use cycles. After landing,
  publish a new `iterative-research-iteration.json` example; do **not**
  auto-rewrite existing workflows (they may rely on per-cycle state).

---

### 5.3 Loop node with declarative termination

**Files to add**
- `server/services/workflow/executors/LoopNodeExecutor.js`

**Files to touch**
- `executors/index.js` — register `loop`.
- `workflowConfigSchema.js` — add `loop` to `nodeTypeEnum`. Inside `config`:
  ```
  config: {
    loopVariables: [
      { name: "counter", initial: 0 },
      { name: "results", initial: [] }
    ],
    termination: {
      operator: "or",
      conditions: [
        { field: "$.data.counter", op: "gt", value: 10 },
        { field: "$.data.shouldStop", op: "eq", value: true }
      ]
    },
    maxIterations: 50,
    subgraph: { nodes: [...], edges: [...] }
  }
  ```

**Schema validation**
- Add discriminated-union refinements for the `op` field
  (`eq | neq | gt | gte | lt | lte | contains | regex_contains | in | exists`).

**Migration**
- New migration `V0NN__deprecate_cycles_default.js`: optional, leaves
  `allowCycles=true` (existing workflows unaffected). When we deprecate,
  bump again to `false` by default.

**UI**
- Show loop iteration count in `ExecutionProgress`.
- Surface termination condition that fired (engine emits a new
  `workflow.loop.terminated` event with `reason`).

**Tests**
- Termination on each operator.
- `maxLoopCount` safety net.
- Pre/post loop variable propagation.

---

## 6. Open questions

1. **What persistence model do we want long-term?** Astron uses a DB. iHub uses
   JSON files. Adopting a DB unlocks multi-instance execution but is a larger
   architectural change. Resolution: prototype with SQLite first; measure.
2. **Sandbox technology for the Code node** — `vm2` is deprecated; `isolated-vm`
   needs native build; `quickjs-emscripten` is portable. Need a decision.
3. **Should we keep JSON-file workflows or migrate to DB?** Could keep both
   (file = source-of-truth in repo, DB = runtime cache + execution state).
4. **Multi-language code node** — Python via sidecar process? Or JS-only first?
5. **Exact mapping from astron’s 28 node types to ihub’s `transform`** —
   how many of `text_joiner`, `variable_aggregation`, `params_extractor` can be
   served by `transform` vs needing dedicated nodes for clearer DX?
6. **Streaming protocol changes** — token-level streaming from agent nodes
   to the chat bridge needs a contract between `actionTracker`,
   `workflowRunner.js`, and the SSE channel; needs design before code.
7. **Sub-workflow security/permissions** — does the called workflow inherit
   the caller’s user/groups? Need explicit policy.
8. **Could not fetch** complete `dsl_engine.py`, `node_debug_router`, `flow_dao.py`
   contents (rate limits / size). Findings on those are from WebFetch summaries
   and may miss subtleties — verify before final implementation.
