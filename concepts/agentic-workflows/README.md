# Agentic Workflow System - Concept Document

## Executive Summary

Add a comprehensive agentic workflow system to iHub Apps that enables multi-step, multi-agent task execution with parallel processing, human-in-the-loop checkpoints, and configurable observability. Built from scratch using industry patterns as reference (no third-party agentic libraries).

**PR:** https://github.com/intrafind/ihub-apps/pull/871
**Branch:** `feature/agentic-workflows`

---

## Implementation Status

### Phase 1: Core Foundation - ✅ COMPLETE

| Component | Status | Files |
|-----------|--------|-------|
| Workflow Schema & Validation | ✅ Done | `server/validators/workflowConfigSchema.js` |
| StateManager | ✅ Done | `server/services/workflow/StateManager.js` |
| DAGScheduler | ✅ Done | `server/services/workflow/DAGScheduler.js` |
| WorkflowEngine | ✅ Done | `server/services/workflow/WorkflowEngine.js` |
| StartNodeExecutor | ✅ Done | `server/services/workflow/executors/StartNodeExecutor.js` |
| EndNodeExecutor | ✅ Done | `server/services/workflow/executors/EndNodeExecutor.js` |
| AgentNodeExecutor | ✅ Done | `server/services/workflow/executors/AgentNodeExecutor.js` |
| ToolNodeExecutor | ✅ Done | `server/services/workflow/executors/ToolNodeExecutor.js` |
| DecisionNodeExecutor | ✅ Done | `server/services/workflow/executors/DecisionNodeExecutor.js` |
| REST API | ✅ Done | `server/routes/workflow/workflowRoutes.js` |
| SSE Streaming | ✅ Done | Included in workflowRoutes.js |
| configCache Extension | ✅ Done | `server/configCache.js`, `server/workflowsLoader.js` |
| Server Integration | ✅ Done | `server/server.js` |

### Phase 2: Execution Features - 🔜 NEXT

| Component | Status | Priority |
|-----------|--------|----------|
| Parallel/Join Nodes | 🔜 Planned | High |
| Human Checkpoint Node | 🔜 Planned | High |
| LLM-based Routing | 🔜 Planned | Medium |
| Configurable Error Handling | ⚠️ Partial | Medium |

### Phase 3-5: Future

| Phase | Components | Status |
|-------|------------|--------|
| Phase 3 | Memory System, Cost Tracking, Execution Replay | 🔜 Planned |
| Phase 4 | Visual Editor (React Flow), NL Generation | 🔜 Planned |
| Phase 5 | Subworkflows, Dynamic Branching, Sandboxing | 🔜 Planned |

---

## How to Test

### 1. Start the Server

```bash
npm run dev
```

### 2. Create a Test Workflow

Create a file `contents/workflows/test-workflow.json`:

```json
{
  "id": "test-workflow",
  "name": {
    "en": "Test Workflow",
    "de": "Test-Workflow"
  },
  "description": {
    "en": "Simple test workflow with start, tool, and end nodes",
    "de": "Einfacher Test-Workflow mit Start-, Tool- und End-Knoten"
  },
  "version": "1.0.0",
  "enabled": true,
  "config": {
    "observability": "full",
    "persistence": "session",
    "errorHandling": "fail",
    "humanInLoop": "none",
    "maxExecutionTime": 60000,
    "maxNodes": 10
  },
  "nodes": [
    {
      "id": "start",
      "type": "start",
      "name": { "en": "Start" },
      "position": { "x": 100, "y": 200 },
      "config": {},
      "execution": { "timeout": 5000 }
    },
    {
      "id": "search",
      "type": "tool",
      "name": { "en": "Web Search" },
      "position": { "x": 300, "y": 200 },
      "config": {
        "toolId": "braveSearch",
        "parameters": {
          "query": "iHub Apps AI platform",
          "count": 3
        },
        "outputVariable": "searchResults"
      },
      "execution": { "timeout": 15000, "retries": 1 }
    },
    {
      "id": "end",
      "type": "end",
      "name": { "en": "End" },
      "position": { "x": 500, "y": 200 },
      "config": {
        "outputMapping": {
          "results": "$.searchResults"
        }
      },
      "execution": { "timeout": 5000 }
    }
  ],
  "edges": [
    { "id": "e1", "source": "start", "target": "search", "condition": { "type": "always" } },
    { "id": "e2", "source": "search", "target": "end", "condition": { "type": "always" } }
  ],
  "allowedGroups": ["users", "admin"]
}
```

