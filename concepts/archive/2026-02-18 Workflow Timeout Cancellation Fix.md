# Workflow Timeout Cancellation Fix

**Date:** 2026-02-18  
**Issue:** Workflow timeouts were incorrectly logged as "user_cancelled" instead of "timeout"  
**Status:** Fixed

## Problem

When workflows timed out, the log message showed:
```json
{
  "component": "WorkflowEngine",
  "level": "info",
  "timestamp": "2026-02-18T20:30:31.683Z",
  "message": "Cancelling workflow execution",
  "executionId": "wf-exec-5c608eda-bfc4-4ab1-9183-7ffe3eb85e69",
  "reason": "user_cancelled"
}
```

However, the user had not manually cancelled the workflow - it timed out automatically. This made debugging difficult as timeouts appeared as user actions.

## Root Cause

The issue was in `/server/tools/workflowRunner.js` at line 391:

```javascript
// Timeout safety net
timeoutId = setTimeout(() => {
  if (!settled) {
    settled = true;
    actionTracker.off('fire-sse', bridgeHandler);
    activeWorkflowExecutions.delete(chatId);

    // Attempt to cancel the workflow
    engine.cancel(executionId).catch(() => {});  // ❌ No reason parameter
    // ...
  }
}, maxExecutionTime);
```

The `WorkflowEngine.cancel()` method has a default parameter:

```javascript
async cancel(executionId, reason = 'user_cancelled') {
  // ...
}
```

When `engine.cancel(executionId)` was called without a reason parameter, it defaulted to `'user_cancelled'` instead of indicating a timeout.

## Solution

Changed line 391 in `/server/tools/workflowRunner.js` to explicitly pass 'timeout' as the cancellation reason:

```javascript
// Attempt to cancel the workflow with timeout reason
engine.cancel(executionId, 'timeout').catch(() => {});  // ✅ Passes 'timeout' reason
```

## Impact

- **Before:** Timeout cancellations logged as `reason: "user_cancelled"`
- **After:** Timeout cancellations logged as `reason: "timeout"`

This makes it clear in logs and audit trails whether a workflow was cancelled by user action or by an automatic timeout.

## Testing

Verified that:
1. The linting passes with the change
2. Other call sites of `cancel()` already pass appropriate reasons:
   - `/server/routes/chat/sessionRoutes.js:538` - passes `'user_cancelled'` (correct, triggered by user stopping chat)
   - `/server/routes/workflow/workflowRoutes.js:1097` - accepts reason from request body, defaults to `'user_cancelled'` (correct, API endpoint)

## Related Files

- `/server/tools/workflowRunner.js` - Fixed to pass 'timeout' reason
- `/server/services/workflow/WorkflowEngine.js` - Defines cancel() method with reason parameter
- `/server/routes/chat/sessionRoutes.js` - Already correctly passes 'user_cancelled'
- `/server/routes/workflow/workflowRoutes.js` - Already correctly handles reason parameter

## Configuration

The timeout duration is configured per workflow:
```javascript
const maxExecutionTime = (workflow.config?.maxExecutionTime || 300000) + 10000;
```

Default: 300 seconds (5 minutes) + 10 second buffer = 310 seconds total

## Future Considerations

Potential additional cancellation reasons that could be added in the future:
- `'error'` - for unrecoverable errors
- `'resource_limit'` - for memory/CPU constraints
- `'dependency_failure'` - for external service failures
- `'manual_admin'` - for administrator-initiated cancellations

These would provide even more granular debugging information in workflow execution logs.
