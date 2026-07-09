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

### Phase 2: UI, Session Recovery & Human Checkpoints - ✅ COMPLETE

| Component | Status | Files |
|-----------|--------|-------|
| ExecutionRegistry | ✅ Done | `server/services/workflow/ExecutionRegistry.js` |
| HumanNodeExecutor | ✅ Done | `server/services/workflow/executors/HumanNodeExecutor.js` |
| My Executions API | ✅ Done | `GET /api/workflows/my-executions` |
| Checkpoint Respond API | ✅ Done | `POST /api/workflows/executions/:id/respond` |
| WorkflowsPage | ✅ Done | `client/src/features/workflows/pages/WorkflowsPage.jsx` |
| WorkflowListTab | ✅ Done | `client/src/features/workflows/pages/WorkflowListTab.jsx` |
| MyExecutionsTab | ✅ Done | `client/src/features/workflows/pages/MyExecutionsTab.jsx` |
| WorkflowExecutionPage | ✅ Done | `client/src/features/workflows/pages/WorkflowExecutionPage.jsx` |
| HumanCheckpoint Component | ✅ Done | `client/src/features/workflows/components/HumanCheckpoint.jsx` |
| StartWorkflowModal | ✅ Done | `client/src/features/workflows/components/StartWorkflowModal.jsx` |
| useWorkflowExecution Hook | ✅ Done | `client/src/features/workflows/hooks/useWorkflowExecution.js` |
| useMyExecutions Hook | ✅ Done | `client/src/features/workflows/hooks/useMyExecutions.js` |
| useWorkflowList Hook | ✅ Done | `client/src/features/workflows/hooks/useWorkflowList.js` |
| Header Navigation | ✅ Done | `contents/config/ui.json` |
| Example Approval Workflow | ✅ Done | `contents/workflows/approval-workflow.json` |

### Phase 2.5: Admin Management, Chat Integration & Hardening - ✅ COMPLETE

| Component | Status | Files |
|-----------|--------|-------|
| AdminWorkflowsPage | ✅ Done | `client/src/features/admin/pages/AdminWorkflowsPage.jsx` |
| AdminWorkflowEditPage | ✅ Done | `client/src/features/admin/pages/AdminWorkflowEditPage.jsx` |
| AdminWorkflowExecutionsPage | ✅ Done | `client/src/features/admin/pages/AdminWorkflowExecutionsPage.jsx` |
| Admin API functions | ✅ Done | `client/src/api/adminApi.js` (7 new functions) |
| Admin Navigation | ✅ Done | `client/src/features/admin/components/AdminNavigation.jsx` |
| Chat @workflow Mentions | ✅ Done | `client/src/features/chat/components/WorkflowMentionSearch.jsx` |
| Inline Step Indicator | ✅ Done | `client/src/features/chat/components/WorkflowStepIndicator.jsx` |
| Chat Integration Hook | ✅ Done | `client/src/features/chat/hooks/useAppChat.js` |
| workflowRunner Tool | ✅ Done | `server/tools/workflowRunner.js` |
| App Selection Modal | ✅ Done | `client/src/features/workflows/components/AppSelectionModal.jsx` |
| ExecutionProgress (enhanced) | ✅ Done | `client/src/features/workflows/components/ExecutionProgress.jsx` |
| Execution Registry Persistence | ✅ Done | `server/services/workflow/ExecutionRegistry.js` |
| Startup Recovery | ✅ Done | `server/routes/workflow/workflowRoutes.js` (loadFromDisk + mark stale) |
| currentNode Tracking | ✅ Done | `server/services/workflow/WorkflowEngine.js` |
| StateManager Simplification | ✅ Done | Only writes `latest.json` per execution (no per-checkpoint files) |
| Cache Refresh on Mutations | ✅ Done | `configCache.refreshWorkflowsCache()` after CRUD |
| Workflow Authoring Guide | ✅ Done | `concepts/workflow-authoring-guide.md` |
| Integration Tests | ✅ Done | `tests/integration/workflows/` |

### Phase 3: Advanced Execution Features - 🔜 NEXT

| Component | Status | Priority | Notes |
|-----------|--------|----------|-------|
| Parallel/Join Nodes | 🔜 Planned | High | DAGScheduler already supports parallel paths; needs ParallelNodeExecutor + JoinNodeExecutor |
| LLM-based Routing | 🔜 Planned | Medium | DecisionNode with `type: "llm"` to let the model choose the branch |
| Configurable Error Handling | ⚠️ Partial | Medium | Retry works; needs fallback nodes, LLM-recovery |
| Transform Node | 🔜 Planned | Medium | Data manipulation without LLM call (map, filter, format) |