### 3. Test API Endpoints

**List Workflows:**
```bash
curl -X GET http://localhost:3001/api/workflows \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Get Workflow by ID:**
```bash
curl -X GET http://localhost:3001/api/workflows/test-workflow \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Execute Workflow:**
```bash
curl -X POST http://localhost:3001/api/workflows/test-workflow/execute \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"initialData": {"query": "test"}, "options": {}}'
```

**Get Execution State:**
```bash
curl -X GET http://localhost:3001/api/workflows/executions/EXECUTION_ID \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Stream Execution Progress (SSE):**
```bash
curl -N http://localhost:3001/api/workflows/executions/EXECUTION_ID/stream \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### 4. Test with Agent Node

Create `contents/workflows/agent-test.json`:

```json
{
  "id": "agent-test",
  "name": { "en": "Agent Test" },
  "description": { "en": "Test workflow with LLM agent" },
  "version": "1.0.0",
  "enabled": true,
  "config": {
    "observability": "full",
    "persistence": "session",
    "errorHandling": "fail",
    "humanInLoop": "none",
    "maxExecutionTime": 120000,
    "maxNodes": 10
  },
  "nodes": [
    {
      "id": "start",
      "type": "start",
      "name": { "en": "Start" },
      "position": { "x": 100, "y": 200 },
      "config": {},
      "execution": { "timeout": 5000 }
    },
    {
      "id": "researcher",
      "type": "agent",
      "name": { "en": "Research Agent" },
      "position": { "x": 300, "y": 200 },
      "config": {
        "system": {
          "en": "You are a research assistant. Answer the user's question concisely."
        },
        "tools": ["braveSearch"],
        "maxIterations": 3,
        "outputVariable": "research"
      },
      "execution": { "timeout": 60000 }
    },
    {
      "id": "end",
      "type": "end",
      "name": { "en": "End" },
      "position": { "x": 500, "y": 200 },
      "config": {},
      "execution": { "timeout": 5000 }
    }
  ],
  "edges": [
    { "id": "e1", "source": "start", "target": "researcher", "condition": { "type": "always" } },
    { "id": "e2", "source": "researcher", "target": "end", "condition": { "type": "always" } }
  ],
  "allowedGroups": ["users", "admin"]
}
```

### 5. Test Decision Node

Create `contents/workflows/decision-test.json`:

```json
{
  "id": "decision-test",
  "name": { "en": "Decision Test" },
  "description": { "en": "Test conditional branching" },
  "version": "1.0.0",
  "enabled": true,
  "config": {
    "observability": "full",
    "persistence": "session",
    "errorHandling": "fail",
    "humanInLoop": "none",
    "maxExecutionTime": 30000,
    "maxNodes": 10
  },
  "nodes": [
    {
      "id": "start",
      "type": "start",
      "name": { "en": "Start" },
      "position": { "x": 100, "y": 200 },
      "config": {
        "inputMapping": { "value": "$.initialData.value" }
      },
      "execution": { "timeout": 5000 }
    },
    {
      "id": "check",
      "type": "decision",
      "name": { "en": "Check Value" },
      "position": { "x": 300, "y": 200 },
      "config": {
        "type": "expression",
        "expression": "state.data.value > 10"
      },
      "execution": { "timeout": 5000 }
    },
    {
      "id": "high",
      "type": "end",
      "name": { "en": "High Value" },
      "position": { "x": 500, "y": 100 },
      "config": { "outputMapping": { "result": "high" } },
      "execution": { "timeout": 5000 }
    },
    {
      "id": "low",
      "type": "end",
      "name": { "en": "Low Value" },
      "position": { "x": 500, "y": 300 },
      "config": { "outputMapping": { "result": "low" } },
      "execution": { "timeout": 5000 }
    }
  ],
  "edges": [
    { "id": "e1", "source": "start", "target": "check", "condition": { "type": "always" } },
    { "id": "e2", "source": "check", "target": "high", "condition": { "type": "expression", "expression": "result.branch === 'true'" } },
    { "id": "e3", "source": "check", "target": "low", "condition": { "type": "expression", "expression": "result.branch === 'false'" } }
  ],
  "allowedGroups": ["users", "admin"]
}
```

