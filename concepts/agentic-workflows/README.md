# Agentic Workflow System - Concept Document

## Executive Summary

Add a comprehensive agentic workflow system to iHub Apps that enables multi-step, multi-agent task execution with parallel processing, human-in-the-loop checkpoints, and configurable observability. Built from scratch using industry patterns as reference (no third-party agentic libraries).

---

## Requirements Summary

| Aspect | Requirement |
|--------|-------------|
| **Workflow Definition** | Visual editor + JSON config + Natural language generation |
| **Observability** | Configurable (minimal → full transparency) |
| **Persistence** | Configurable (none → session → long-term memory) |
| **Collaboration** | Sequential, parallel, supervisor patterns |
| **Integration** | Unified with existing app/tool infrastructure |
| **Error Handling** | Configurable (fail fast, retry, LLM-driven recovery) |
| **Human-in-Loop** | No intervention → approval gates → real-time control |
| **Execution** | Hybrid (server + sandbox + external APIs) |
| **MVP Focus** | Core execution loop first |

---

## Core Architecture

### High-Level Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client (React)                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │Visual Editor │  │ Execution UI │  │ NL Workflow Generator│  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │ REST/SSE
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Workflow API Layer                          │
│  /api/workflows, /api/workflows/:id/execute, /stream            │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐
│WorkflowEngine│◄──►│ StateManager │◄──►│  CheckpointStorage   │
└──────────────┘    └──────────────┘    └──────────────────────┘
        │
        ├─────────────────┬─────────────────┬─────────────────┐
        ▼                 ▼                 ▼                 ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│DAGScheduler  │  │NodeExecutors │  │ MemorySystem │  │ActionTracker │
│(dependencies)│  │(agent,tool,  │  │(short/session│  │(SSE events)  │
│              │  │ decision...) │  │ /long-term)  │  │              │
└──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │  Existing Systems    │
              │  - ToolExecutor      │
              │  - ChatService       │
              │  - configCache       │
              └──────────────────────┘
```

---

## Core Data Structures

### Workflow Definition Schema

```javascript
{
  "id": "research-workflow",
  "name": { "en": "Research Workflow", "de": "Forschungs-Workflow" },
  "description": { "en": "Multi-agent research with synthesis" },
  "version": "1.0.0",
  "enabled": true,

  "config": {
    "observability": "full",           // minimal | standard | full
    "persistence": "session",          // none | session | long_term
    "errorHandling": "llm_recovery",   // fail | retry | llm_recovery
    "humanInLoop": "approval_gates",   // none | approval_gates | real_time
    "maxExecutionTime": 300000,        // 5 minutes
    "maxNodes": 50                     // Safety limit
  },

  "nodes": [...],  // See Node Types below
  "edges": [...],  // See Edge Types below

  "allowedGroups": ["users", "admin"]
}
```

### Node Types

| Type | Purpose | Key Config |
|------|---------|------------|
| `start` | Entry point | Initial data mapping |
| `end` | Exit point | Output mapping |
| `agent` | LLM agent with tools | system, tools[], maxIterations, outputSchema |
| `tool` | Direct tool invocation | toolId, parameters |
| `decision` | Conditional branching | expression or llmPrompt |
| `parallel` | Fork execution | dynamicBranches (optional) |
| `join` | Wait for parallel branches | aggregation strategy |
| `human` | Approval checkpoint | message, options[], timeout |
| `transform` | Data manipulation | JSONPath expression |
| `memory` | Read/write memory | scope, key, operation |

### Edge Schema

```javascript
{
  "id": "e1",
  "source": "nodeA",
  "target": "nodeB",
  "condition": {
    "type": "always" | "expression" | "llm",
    "expression": "$.result.approved === true"
  }
}
```

### Execution State

```javascript
{
  "executionId": "exec-abc123",
  "workflowId": "research-workflow",
  "status": "running" | "paused" | "completed" | "failed",
  "currentNodes": ["search-node"],     // Active nodes
  "data": { ... },                     // Accumulated state
  "history": [...],                    // Execution steps
  "checkpoints": [...],                // Recovery points
  "errors": [...]
}
```

---

## Key Components

### 1. WorkflowEngine

**Location:** `server/services/workflow/WorkflowEngine.js`

**Responsibilities:**
- Load workflow definitions from configCache
- Execute workflow loop with DAG scheduling
- Coordinate node executors
- Manage checkpoints and recovery

**Core Loop:**
```
while (activeNodes.length > 0 && status === 'running'):
  1. Get executable nodes (dependencies satisfied)
  2. Execute nodes (parallel when independent)
  3. Process results, update state
  4. Determine next nodes based on edges
  5. Create checkpoint if configured