### Phase 4: Visual Workflow Designer - 🔜 PLANNED

| Component | Status | Priority | Notes |
|-----------|--------|----------|-------|
| React Flow Canvas | 🔜 Planned | High | Replace JSON editor with drag-and-drop node canvas |
| Node Palette | 🔜 Planned | High | Sidebar with draggable node types (agent, tool, decision, human, etc.) |
| Edge Conditions Editor | 🔜 Planned | High | Visual condition builder for edge routing |
| Node Config Panel | 🔜 Planned | High | Side panel for editing node properties (prompt, tools, model, etc.) |
| Live Preview | 🔜 Planned | Medium | Run workflow from designer with inline progress visualization |
| Undo/Redo | 🔜 Planned | Medium | History stack for canvas operations |
| Import/Export | ✅ Done | - | Already works via JSON (AdminWorkflowEditPage upload/download) |
| Template Gallery | 🔜 Planned | Low | Pre-built workflow patterns users can clone and customize |

**Designer Architecture Notes:**
- Use `@xyflow/react` (React Flow) for the canvas - industry standard, MIT licensed
- Node positions already stored in workflow JSON (`position: { x, y }`) - designed for this
- Designer replaces the JSON textarea in `AdminWorkflowEditPage.jsx`
- Keep JSON editor as an "advanced" toggle for power users
- Each node type gets a custom React Flow node component with type-specific UI
- Edge labels show conditions; click to edit
- Validation runs on save using existing `workflowConfigSchema.js` (Zod)

### Phase 5-6: Future

| Phase | Components | Status |
|-------|------------|--------|
| Phase 5 | Memory System, Cost Tracking, Execution Replay, NL Generation | 🔜 Planned |
| Phase 6 | Subworkflows, Dynamic Branching, Sandboxing | 🔜 Planned |

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
| **Human-in-Loop** | No intervention → approval gates → real-time | ✅ Approval Gates Done |
| **Execution** | Hybrid (server + sandbox + external APIs) | Server ✅, Sandbox 🔜 |
| **Client UI** | Workflow list, execution view, session recovery | ✅ Done (Phase 2) |
| **Session Recovery** | Reconnect to running/paused workflows | ✅ Done (Phase 2) |

---

## Core Architecture

### High-Level Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     Client (React) - Phase 2 ✅                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │WorkflowsPage │  │ExecutionPage │  │ HumanCheckpoint      │  │
│  │      ✅      │  │     ✅       │  │         ✅           │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │Visual Editor │  │ StartModal   │  │ NL Workflow Generator│  │
│  │    🔜        │  │     ✅       │  │         🔜           │  │
│  └──────────────┘  └──────────────┘  └──────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
                              │ REST/SSE
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Workflow API Layer ✅                        │
│  /api/workflows, /execute, /stream, /my-executions, /respond    │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐
│WorkflowEngine│◄──►│ StateManager │◄──►│  CheckpointStorage   │
│      ✅      │    │      ✅      │    │         ✅           │
└──────────────┘    └──────────────┘    └──────────────────────┘
        │                                        ▲
        │                                        │
        ├──────────────────────────────┬─────────┘
        ▼                              ▼
┌──────────────────┐    ┌──────────────────────────┐
│ExecutionRegistry │    │    HumanNodeExecutor     │
│    ✅ (Phase 2)  │    │       ✅ (Phase 2)       │
└──────────────────┘    └──────────────────────────┘
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
│       ├── ExecutionRegistry.js   ✅ (Phase 2)
│       ├── index.js               ✅
│       └── executors/
│           ├── index.js           ✅
│           ├── BaseNodeExecutor.js    ✅ (328 lines)
│           ├── StartNodeExecutor.js   ✅ (214 lines)
│           ├── EndNodeExecutor.js     ✅ (227 lines)
│           ├── AgentNodeExecutor.js   ✅ (590 lines)
│           ├── ToolNodeExecutor.js    ✅ (266 lines)
│           ├── DecisionNodeExecutor.js ✅ (438 lines)
│           └── HumanNodeExecutor.js   ✅ (Phase 2)
├── routes/
│   └── workflow/
│       ├── index.js               ✅
│       └── workflowRoutes.js      ✅ (extended with Phase 2 endpoints)
├── validators/
│   └── workflowConfigSchema.js    ✅ (440 lines)
├── workflowsLoader.js             ✅ (51 lines)
├── configCache.js                 ✅ (extended with refreshWorkflowsCache)
├── toolLoader.js                  ✅ (extended - workflow tool registration)
├── tools/workflowRunner.js        ✅ (Phase 2.5) - Chat-invocable workflow tool
├── actionTracker.js               ✅ (extended - workflow SSE events)
├── sse.js                         ✅ (extended - workflow event types)
└── server.js                      ✅ (routes registered)