Execute with different values:
```bash
# Should go to "high" path
curl -X POST http://localhost:3001/api/workflows/decision-test/execute \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"initialData": {"value": 15}}'

# Should go to "low" path
curl -X POST http://localhost:3001/api/workflows/decision-test/execute \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"initialData": {"value": 5}}'
```

---

## Requirements Summary

| Aspect | Requirement | Status |
|--------|-------------|--------|
| **Workflow Definition** | Visual editor + JSON config + NL generation | JSON ✅, Visual 🔜, NL 🔜 |
| **Observability** | Configurable (minimal → full transparency) | ✅ Done |
| **Persistence** | Configurable (none → session → long-term) | Session ✅, Long-term 🔜 |
| **Collaboration** | Sequential, parallel, supervisor patterns | Sequential ✅, Parallel 🔜 |
| **Integration** | Unified with existing app/tool infrastructure | ✅ Done |
| **Error Handling** | Configurable (fail fast, retry, LLM-recovery) | Fail/Retry ✅, LLM 🔜 |
| **Human-in-Loop** | No intervention → approval gates → real-time | None ✅, Gates 🔜 |
| **Execution** | Hybrid (server + sandbox + external APIs) | Server ✅, Sandbox 🔜 |

---

## Core Architecture

### High-Level Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Client (React)                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │Visual Editor │  │ Execution UI │  │ NL Workflow Generator│  │
│  │    🔜        │  │     🔜       │  │         🔜           │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │ REST/SSE
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Workflow API Layer ✅                        │
│  /api/workflows, /api/workflows/:id/execute, /stream            │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐
│WorkflowEngine│◄──►│ StateManager │◄──►│  CheckpointStorage   │
│      ✅      │    │      ✅      │    │         ✅           │
└──────────────┘    └──────────────┘    └──────────────────────┘
        │
        ├─────────────────┬─────────────────┬─────────────────┐
        ▼                 ▼                 ▼                 ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│DAGScheduler  │  │NodeExecutors │  │ MemorySystem │  │ActionTracker │
│      ✅      │  │      ✅      │  │      🔜      │  │      ✅      │
└──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │  Existing Systems    │
              │  - ToolExecutor ✅   │
              │  - ChatService  ✅   │
              │  - configCache  ✅   │
              └──────────────────────┘
```

---

## File Structure (Implemented)

```
server/
├── services/
│   └── workflow/
│       ├── WorkflowEngine.js      ✅ (911 lines)
│       ├── StateManager.js        ✅ (561 lines)
│       ├── DAGScheduler.js        ✅ (701 lines)
│       ├── index.js               ✅
│       └── executors/
│           ├── index.js           ✅
│           ├── BaseNodeExecutor.js    ✅ (328 lines)
│           ├── StartNodeExecutor.js   ✅ (214 lines)
│           ├── EndNodeExecutor.js     ✅ (227 lines)
│           ├── AgentNodeExecutor.js   ✅ (590 lines)
│           ├── ToolNodeExecutor.js    ✅ (266 lines)
│           └── DecisionNodeExecutor.js ✅ (438 lines)
├── routes/
│   └── workflow/
│       ├── index.js               ✅
│       └── workflowRoutes.js      ✅ (1,292 lines)
├── validators/
│   └── workflowConfigSchema.js    ✅ (440 lines)
├── workflowsLoader.js             ✅ (51 lines)
├── configCache.js                 ✅ (extended)
└── server.js                      ✅ (routes registered)

