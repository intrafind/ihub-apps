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

### Phase 3: Advanced Execution Features - 🔜 NEXT

| Component | Status | Priority |
|-----------|--------|----------|
| Parallel/Join Nodes | 🔜 Planned | High |
| LLM-based Routing | 🔜 Planned | Medium |
| Configurable Error Handling | ⚠️ Partial | Medium |

### Phase 4-6: Future

| Phase | Components | Status |
|-------|------------|--------|
| Phase 4 | Memory System, Cost Tracking, Execution Replay | 🔜 Planned |
| Phase 5 | Visual Editor (React Flow), NL Generation | 🔜 Planned |
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
├── configCache.js                 ✅ (extended)
└── server.js                      ✅ (routes registered)

client/src/features/workflows/
├── pages/
│   ├── WorkflowsPage.jsx          ✅ (Phase 2) - Main page with tabs
│   ├── WorkflowListTab.jsx        ✅ (Phase 2) - Available workflows grid
│   ├── MyExecutionsTab.jsx        ✅ (Phase 2) - User's executions list
│   └── WorkflowExecutionPage.jsx  ✅ (Phase 2) - Single execution view
├── components/
│   ├── WorkflowCard.jsx           ✅ (Phase 2) - Workflow definition card
│   ├── ExecutionCard.jsx          ✅ (Phase 2) - Execution status card
│   ├── ExecutionProgress.jsx      ✅ (Phase 2) - Timeline visualization
│   ├── HumanCheckpoint.jsx        ✅ (Phase 2) - Approval/input UI
│   └── StartWorkflowModal.jsx     ✅ (Phase 2) - Configure and start
├── hooks/
│   ├── useWorkflowList.js         ✅ (Phase 2) - Fetch available workflows
│   ├── useMyExecutions.js         ✅ (Phase 2) - Fetch user's executions
│   └── useWorkflowExecution.js    ✅ (Phase 2) - SSE + state management
└── index.js                       ✅ (Phase 2) - Feature exports

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
2. **Integration Tests** - End-to-end test suite for workflow system
3. **Timeout Handling** - Configurable timeouts for human checkpoints
4. **Workflow Templates** - Pre-built workflow patterns

### Short-term (Phase 4)

1. **Memory System** - Short-term, session, and long-term memory
2. **Cost Tracking** - Token counting per node
3. **Execution Replay** - Debug and audit workflow runs

### Medium-term (Phase 5)

1. **Visual Editor** - React Flow-based drag-and-drop editor
2. **NL Generation** - Natural language to workflow conversion
3. **Subworkflows** - Nested workflow execution

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
