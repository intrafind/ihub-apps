# Workflow API Routes Implementation

**Date:** 2026-02-06
**Author:** Claude Opus 4.5
**Component:** Agentic Workflow System - API Routes

## Overview

This document describes the implementation of the Workflow API Routes for the agentic workflow system. These routes provide RESTful endpoints for managing and executing workflows, including real-time progress streaming via Server-Sent Events (SSE).

## File Location

```
/Users/danielmanzke/Workspaces/github.intrafind/ihub-apps/server/routes/workflow/workflowRoutes.js
```

## Architecture

### Module Structure

```
server/routes/workflow/
  index.js           - Module exports
  workflowRoutes.js  - Main route implementations
```

### Dependencies

The workflow routes depend on:

- **WorkflowEngine** (`services/workflow/WorkflowEngine.js`) - Workflow execution orchestration
- **actionTracker** (`actionTracker.js`) - Event emission for SSE streaming
- **workflowConfigSchema** (`validators/workflowConfigSchema.js`) - Schema validation
- **authRequired/adminAuth** - Authentication middleware
- **atomicWriteJSON** - Safe file writing

## API Endpoints

### Workflow Definition Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/workflows` | Required | List accessible workflows (filtered by permissions) |
| GET | `/api/workflows/:id` | Required | Get single workflow definition |
| POST | `/api/workflows` | Admin | Create new workflow |
| PUT | `/api/workflows/:id` | Admin | Update existing workflow |
| DELETE | `/api/workflows/:id` | Admin | Delete workflow |

### Workflow Execution Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/workflows/:id/execute` | Required | Start workflow execution |
| GET | `/api/workflows/executions/:executionId` | Required | Get execution state |
| POST | `/api/workflows/executions/:executionId/resume` | Required | Resume paused workflow |
| POST | `/api/workflows/executions/:executionId/cancel` | Required | Cancel execution |

### SSE Streaming Endpoint

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/workflows/executions/:executionId/stream` | Required | Real-time progress events |

### Admin Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/admin/workflows` | Admin | List all workflows (including disabled) |
| POST | `/api/admin/workflows/:id/toggle` | Admin | Toggle enabled/disabled status |
| GET | `/api/admin/workflows/executions` | Admin | List all active executions |

## Permission Model

### Workflow Access Control

Workflows support group-based access control through the `allowedGroups` property:

```javascript
{
  "id": "customer-support-workflow",
  "allowedGroups": ["support-team", "managers"]
}
```

**Access Rules:**
1. Workflows without `allowedGroups` are accessible to all authenticated users
2. Workflows with `allowedGroups` are only shown to users in those groups
3. Admin users (with `adminAccess: true` or in `admin` group) can see all workflows

### Filter Implementation

```javascript
function filterByPermissions(workflows, user) {
  return workflows.filter(workflow => {
    // Public workflow (no restrictions)
    if (!workflow.allowedGroups || workflow.allowedGroups.length === 0) {
      return true;
    }

    // Admin override
    if (user?.groups?.includes('admin') || user?.permissions?.adminAccess) {
      return true;
    }

    // Group membership check
    return workflow.allowedGroups.some(group => user.groups?.includes(group));
  });
}
```

## File Storage

### Workflow Files

Workflows are stored as individual JSON files in:
```
contents/workflows/{workflow-id}.json
```

### Directory Auto-Creation

The routes automatically create the workflows directory if it doesn't exist:
```javascript
await fs.mkdir(workflowsDir, { recursive: true });
```

### Atomic File Operations

All file writes use `atomicWriteJSON` to prevent data corruption:
```javascript
await atomicWriteJSON(workflowPath, validatedWorkflow);
```

## SSE Event Streaming

### Connection Setup

```javascript
app.get('/api/workflows/executions/:executionId/stream', authRequired, (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Register for events
  actionTracker.on('fire-sse', handleWorkflowEvent);
});
```

### Supported Events

| Event | Description |
|-------|-------------|
| `workflow.start` | Workflow execution started |
| `workflow.node.start` | Node execution started |
| `workflow.node.complete` | Node execution completed |
| `workflow.node.error` | Node execution failed |
| `workflow.paused` | Workflow paused (e.g., for human input) |
| `workflow.complete` | Workflow completed successfully |
| `workflow.failed` | Workflow execution failed |
| `workflow.cancelled` | Workflow was cancelled |
| `workflow.checkpoint.saved` | Checkpoint was saved |

### Event Filtering

