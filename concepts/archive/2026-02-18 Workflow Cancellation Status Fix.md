# Workflow Cancellation Status Fix

**Date**: 2026-02-18  
**Issue**: Workflow cancelled did not lead to cancelling in the chat  
**Status**: Fixed

## Problem Description

When a workflow gets cancelled, the chat interface continues showing it as "operating" (running) instead of showing it was cancelled. The workflow cancellation event was not properly recognized by the chat UI.

## Root Cause

### Server Side (`server/tools/workflowRunner.js`)

At line 336-378, the code properly detected both `workflow.failed` and `workflow.cancelled` events, but when tracking the result to the chat, it always sent `status: 'failed'` regardless of whether the workflow was cancelled or failed:

```javascript
if ((eventType === 'workflow.failed' || eventType === 'workflow.cancelled') && !settled) {
  // ... cleanup code ...
  
  actionTracker.trackWorkflowResult(chatId, {
    workflowName,
    status: 'failed',  // ❌ Always 'failed', even when cancelled
    error: errorMsg,
    executionId
  });
}
```

### Client Side (`client/src/features/chat/components/WorkflowStepIndicator.jsx`)

At line 99-125, the component only checked for `'failed'` status and didn't handle `'cancelled'` status separately:

```javascript
if (result) {
  const isFailed = result.status === 'failed';  // ❌ Only checks for 'failed'
  
  return (
    <div>
      <Icon name={isFailed ? 'exclamation-circle' : 'cog'} />
      <span>
        {isFailed ? t('workflow.failed', 'Failed') : t('workflow.generated', 'Generated')}
      </span>
    </div>
  );
}
```

## Solution

### Server Changes

Updated `server/tools/workflowRunner.js` to:
1. Determine if the event is cancelled or failed
2. Send the correct status (`'cancelled'` vs `'failed'`) to the chat
3. Use appropriate error messages and finish reasons

```javascript
if ((eventType === 'workflow.failed' || eventType === 'workflow.cancelled') && !settled) {
  const isCancelled = eventType === 'workflow.cancelled';
  const finalStatus = isCancelled ? 'cancelled' : 'failed';
  
  actionTracker.trackWorkflowResult(chatId, {
    workflowName,
    status: finalStatus,  // ✅ Correct status based on event type
    error: errorMsg,
    executionId
  });
  
  // Also send correct finish reason
  actionTracker.trackDone(chatId, { 
    finishReason: isCancelled ? 'cancelled' : 'error' 
  });
}
```

### Client Changes

Updated `client/src/features/chat/components/WorkflowStepIndicator.jsx` to:
1. Check for both `'failed'` and `'cancelled'` statuses
2. Show appropriate icon and message for each status
3. Use orange color for cancelled (vs red for failed)

```javascript
if (result) {
  const isFailed = result.status === 'failed';
  const isCancelled = result.status === 'cancelled';
  
  let iconName = 'cog';
  let iconColor = '';
  let statusText = t('workflow.generated', 'Generated');
  
  if (isFailed) {
    iconName = 'exclamation-circle';
    iconColor = 'text-red-500';
    statusText = t('workflow.failed', 'Failed');
  } else if (isCancelled) {
    iconName = 'x-circle';
    iconColor = 'text-orange-500';
    statusText = t('workflow.cancelled', 'Cancelled');  // ✅ New status
  }
  // ... render with appropriate icon/message
}
```

### Translation Updates

Added workflow translations to both `shared/i18n/en.json` and `shared/i18n/de.json`:

**English** (`en.json`):
```json
{
  "workflow": {
    "running": "Running workflow...",
    "unknownStep": "Step",
    "generated": "Generated",
    "failed": "Failed",
    "cancelled": "Cancelled"
  }
}
```

**German** (`de.json`):
```json
{
  "workflow": {
    "running": "Workflow läuft...",
    "unknownStep": "Schritt",
    "generated": "Generiert",
    "failed": "Fehlgeschlagen",
    "cancelled": "Abgebrochen"
  }
}
```

### Additional Changes

Updated `client/src/features/chat/hooks/useAppChat.js` to properly handle cancelled status when updating step status. When a workflow is cancelled, running steps are marked as completed (not error).

## Testing

### Manual Test Procedure

1. Start a workflow in the chat interface
2. While the workflow is running, cancel it
3. Verify the chat shows "Cancelled via [workflow-name]" with an orange x-circle icon
4. Verify the workflow no longer shows as "operating" or running

### Expected Behavior

- **Before Fix**: Cancelled workflow shows as "Failed via [workflow-name]" with red error icon
- **After Fix**: Cancelled workflow shows as "Cancelled via [workflow-name]" with orange x-circle icon

### Visual Indicators

| Status | Icon | Color | Message |
|--------|------|-------|---------|
| Completed | `cog` | Default | "Generated via [workflow-name]" |
| Failed | `exclamation-circle` | Red | "Failed via [workflow-name]" |
| Cancelled | `x-circle` | Orange | "Cancelled via [workflow-name]" |

## Files Modified

1. `server/tools/workflowRunner.js` - Server-side status tracking
2. `client/src/features/chat/components/WorkflowStepIndicator.jsx` - UI status display
3. `client/src/features/chat/hooks/useAppChat.js` - Step status updates
4. `shared/i18n/en.json` - English translations
5. `shared/i18n/de.json` - German translations

## Impact

- **Minimal**: Changes are surgical and focused only on workflow cancellation handling
- **Backward Compatible**: Existing workflows continue to work unchanged
- **User Experience**: Users now see clear distinction between failed and cancelled workflows

## Related Code

The workflow cancellation flow:
1. `WorkflowEngine.cancel()` emits `workflow.cancelled` event
2. `workflowRunner.js` listens for event and tracks result with `'cancelled'` status
3. `useAppChat.js` receives SSE event and updates message with cancelled result
4. `WorkflowStepIndicator.jsx` renders cancelled state with appropriate UI

## Future Improvements

- Consider adding a reason/message field for why workflow was cancelled
- Add user feedback when cancellation is successful
- Display cancellation timestamp in workflow history