```

### 2. DAGScheduler

**Location:** `server/services/workflow/DAGScheduler.js`

**Responsibilities:**
- Topological sort with cycle detection
- Determine executable nodes based on dependencies
- Handle parallel execution coordination

**Critical Safety:**
- Cycle detection before execution starts
- Max node limit to prevent runaway workflows

### 3. StateManager

**Location:** `server/services/workflow/StateManager.js`

**Responsibilities:**
- In-memory state during execution
- Checkpoint persistence (file-based initially)
- State recovery from checkpoints

**Storage Strategy:**
- Memory for active execution
- File-based checkpoints via atomicWrite pattern
- Future: Database for scaling

### 4. Node Executors

**Location:** `server/services/workflow/executors/`

Each node type has a dedicated executor:
- `AgentNodeExecutor` - Reuses existing ToolExecutor
- `ToolNodeExecutor` - Direct tool invocation
- `DecisionNodeExecutor` - Expression/LLM evaluation
- `ParallelNodeExecutor` - Fork management
- `JoinNodeExecutor` - Branch synchronization
- `HumanNodeExecutor` - Checkpoint and pause

### 5. MemorySystem

**Location:** `server/services/workflow/MemorySystem.js`

Three tiers:
- **Short-term:** Per-execution, in-memory
- **Session:** Per-chat-session, cached
- **Long-term:** Persistent storage (optional)

---

## API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/workflows` | List available workflows |
| GET | `/api/workflows/:id` | Get workflow definition |
| POST | `/api/workflows` | Create workflow (admin) |
| PUT | `/api/workflows/:id` | Update workflow (admin) |
| DELETE | `/api/workflows/:id` | Delete workflow (admin) |
| POST | `/api/workflows/:id/execute` | Start execution |
| GET | `/api/workflows/executions/:id` | Get execution state |
| POST | `/api/workflows/executions/:id/resume` | Resume paused workflow |
| POST | `/api/workflows/executions/:id/cancel` | Cancel execution |
| GET | `/api/workflows/executions/:id/stream` | SSE event stream |

---

## Integration with Existing Systems

### Reusing ToolExecutor

The existing `ToolExecutor.js` handles:
- LLM tool calling loop (max 10 iterations)
- Tool execution and result handling
- Streaming responses
- Error handling

**Integration:** AgentNodeExecutor wraps ToolExecutor:
```javascript
class AgentNodeExecutor {
  async execute(node, state, options) {
    const toolExecutor = new ToolExecutor();
    return toolExecutor.processChatWithTools({...});
  }
}
```

### Extending configCache

Add workflow loading to `configCache.js`:
```javascript
getWorkflows(includeDisabled = false) {
  return this.loadConfigDir('workflows', includeDisabled);
}
```

### Extending ActionTracker

New events for workflow visibility:
- `workflow.start`
- `workflow.node.start`
- `workflow.node.complete`
- `workflow.node.error`
- `workflow.human.required`
- `workflow.checkpoint.saved`
- `workflow.complete`
- `workflow.failed`

---

## Critical Concerns & Mitigations

### From Challenger Review

| Concern | Severity | Mitigation |
|---------|----------|------------|
| **Memory explosion** | CRITICAL | Max state size (50MB), lazy materialization, state sharding |
| **Race conditions in parallel** | CRITICAL | Immutable state updates, proper locking |
| **Circular dependencies** | HIGH | Pre-execution cycle detection |
| **Tool sandbox escapes** | HIGH | Tool allowlist, path sanitization, output size limits |
| **SSE client lifecycle** | HIGH | Store results for disconnected clients, polling fallback |
| **Checkpoint atomicity** | HIGH | atomicWrite pattern, file locking |
| **Node timeout** | MEDIUM | Per-node timeout, cleanup of orphaned executions |
| **Message history explosion** | MEDIUM | Token compression, history summarization |

### MVP Scope Constraints