client/src/features/workflows/
├── pages/
│   ├── WorkflowsPage.jsx          ✅ (Phase 2) - Main page with tabs
│   ├── WorkflowListTab.jsx        ✅ (Phase 2) - Available workflows grid
│   ├── MyExecutionsTab.jsx        ✅ (Phase 2) - User's executions list
│   └── WorkflowExecutionPage.jsx  ✅ (Phase 2+) - Single execution view (enhanced)
├── components/
│   ├── WorkflowCard.jsx           ✅ (Phase 2) - Workflow definition card
│   ├── ExecutionCard.jsx          ✅ (Phase 2) - Execution status card
│   ├── ExecutionProgress.jsx      ✅ (Phase 2+) - Timeline visualization (enhanced)
│   ├── HumanCheckpoint.jsx        ✅ (Phase 2) - Approval/input UI
│   ├── StartWorkflowModal.jsx     ✅ (Phase 2+) - Configure and start (enhanced)
│   └── AppSelectionModal.jsx      ✅ (Phase 2.5) - Workflow app picker
├── hooks/
│   ├── useWorkflowList.js         ✅ (Phase 2) - Fetch available workflows
│   ├── useMyExecutions.js         ✅ (Phase 2) - Fetch user's executions
│   └── useWorkflowExecution.js    ✅ (Phase 2+) - SSE + state management (enhanced)
└── index.js                       ✅ (Phase 2) - Feature exports

client/src/features/admin/pages/
├── AdminWorkflowsPage.jsx         ✅ (Phase 2.5) - Workflow list management
├── AdminWorkflowEditPage.jsx      ✅ (Phase 2.5) - Workflow edit/create
└── AdminWorkflowExecutionsPage.jsx ✅ (Phase 2.5) - All executions monitoring

client/src/features/chat/components/
├── WorkflowMentionSearch.jsx      ✅ (Phase 2.5) - @workflow mention dropdown
└── WorkflowStepIndicator.jsx      ✅ (Phase 2.5) - Inline workflow progress

contents/
├── workflows/                     📁 (create your workflows here)
│   ├── {id}.json
│   └── approval-workflow.json     ✅ (Phase 2) - Example with human checkpoint
└── config/
    └── ui.json                    ✅ (extended) - Workflows nav link