contents/
└── workflows/                     📁 (create your workflows here)
    └── {id}.json
```

**Total: 7,545 lines of new code**

---

## API Endpoints (Implemented)

| Method | Endpoint | Status | Purpose |
|--------|----------|--------|---------|
| GET | `/api/workflows` | ✅ | List available workflows |
| GET | `/api/workflows/:id` | ✅ | Get workflow definition |
| POST | `/api/workflows` | ✅ | Create workflow (admin) |
| PUT | `/api/workflows/:id` | ✅ | Update workflow (admin) |
| DELETE | `/api/workflows/:id` | ✅ | Delete workflow (admin) |
| POST | `/api/workflows/:id/execute` | ✅ | Start execution |
| GET | `/api/workflows/executions/:id` | ✅ | Get execution state |
| POST | `/api/workflows/executions/:id/resume` | ✅ | Resume paused workflow |
| POST | `/api/workflows/executions/:id/cancel` | ✅ | Cancel execution |
| GET | `/api/workflows/executions/:id/stream` | ✅ | SSE event stream |
| GET | `/api/admin/workflows` | ✅ | List all workflows (admin) |
| POST | `/api/admin/workflows/:id/toggle` | ✅ | Toggle enabled (admin) |

---

## Node Types (Implemented)

| Type | Status | Purpose | Key Config |
|------|--------|---------|------------|
| `start` | ✅ | Entry point | inputMapping |
| `end` | ✅ | Exit point | outputMapping |
| `agent` | ✅ | LLM agent with tools | system, tools[], maxIterations, outputSchema |
| `tool` | ✅ | Direct tool invocation | toolId, parameters, outputVariable |
| `decision` | ✅ | Conditional branching | type (expression/switch), expression |
| `parallel` | 🔜 | Fork execution | dynamicBranches |
| `join` | 🔜 | Wait for branches | aggregation |
| `human` | 🔜 | Approval checkpoint | message, options[], timeout |
| `transform` | 🔜 | Data manipulation | expression |
| `memory` | 🔜 | Read/write memory | scope, key, operation |

---

## Next Steps

### Immediate (Phase 2)

1. **Parallel/Join Nodes** - Enable concurrent execution of independent branches
2. **Human Checkpoint Node** - Pause workflow for user approval
3. **Client UI** - Basic workflow list and execution viewer
4. **Integration Tests** - End-to-end test suite

### Short-term (Phase 3)

1. **Memory System** - Short-term, session, and long-term memory
2. **Cost Tracking** - Token counting per node
3. **Execution Replay** - Debug and audit workflow runs

### Medium-term (Phase 4)

1. **Visual Editor** - React Flow-based drag-and-drop editor
2. **NL Generation** - Natural language to workflow conversion
3. **Workflow Templates** - Pre-built workflow patterns

---

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Persistence** | File-based | Use atomicWrite pattern like configs. No new dependencies. |
| **Visual Editor** | Minimal in MVP | Simple node/edge view. Full drag-drop editor later. |
| **Tool Sandboxing** | Trust existing tools | Existing tools run directly. Add sandboxing for custom tools later. |
| **Third-party libs** | None | Build from scratch using LangGraph/CrewAI as reference patterns. |

---

## Research References

The architecture was informed by analysis of:

- **LangGraph** - Graph-based state management with checkpointing
- **CrewAI** - Role-based agents with hierarchical orchestration
- **AutoGen** - Message-driven multi-agent patterns
- **dAgent** - DAG-based parallel execution
- **CAOS** - Agents-as-operating-systems architecture
- **OpenClaw** - Session isolation and sandbox patterns

See `concepts/agentic-workflows/2026-02-06 Workflow API Routes Implementation.md` for detailed implementation notes.
