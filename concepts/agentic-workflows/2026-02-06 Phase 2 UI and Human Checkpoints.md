# Phase 2: UI, Session Recovery & Human Checkpoints

**Date:** 2026-02-06
**Status:** Complete
**Branch:** `feature/agentic-workflows`

---

## Summary

This phase adds the user-facing components for the agentic workflow system:
1. **Workflow UI** - Start, list, and monitor running workflows
2. **Session Recovery** - Workflows continue when browser closes, users can reconnect
3. **Human Checkpoint Node** - Pause workflows for user approval/input

---

## Server-Side Implementation

### ExecutionRegistry

**File:** `server/services/workflow/ExecutionRegistry.js`

Tracks all workflow executions by user for listing and recovery.

```javascript
class ExecutionRegistry {
  constructor() {
    this.executions = new Map();      // executionId -> metadata
    this.userExecutions = new Map();  // userId -> Set<executionId>
  }

  register(executionId, { userId, workflowId, status, startedAt }) {...}
  updateStatus(executionId, status) {...}
  getByUser(userId, options) {...}  // Returns paginated executions for a user
  getAll(options) {...}             // Returns all executions (admin)
  loadFromDisk() {...}              // Load from workflow-state directory
  saveToDisk() {...}                // Persist registry
}

export function getExecutionRegistry() {...}  // Singleton access
```

**Key Features:**
- Singleton pattern for global access
- Automatic persistence to disk
- Pagination and filtering support
- Status-based filtering

### HumanNodeExecutor

**File:** `server/services/workflow/executors/HumanNodeExecutor.js`

Pauses workflows for human input/approval.

```javascript
class HumanNodeExecutor extends BaseNodeExecutor {
  async execute(node, state, context) {
    // Create pending checkpoint
    const checkpoint = {
      id: generateId(),
      nodeId: node.id,
      type: 'human_input',
      message: this.resolveVariable(config.message, state),
      options: config.options,      // [{value, label, style}]
      inputSchema: config.inputSchema,  // Optional form schema
      showData: config.showData,    // JSONPath expressions
      createdAt: new Date().toISOString()
    };

    // Emit event for UI
    actionTracker.emit('workflow.human.required', { executionId, checkpoint });

    return {
      status: 'paused',
      output: { awaitingHuman: true },
      checkpoint,
      pauseReason: 'human_input_required'
    };
  }

  async resume(node, state, humanResponse) {
    // Validate response against options
    // Return result to continue workflow
    return {
      status: 'completed',
      output: { humanResponse },
      stateUpdates: {
        [`humanResponse_${node.id}`]: humanResponse
      }
    };
  }
}
```

**Node Config Schema:**
```json
{
  "id": "approval",
  "type": "human",
  "name": { "en": "Review Results" },
  "config": {
    "message": { "en": "Please review and approve" },
    "options": [
      { "value": "approve", "label": { "en": "Approve" }, "style": "primary" },
      { "value": "reject", "label": { "en": "Reject" }, "style": "danger" }
    ],
    "inputSchema": {
      "type": "object",
      "properties": {
        "feedback": { "type": "string", "title": "Feedback" }
      }
    },
    "showData": ["$.research_results"]
  }
}
```

### New API Endpoints

