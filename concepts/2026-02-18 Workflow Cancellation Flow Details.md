# Workflow Cancellation Flow - Technical Details

## Event Flow Diagram

```
User Clicks Cancel
       ↓
POST /api/chat/:chatId/stop
       ↓
sessionRoutes.js: Cancel workflow via engine
       ↓
workflowEngine.cancel(executionId)
       ↓
Engine emits 'workflow.cancelled' event
       ↓
workflowRunner.js: bridgeHandler receives event
       ↓
       ├─→ Clean up resources
       ├─→ Update execution registry
       └─→ Track result: status='cancelled'
       ↓
actionTracker.trackWorkflowResult(chatId, {
  status: 'cancelled',  // ← KEY FIX HERE
  workflowName,
  executionId
})
       ↓
SSE sent to client: type='workflow.result'
       ↓
useAppChat.js: Receives SSE event
       ↓
Updates message with workflowResult: {
  status: 'cancelled',
  executionId,
  workflowName
}
       ↓
WorkflowStepIndicator.jsx: Renders UI
       ↓
Displays: "Cancelled via [workflow-name]"
Icon: x-circle (orange)
```

## Code Path Details

### 1. User Initiates Cancellation

**File**: `client/src/features/chat/pages/AppChat.jsx` (or chat component)
- User clicks stop/cancel button
- Calls `stopChatStream()` API

### 2. Server Receives Cancellation Request

**File**: `server/routes/chat/sessionRoutes.js`
```javascript
router.post('/:chatId/stop', async (req, res) => {
  const { chatId } = req.params;
  
  // Find active workflow
  const workflowExec = activeWorkflowExecutions.get(chatId);
  if (workflowExec) {
    // Cancel workflow execution
    await workflowExec.engine.cancel(
      workflowExec.executionId, 
      'user_cancelled'
    );
  }
  // ...
});
```

### 3. Workflow Engine Cancels Execution

**File**: `server/services/workflow/WorkflowEngine.js`
```javascript
async cancel(executionId, reason = 'user_cancelled') {
  // Abort any running node
  const abortController = this.abortControllers.get(executionId);
  if (abortController) {
    abortController.abort();
  }
  
  // Update state to cancelled
  await this.stateManager.update(executionId, {
    status: WorkflowStatus.CANCELLED,
    completedAt: new Date().toISOString()
  });
  
  // Emit cancelled event ← CRITICAL EVENT
  this._emitEvent('workflow.cancelled', {
    executionId,
    reason
  });
}
```

### 4. Workflow Runner Receives Event

**File**: `server/tools/workflowRunner.js`
```javascript
const bridgeHandler = event => {
  if (event.chatId !== executionId) return;
  
  const eventType = event.event;
  
  // Handle cancellation
  if ((eventType === 'workflow.failed' || 
       eventType === 'workflow.cancelled') && !settled) {
    
    // ✅ KEY FIX: Determine actual status
    const isCancelled = eventType === 'workflow.cancelled';
    const finalStatus = isCancelled ? 'cancelled' : 'failed';
    
    // Track result with correct status
    actionTracker.trackWorkflowResult(chatId, {
      workflowName,
      status: finalStatus,  // ← Sends 'cancelled' when cancelled
      error: errorMsg,
      executionId
    });
  }
};
```

### 5. Action Tracker Sends SSE

**File**: `server/services/ActionTracker.js`
```javascript
trackWorkflowResult(chatId, data) {
  this.emit('fire-sse', {
    chatId,
    type: 'workflow.result',
    data: {
      status: data.status,        // ← 'cancelled'
      workflowName: data.workflowName,
      executionId: data.executionId,
      error: data.error
    }
  });
}
```

### 6. Client Receives SSE Event

**File**: `client/src/features/chat/hooks/useAppChat.js`
```javascript
case 'workflow.result':
  if (lastMessageIdRef.current && data) {
    // Update message with workflow result
    updateAssistantMessage(lastMessageIdRef.current, fullContent, true, {
      workflowStep: null,
      workflowSteps: finalSteps,
      workflowResult: {
        status: data.status,      // ← 'cancelled'
        executionId: data.executionId,
        workflowName: data.workflowName
      }
    });
  }
  break;
```

### 7. UI Component Renders Cancelled State

**File**: `client/src/features/chat/components/WorkflowStepIndicator.jsx`
```javascript
if (result) {
  const isCancelled = result.status === 'cancelled';
  
  if (isCancelled) {
    iconName = 'x-circle';
    iconColor = 'text-orange-500';
    statusText = t('workflow.cancelled', 'Cancelled');
  }
  
  return (
    <div>
      <Icon name={iconName} className={iconColor} />
      <span>{statusText} via {workflowName}</span>
    </div>
  );
}
```

## State Transitions

### Workflow Execution States

```
                                    ┌──────────┐
                                    │  Queued  │
                                    └────┬─────┘
                                         │
                                         ↓
                                    ┌──────────┐
                       ┌───────────→│ Running  │◄─────────┐
                       │            └────┬─────┘          │
                       │                 │                │
                       │                 ↓                │
               ┌───────┴─────┐      ┌──────────┐    ┌────┴──────┐
               │  Cancelled  │      │  Paused  │───→│ Resumed   │
               └─────────────┘      └──────────┘    └───────────┘
                                         │
                ┌────────────────────────┼────────────────┐
                ↓                        ↓                ↓
          ┌──────────┐            ┌──────────┐    ┌──────────┐
          │  Failed  │            │Completed │    │ Rejected │
          └──────────┘            └──────────┘    └──────────┘
```

### Chat UI States

```
Before Fix:
  workflow.cancelled → status='failed' → UI shows "Failed"

After Fix:
  workflow.cancelled → status='cancelled' → UI shows "Cancelled"
```

## Key Changes Summary

| Component | Before | After |
|-----------|--------|-------|
| **workflowRunner.js** | Always sends `status: 'failed'` | Sends `status: 'cancelled'` when workflow is cancelled |
| **WorkflowStepIndicator** | Only handles `'failed'` status | Handles both `'failed'` and `'cancelled'` statuses |
| **Finish Reason** | Always `'error'` | `'cancelled'` when cancelled, `'error'` when failed |
| **Error Message** | Always "Workflow failed: ..." | "Workflow cancelled: ..." when cancelled |

## Testing Checklist

- [x] Server correctly emits 'workflow.cancelled' event
- [x] workflowRunner sends correct status to chat
- [x] Client receives and processes cancelled status
- [x] UI displays correct icon and message for cancelled workflow
- [x] Translations work in both English and German
- [ ] Manual testing: Cancel a running workflow and verify UI
- [ ] Manual testing: Verify failed workflow still shows correctly
- [ ] Manual testing: Verify completed workflow still shows correctly

## Related Files

- `server/services/workflow/WorkflowEngine.js` - Emits cancellation event
- `server/tools/workflowRunner.js` - Handles cancellation event
- `server/services/ActionTracker.js` - Tracks workflow results
- `client/src/features/chat/hooks/useAppChat.js` - Receives SSE events
- `client/src/features/chat/components/WorkflowStepIndicator.jsx` - Renders UI
- `shared/i18n/en.json` & `de.json` - Translations
