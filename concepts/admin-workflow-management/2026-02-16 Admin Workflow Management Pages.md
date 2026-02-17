# Admin Workflow Management Pages

**Date:** 2026-02-16
**Status:** Implemented
**Feature Branch:** feature/agentic-workflows

## Overview

This document describes the implementation of admin UI pages for managing workflow definitions. The implementation follows the exact same patterns used in `AdminToolsPage.jsx` and `AdminToolEditPage.jsx` for consistency.

## Files Created

1. **`client/src/features/admin/pages/AdminWorkflowsPage.jsx`** - List view with search, filter, and CRUD actions
2. **`client/src/features/admin/pages/AdminWorkflowEditPage.jsx`** - Detail/edit view with metadata form, permissions, and JSON editor

## Files Modified

1. **`client/src/features/admin/components/AdminNavigation.jsx`** - Added "Workflows" nav item in the content group
2. **`client/src/App.jsx`** - Added lazy imports and routes for the two new pages
3. **`client/src/api/adminApi.js`** - Added 7 new API functions for workflow CRUD operations
4. **`server/routes/workflow/workflowRoutes.js`** - Added `configCache.refreshWorkflowsCache()` calls after create, update, delete, and toggle operations

## Architecture

### API Endpoints Used

| Function | Method | Endpoint | Auth |
|---|---|---|---|
| `fetchAdminWorkflows` | GET | `/api/admin/workflows` | Admin |
| `fetchAdminWorkflow` | GET | `/api/workflows/:id` | Auth |
| `createAdminWorkflow` | POST | `/api/workflows` | Admin |
| `updateAdminWorkflow` | PUT | `/api/workflows/:id` | Admin |
| `deleteAdminWorkflow` | DELETE | `/api/workflows/:id` | Admin |
| `toggleAdminWorkflow` | POST | `/api/admin/workflows/:id/toggle` | Admin |
| `fetchAdminGroups` | GET | `/api/admin/groups` | Admin |

### List Page (AdminWorkflowsPage)

- Header with title, "Create New" button, and "Upload Config" button
- Search bar filtering by name, description, or ID
- Status filter dropdown (All/Enabled/Disabled)
- Table columns: Name (with icon and ID below), Version, Nodes count, Groups pills, Status badge, Actions
- Actions per row: Toggle enable/disable, Clone, Download JSON, Edit, Delete
- Clone creates a copy with `{id}-copy` suffix and "(Copy)" appended to name
- Upload validates JSON file for required fields (id, name, nodes) before POSTing

### Edit Page (AdminWorkflowEditPage)

- URL-driven: `/admin/workflows/new` for create, `/admin/workflows/:id` for edit
- **Metadata section:** ID (read-only for existing), Version, Name (EN/DE), Description, Enabled toggle
- **Permissions section:** Multi-select checkboxes for `allowedGroups`, loaded from groups API
- **JSON Editor section:** Full monospace textarea with JSON validation, yellow warning display on parse errors
- Save button disabled when JSON is invalid
- Delete button with confirmation (edit mode only)
- Back/Cancel buttons navigate to list

### Server-Side Cache Refresh

After each mutation (create, update, delete, toggle), the server calls `configCache.refreshWorkflowsCache()` to ensure the in-memory cache reflects the filesystem changes. The optional chaining (`?.`) is used for safety.

## Workflow Data Shape

Workflows are stored as individual JSON files in `contents/workflows/`. Key fields:

```json
{
  "id": "research-assistant",
  "name": { "en": "Research Assistant", "de": "Forschungsassistent" },
  "description": { "en": "...", "de": "..." },
  "version": "1.0.0",
  "enabled": true,
  "config": { "observability": "standard", "persistence": "session", ... },
  "nodes": [ { "id": "start", "type": "start", ... }, ... ],
  "edges": [ { "id": "e1", "source": "start", "target": "planner", ... } ],
  "allowedGroups": ["users", "admin"]
}
```

## How to Continue This Work

If you want to extend this feature:

1. **Add a visual node editor:** Replace or complement the JSON textarea with a drag-and-drop canvas (look at the `canvas` field in workflow JSON for positioning data)
2. **Add form-based node editing:** Create a `WorkflowFormEditor` component similar to `ToolFormEditor` for a more user-friendly editing experience
3. **Add execution history tab:** Show recent executions for a workflow on its edit page
4. **Add validation feedback:** Use the `workflowConfigSchema` (Zod) validator client-side to show inline errors

## Testing

To test these pages:

1. Enable the experimental workflows feature in `contents/config/platform.json`:
   ```json
   { "features": { "experimentalWorkflows": true } }
   ```
2. Log in as an admin user
3. Navigate to Admin > More > Workflows
4. Verify: list loads, search works, toggle/clone/download/delete actions work
5. Click "Create New" and verify the create flow with JSON editor
6. Edit an existing workflow and verify save works