To de-risk implementation:
- **Max 20 nodes** per workflow initially
- **30 second** default node timeout
- **Sequential execution** first, parallel later
- **File-based checkpoints** (no database initially)
- **No distributed execution** (single instance)

---

## Implementation Phases

### Phase 1: Core Foundation (MVP)
1. Workflow schema and validation (Zod)
2. StateManager with file-based checkpoints
3. WorkflowEngine with sequential execution
4. Basic node executors: start, end, agent, tool
5. REST API for CRUD and execution
6. SSE streaming for progress

### Phase 2: Execution Features
1. DAGScheduler with cycle detection
2. Decision node (expression evaluation)
3. Parallel/Join nodes
4. Human checkpoint node
5. Configurable error handling

### Phase 3: Observability & Memory
1. Full ActionTracker event integration
2. Memory system (short-term, session)
3. Execution history and replay
4. Cost tracking (token counting)

### Phase 4: Visual Editor
1. React Flow-based graph editor
2. Node palette and drag-drop
3. Edge condition editor
4. Workflow import/export
5. NL-to-workflow generation

### Phase 5: Advanced Features
1. Subworkflow support
2. Dynamic parallel branching
3. LLM-based routing
4. Long-term memory
5. Sandboxed tool execution

---

## File Structure

```
server/
├── services/
│   └── workflow/
│       ├── WorkflowEngine.js
│       ├── StateManager.js
│       ├── DAGScheduler.js
│       ├── MemorySystem.js
│       └── executors/
│           ├── AgentNodeExecutor.js
│           ├── ToolNodeExecutor.js
│           ├── DecisionNodeExecutor.js
│           ├── ParallelNodeExecutor.js
│           ├── JoinNodeExecutor.js
│           └── HumanNodeExecutor.js
├── routes/
│   └── workflow/
│       └── workflowRoutes.js
└── validators/
    └── workflowConfigSchema.js

client/src/
└── features/
    └── workflows/
        ├── pages/
        │   ├── WorkflowList.jsx
        │   ├── WorkflowEditor.jsx
        │   └── WorkflowExecution.jsx
        └── components/
            ├── WorkflowCanvas.jsx
            ├── NodePalette.jsx
            └── ExecutionProgress.jsx

contents/
└── workflows/
    └── {id}.json
```

---

## Verification Plan

### Unit Tests
- Schema validation for workflow definitions
- DAG cycle detection
- State serialization/deserialization
- Node executor behavior

### Integration Tests
- Workflow execution end-to-end
- Checkpoint save/restore
- Human node pause/resume
- Error recovery scenarios

### Manual Testing
1. Create simple 3-node workflow
2. Execute and verify SSE events
3. Test pause at human node
4. Resume and complete
5. Verify checkpoint recovery after simulated failure

---

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Persistence** | File-based | Use atomicWrite pattern like configs. No new dependencies. |
| **Visual Editor** | Minimal in MVP | Simple node/edge view. Full drag-drop editor later. |
| **Tool Sandboxing** | Trust existing tools | Existing tools run directly. Add sandboxing for custom tools later. |

---

## Subagent Parallelization Strategy

The implementation can leverage parallel subagents for efficiency:

### Phase 1 Parallel Work
```
Agent 1: Schema & Validation
├── workflowConfigSchema.js (Zod schema)
├── Validator integration
└── Test fixtures

Agent 2: Core Engine
├── WorkflowEngine.js
├── DAGScheduler.js
└── StateManager.js

Agent 3: Node Executors
├── AgentNodeExecutor.js
├── ToolNodeExecutor.js
├── DecisionNodeExecutor.js
└── (start/end are trivial)
```

### Phase 2 Parallel Work
```
Agent 1: API Routes
├── workflowRoutes.js
├── Execution endpoints
└── SSE streaming

Agent 2: Client Components
├── WorkflowList.jsx
├── Basic WorkflowViewer.jsx
└── ExecutionProgress.jsx

Agent 3: Integration
├── configCache extension
├── ActionTracker events
└── Permission integration
```

---

## Next Steps After Approval

1. Create the concept document in `concepts/agentic-workflows/` folder
2. Begin Phase 1 implementation with parallel subagents
3. Set up test fixtures for workflow validation
4. Implement core engine with sequential execution first
