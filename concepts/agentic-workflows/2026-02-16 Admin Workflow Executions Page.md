# Admin Workflow Executions Page

**Date:** 2026-02-16
**Feature:** Admin management page for monitoring and managing workflow executions across all users

## Summary

This document describes the implementation of the Admin Workflow Executions Page, which provides administrators with a centralized view of all workflow executions across all users. The page includes filtering, search, auto-refresh polling, and the ability to cancel active executions.

## Architecture

### Files Modified

| File | Type | Description |
|------|------|-------------|
| `server/routes/workflow/workflowRoutes.js` | Server | Enhanced `GET /api/admin/workflows/executions` endpoint to support query params (status, search, pagination) |
| `client/src/api/adminApi.js` | Client API | Added `fetchAdminExecutions()` and `cancelAdminExecution()` functions |
| `client/src/App.jsx` | Client Router | Added lazy-loaded route for `admin/workflows/executions` |

### Files Created

| File | Type | Description |
|------|------|-------------|
| `client/src/features/admin/pages/AdminWorkflowExecutionsPage.jsx` | Client Page | Full admin page component |

## Server Endpoint Enhancement

### `GET /api/admin/workflows/executions`

**Before:** Only returned active executions from `workflowEngine.listActiveExecutions()`.

**After:** Supports query parameters for flexible filtering:

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `status` | string | (none) | Filter by status: `all`, `running`, `paused`, `completed`, `failed`, `cancelled` |
| `search` | string | (none) | Search in userId, workflowName, workflowId |
| `limit` | number | 100 | Maximum results |
| `offset` | number | 0 | Skip results for pagination |

**Response format:**
```json
{
  "executions": [...],
  "total": 42,
  "stats": {
    "totalExecutions": 42,
    "totalUsers": 5,
    "byStatus": {
      "running": 2,
      "completed": 35,
      "failed": 3,
      "cancelled": 2
    }
  },
  "offset": 0,
  "limit": 100
}
```

The endpoint reads directly from the `ExecutionRegistry` singleton (which persists data to disk and tracks all executions, not just active ones). When no `status` parameter is provided, it falls back to the original behavior of returning only active executions from the WorkflowEngine's state manager.

## Client Page Features

### URL
`/admin/workflows/executions`

### Auto-Refresh
- Toggle switch in the header (default: ON)
- Polls every 5 seconds when enabled
- Uses `setInterval` with `useRef` for cleanup
- Background refresh does not show the loading spinner

### Stats Summary
- Clickable status cards at the top showing counts per status
- Clicking a card filters the table to that status (click again to clear filter)
- Color-coded: green=completed, blue=running, yellow=paused, red=failed, gray=cancelled, purple=pending

### Filter Bar
- Text search field (searches by user or workflow name)
- Status dropdown filter (All, Running, Paused, Completed, Failed, Cancelled)

### Table Columns
1. **Execution ID** - First 16 characters, monospace font
2. **Workflow** - Localized workflow name + workflow ID
3. **User** - User ID
4. **Status** - Color-coded badge with animated pulse for running
5. **Started At** - Localized datetime
6. **Duration** - Computed from startedAt to completedAt (or now if active)
7. **Current Node** - Monospace, or dash if none
8. **Actions** - View/Inspect button and Cancel button (for running/paused only)

### Actions
- **View/Inspect**: Navigates to `/workflows/executions/:id` (existing execution detail page)
- **Cancel**: `POST /api/workflows/executions/:id/cancel` with confirmation dialog. Only shown for running/paused executions.

### Dark Mode
All styles include dark mode variants using `dark:` Tailwind prefix.

### Internationalization
All user-facing strings use `t()` with the `admin.workflowExecutions.*` key namespace.

## Route Placement

The route `admin/workflows/executions` is placed BEFORE `admin/workflows/:id` in the React Router configuration to prevent the `:id` parameter from catching "executions" as a workflow ID.

Route order:
1. `admin/workflows` - List page
2. `admin/workflows/new` - Create page
3. `admin/workflows/executions` - **This page**
4. `admin/workflows/:id` - Edit page (catch-all for IDs)

## How to Continue

If you need to extend this page:

1. **Add pagination controls**: The API already supports `limit` and `offset`. Add a pagination UI at the bottom of the table.
2. **Add bulk actions**: Select multiple executions and cancel them all.
3. **Add export**: Download execution data as CSV/JSON.
4. **Add detailed stats**: Show execution trends over time using the stats data.

## Testing

1. Navigate to `/admin/workflows/executions`
2. Verify the table loads with all executions
3. Test the status filter dropdown
4. Test the search field (search by user ID or workflow name)
5. Toggle auto-refresh off and verify polling stops
6. Start a workflow and verify it appears in the list within 5 seconds
7. Cancel a running execution and verify the status updates
8. Click on an execution row to verify navigation to the detail page