**Added to `server/routes/workflow/workflowRoutes.js`:**

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/workflows/my-executions` | List user's workflow executions |
| POST | `/api/workflows/executions/:id/respond` | Respond to human checkpoint |

**GET /api/workflows/my-executions**
```javascript
Query: ?status=running|paused|completed|failed&limit=20&offset=0
Returns: {
  executions: [{
    executionId,
    workflowId,
    workflowName,
    status,
    startedAt,
    currentNodes,
    pendingCheckpoint
  }],
  total,
  limit,
  offset,
  runningCount
}
```

**POST /api/workflows/executions/:id/respond**
```javascript
Body: { checkpointId, response, data? }
Returns: { success: true, newStatus }
```

**Route Ordering Fix:**
The `my-executions` route MUST come BEFORE the `/:id` route to avoid Express matching `my-executions` as an ID parameter.

---

## Client-Side Implementation

### Feature Structure

```
client/src/features/workflows/
├── pages/
│   ├── WorkflowsPage.jsx       # Main page with tabs
│   ├── WorkflowListTab.jsx     # Available workflows grid
│   ├── MyExecutionsTab.jsx     # User's executions list
│   └── WorkflowExecutionPage.jsx  # Single execution view
├── components/
│   ├── WorkflowCard.jsx        # Workflow definition card
│   ├── ExecutionCard.jsx       # Execution status card
│   ├── ExecutionProgress.jsx   # Timeline visualization
│   ├── HumanCheckpoint.jsx     # Approval/input UI
│   └── StartWorkflowModal.jsx  # Configure and start
├── hooks/
│   ├── useWorkflowList.js      # Fetch available workflows
│   ├── useMyExecutions.js      # Fetch user's executions
│   └── useWorkflowExecution.js # SSE + state management
└── index.js                    # Feature exports
```

### Key Hooks

**useWorkflowExecution.js**
- Manages SSE connection with auto-reconnection
- Handles all workflow events (node.start, node.complete, human.required, etc.)
- Provides `respondToCheckpoint()` and `cancelExecution()` methods

**useMyExecutions.js**
- Fetches user's executions with filtering and pagination
- Auto-calculates `runningCount` for badge display
- Supports status filtering

### Integration Points

**App.jsx Routes:**
```jsx
<Route path="workflows" element={<WorkflowsPage />} />
<Route path="workflows/executions/:executionId" element={<WorkflowExecutionPage />} />
```

**runtimeBasePath.js:**
Added `'workflows'` to both `knownRoutes` arrays (lines ~35 and ~99).

**ui.json Navigation:**
Added "Workflows" link to header navigation.

---

## Critical Implementation Notes

### API URL Patterns

**CRITICAL:** The `apiClient` and `buildApiUrl` already include base paths. Do NOT add `/api/` prefix.

**CORRECT:**
```javascript
apiClient.get('/workflows')           // → /api/workflows
buildApiUrl('workflows/123/stream')   // → /api/workflows/123/stream
```

**WRONG (causes double /api/api/):**
```javascript
apiClient.get('/api/workflows')       // → /api/api/workflows  WRONG!
buildApiUrl('api/workflows/123/stream') // WRONG!
```

### Human Checkpoint Flow

1. `HumanNodeExecutor.execute()` returns `status: 'paused'` with checkpoint data
2. SSE event `workflow.human.required` notifies UI
3. UI displays `HumanCheckpoint` component with options and form
4. User responds via `POST /workflows/executions/:id/respond`
5. `HumanNodeExecutor.resume()` processes response
6. Workflow continues with response stored as `humanResponse_<nodeId>`

### Session Recovery

1. User starts workflow that pauses at human checkpoint
2. User closes browser
3. Workflow state persisted via `StateManager`
4. User returns, navigates to `/workflows`
5. `MyExecutionsTab` shows paused workflow
6. User clicks to join, `WorkflowExecutionPage` reconnects SSE
7. `HumanCheckpoint` component displays pending checkpoint
8. User completes checkpoint, workflow resumes

---

## Example Workflow

**File:** `contents/workflows/approval-workflow.json`

```json
{
  "id": "approval-workflow",
  "name": { "en": "Research with Approval" },
  "nodes": [
    { "id": "start", "type": "start", ... },
    {
      "id": "research",
      "type": "agent",
      "config": { "outputVariable": "research_results", ... }
    },
    {
      "id": "approval",
      "type": "human",
      "config": {
        "message": { "en": "Please review the research results" },
        "options": [
          { "value": "approve", "label": { "en": "Approve" }, "style": "primary" },
          { "value": "reject", "label": { "en": "Reject" }, "style": "danger" }
        ],
        "showData": ["$.research_results"]
      }
    },
    { "id": "decision", "type": "decision", ... },
    { "id": "summarize", "type": "agent", ... },
    { "id": "end-approved", "type": "end", ... },
    { "id": "end-rejected", "type": "end", ... }
  ],
  "edges": [...]
}
```

---

## Bugs Fixed

### 1. Double /api/api/ URL Issue
**Symptom:** `Cannot GET /api/api/workflows`
**Cause:** Client code added `/api/` prefix when `apiClient` and `buildApiUrl` already include it
**Fix:** Removed `/api/` prefix from all client API calls

### 2. 404 "Workflow not found" for my-executions
**Symptom:** GET `/api/workflows/my-executions` returns 404 with "Workflow not found"
**Cause:** Express route ordering - `/:id` route matched before `/my-executions`
**Fix:** Moved `/my-executions` route registration before `/:id` route

---

## Testing Checklist

- [ ] Navigate to `/workflows` - see two tabs
- [ ] Available Workflows tab shows workflow cards
- [ ] Click workflow card - start modal opens
- [ ] Start workflow - redirects to execution page
- [ ] Execution page shows progress
- [ ] Human checkpoint pauses workflow
- [ ] Checkpoint UI displays options and data
- [ ] Respond to checkpoint - workflow continues
- [ ] My Executions tab shows all user's workflows
- [ ] Filter executions by status
- [ ] Close browser, reopen - can rejoin paused workflow
- [ ] Cancel execution works

---

## Future Improvements

1. **Timeout handling** - Configurable timeouts for human checkpoints
2. **Email notifications** - Notify users of pending checkpoints
3. **Delegation** - Allow checkpoint response by team members
4. **History** - View past checkpoint responses
5. **Rich input** - File uploads, complex forms in checkpoints