Events are filtered by execution ID:
```javascript
const handleWorkflowEvent = (eventData) => {
  if (eventData.executionId !== executionId && eventData.chatId !== executionId) {
    return; // Skip events for other executions
  }
  res.write(`event: ${eventData.event}\ndata: ${JSON.stringify(eventData)}\n\n`);
};
```

### Heartbeat

A 30-second heartbeat keeps connections alive:
```javascript
const heartbeatInterval = setInterval(() => {
  res.write(`: heartbeat\n\n`);
}, 30000);
```

## Validation

### Schema Validation

All workflow definitions are validated against the Zod schema:
```javascript
function validateWorkflow(workflow) {
  const result = workflowConfigSchema.safeParse(workflow);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.errors.map(err => ({
      path: err.path.join('.'),
      message: err.message
    }))
  };
}
```

### Path Security

Workflow IDs are validated to prevent path traversal attacks:
```javascript
if (!validateIdForPath(id, 'workflow', res)) {
  return; // Response already sent with 400 error
}
```

## Error Handling

### Specific Error Codes

The routes handle specific workflow engine errors:
- `WORKFLOW_CYCLE_DETECTED` - Workflow graph contains cycles
- `WORKFLOW_NO_START_NODE` - No start node defined
- `EXECUTION_NOT_FOUND` - Execution ID not found
- `INVALID_STATE_FOR_RESUME` - Cannot resume from current state
- `WORKFLOW_NOT_AVAILABLE` - Workflow definition not available for resume

### Response Helpers

Standard response helpers are used for consistency:
```javascript
sendNotFound(res, 'Workflow');
sendBadRequest(res, 'Invalid workflow definition', errors);
sendFailedOperationError(res, 'create workflow', error);
sendInsufficientPermissions(res, 'workflow execution');
```

## Usage Examples

### Starting a Workflow

```javascript
// POST /api/workflows/customer-support/execute
{
  "initialData": {
    "customerId": "cust-123",
    "issue": "Order not delivered"
  },
  "options": {
    "checkpointOnNode": true
  }
}

// Response
{
  "executionId": "wf-exec-abc123",
  "status": "pending",
  "workflowId": "customer-support",
  "startedAt": "2026-02-06T10:30:00Z"
}
```

### Streaming Progress

```javascript
// Client-side EventSource
const eventSource = new EventSource(
  '/api/workflows/executions/wf-exec-abc123/stream',
  { withCredentials: true }
);

eventSource.addEventListener('workflow.node.complete', (event) => {
  const data = JSON.parse(event.data);
  console.log(`Node ${data.nodeId} completed`);
});

eventSource.addEventListener('workflow.complete', (event) => {
  console.log('Workflow completed!');
  eventSource.close();
});
```

### Resuming After Human Input

```javascript
// POST /api/workflows/executions/wf-exec-abc123/resume
{
  "humanResponse": {
    "approved": true,
    "comment": "Approved for processing"
  }
}
```

## Integration Points

### Server Registration

To register the workflow routes with your Express app:

```javascript
import { registerWorkflowRoutes } from './routes/workflow/index.js';

// In your server setup
registerWorkflowRoutes(app, { basePath: '' });
```

### Custom Workflow Engine

You can provide a custom workflow engine instance:

```javascript
const customEngine = new WorkflowEngine({
  stateManager: customStateManager,
  defaultTimeout: 60000
});

registerWorkflowRoutes(app, {
  workflowEngine: customEngine
});
```

## Testing

### Exported Test Helpers

The module exports helper functions for testing:

```javascript
import {
  filterByPermissions,
  isAdmin,
  loadWorkflows,
  findWorkflowFile,
  validateWorkflow
} from './workflowRoutes.js';
```

### Test Scenarios

1. **Permission filtering** - Test that workflows are filtered correctly based on user groups
2. **Schema validation** - Test that invalid workflows are rejected
3. **CRUD operations** - Test create, read, update, delete operations
4. **Execution lifecycle** - Test start, monitor, resume, cancel operations
5. **SSE streaming** - Test event delivery and connection management

## Security Considerations

1. **Authentication** - All endpoints require authentication
2. **Authorization** - Admin endpoints require admin privileges
3. **Path traversal** - Workflow IDs are validated to prevent path traversal
4. **Input validation** - All input is validated against schemas
5. **Atomic writes** - File operations use atomic writes to prevent corruption

## Future Enhancements

1. **Pagination** - Add pagination for workflow and execution lists
2. **Search/Filter** - Add search and filtering capabilities
3. **Audit logging** - Add detailed audit logs for workflow operations
4. **Rate limiting** - Add rate limiting for execution endpoints
5. **Batch operations** - Add batch enable/disable for workflows