```

**Total: ~10,000+ lines of code (Phase 1 + Phase 2)**

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
| POST | `/api/workflows/executions/:id/respond` | ✅ | Respond to human checkpoint |
| GET | `/api/workflows/executions/:id/stream` | ✅ | SSE event stream |
| GET | `/api/workflows/my-executions` | ✅ | List user's executions |
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
| `human` | ✅ | Approval checkpoint | message, options[], inputSchema, showData |
| `transform` | 🔜 | Data manipulation | expression |
| `memory` | 🔜 | Read/write memory | scope, key, operation |

---

## Next Steps

### Immediate (Phase 3)

1. **Parallel/Join Nodes** - Enable concurrent execution of independent branches
2. **Transform Node** - Data manipulation without LLM calls (map, filter, format, aggregate)
3. **LLM-based Routing** - Decision nodes that use an LLM to choose branches
4. **Configurable Error Handling** - Fallback nodes, LLM-recovery strategies

### Short-term (Phase 4 — Visual Designer)

1. **React Flow Canvas** - Drag-and-drop workflow designer replacing JSON editor
2. **Node Palette & Config Panel** - Visual node creation and property editing
3. **Edge Condition Editor** - Visual builder for routing conditions
4. **Live Preview** - Run workflows directly from the designer
5. **Template Gallery** - Pre-built workflow patterns for common use cases

### Medium-term (Phase 5-6)

1. **Memory System** - Short-term, session, and long-term agent memory
2. **Cost Tracking** - Token counting and cost attribution per node
3. **Execution Replay** - Debug and audit completed workflow runs
4. **NL Generation** - Natural language to workflow conversion
5. **Subworkflows** - Nested workflow execution
6. **Dynamic Branching** - Runtime-determined parallel paths
7. **Sandboxing** - Isolated execution environments for untrusted tools

---

## Key Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **Persistence** | File-based | Use atomicWrite pattern like configs. No new dependencies. |
| **Visual Editor** | Minimal in MVP | Simple node/edge view. Full drag-drop editor later. |
| **Tool Sandboxing** | Trust existing tools | Existing tools run directly. Add sandboxing for custom tools later. |
| **Third-party libs** | None | Build from scratch using LangGraph/CrewAI as reference patterns. |
| **Execution Visibility** | User only (Phase 2) | Each user sees only their own executions. Simple, private. |
| **Checkpoint Timeout** | Wait indefinitely (Phase 2) | No timeout by default - workflow blocked until user responds. |
| **Navigation** | Header link (Phase 2) | 'Workflows' link in main header navigation. |
| **API URL Patterns** | No /api/ prefix in client | `apiClient` and `buildApiUrl` already include base paths. |
| **Cycle Support** | Allowed by default | Workflows can contain intentional cycles for revision loops. Per-node iteration limits prevent infinite loops (`maxIterations` config, default 10). |
| **Checkpoint Files** | Single `latest.json` per execution | Individual per-checkpoint files were never read back; only `latest.json` is used. Reduces I/O by 50%. |
| **Execution Recovery** | Mark stale as failed on startup | If server restarts, previously-running executions are marked failed (can't resume mid-LLM-call). |
| **Admin UI Pattern** | Mirror AdminToolsPage patterns | Admin workflow pages follow exact same conventions as existing admin pages for consistency. |
| **Chat Integration** | Workflows as tools | `workflowRunner.js` registers workflows as callable tools so the LLM can invoke them. |
| **Visual Designer** | React Flow (Phase 4) | Node positions already stored in JSON. Designer will replace JSON editor in AdminWorkflowEditPage. |

---

---

## Testing Phase 2 Features

### 1. Access Workflows UI

Navigate to `http://localhost:5173/workflows` to see the Workflows page with two tabs:
- **Available Workflows** - Shows all workflow definitions you can start
- **My Executions** - Shows your running, paused, and completed workflows

### 2. Test Human Checkpoint Workflow

The `approval-workflow.json` demonstrates the human checkpoint feature:

**Start the workflow:**
```bash
curl -X POST http://localhost:3001/api/workflows/approval-workflow/execute \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"initialData": {"topic": "climate change"}, "options": {}}'
```

Or use the UI:
1. Click on "Research with Approval" card
2. Enter initial data: `{"topic": "AI safety"}`
3. Click "Start Workflow"

**Workflow Flow:**
1. **Research** - Agent researches the topic
2. **Human Checkpoint** - Workflow pauses for your approval
3. **Decision** - Routes based on your choice (approve/reject/revise)
4. **Summary** - If approved, creates a summary

### 3. Respond to Human Checkpoint

When the workflow pauses at a human checkpoint:

**Via UI:**
1. Navigate to "My Executions" tab
2. Click on the paused execution
3. Review the research results displayed
4. Choose an option (Approve, Reject, or Request Revision)
5. Optionally add feedback
6. Click Submit

**Via API:**
```bash
curl -X POST http://localhost:3001/api/workflows/executions/EXECUTION_ID/respond \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "checkpointId": "CHECKPOINT_ID",
    "response": "approve",
    "data": {"feedback": "Looks good!"}
  }'
```

### 4. Session Recovery Test

1. Start a workflow that will pause at human checkpoint
2. Close the browser tab
3. Reopen the browser and navigate to `/workflows`
4. Go to "My Executions" tab
5. The paused workflow should appear - click to rejoin
6. Complete the human checkpoint

### 5. List User's Executions

```bash
# Get all your executions
curl -X GET "http://localhost:3001/api/workflows/my-executions" \
  -H "Authorization: Bearer YOUR_TOKEN"

# Filter by status
curl -X GET "http://localhost:3001/api/workflows/my-executions?status=paused" \
  -H "Authorization: Bearer YOUR_TOKEN"

# With pagination
curl -X GET "http://localhost:3001/api/workflows/my-executions?limit=10&offset=0" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

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
