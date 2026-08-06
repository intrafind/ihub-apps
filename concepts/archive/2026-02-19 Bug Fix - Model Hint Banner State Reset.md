# Bug Fix: Model Hint Banner Not Reappearing After Model Switch

## Issue Description

When switching between models with hints, the alert banner would not reappear after being acknowledged. This occurred when:

1. User selects alert model → sees banner
2. User acknowledges alert → banner disappears
3. User switches to different model (e.g., hint model)
4. User switches back to alert model → banner does NOT reappear
5. Input remains disabled but user cannot acknowledge

## Root Cause

The `ModelHintBanner` component maintains its own internal state for `isAcknowledged`:

```javascript
const [isAcknowledged, setIsAcknowledged] = useState(false);
```

When the component renders, it checks this state:

```javascript
if (!hint || isDismissed || (hint.level === 'alert' && isAcknowledged)) {
  return null;  // Hides the banner
}
```

**The Problem**: React was reusing the same component instance when switching back to a model. The component's internal `isAcknowledged` state persisted across model changes, causing the banner to remain hidden even though the parent component reset its `modelAlertAcknowledged` state.

## The Fix

Added a `key` prop to the `ModelHintBanner` component that changes when the selected model changes:

```javascript
<ModelHintBanner
  key={selectedModel} // Forces new component instance on model change
  hint={selectedModelData.hint}
  currentLanguage={currentLanguage}
  onAcknowledge={() => setModelAlertAcknowledged(true)}
/>
```

**Why This Works**: When the `key` prop changes, React destroys the old component instance and creates a completely new one with fresh state. This ensures:
- `isAcknowledged` resets to `false`
- `isDismissed` resets to `false`
- The banner reappears with all original behavior

## Testing the Fix

To verify the fix works:

1. Select an alert model (e.g., "Experimental Model")
2. Banner appears, input is disabled
3. Click "I Understand" button
4. Banner disappears, input is enabled
5. Switch to different model (e.g., "GPT-4 Turbo Hint")
6. Different hint appears
7. Switch back to alert model
8. **Expected**: Alert banner reappears, input is disabled
9. Click "I Understand" again
10. **Expected**: Banner disappears, input is enabled

## Alternative Solutions Considered

1. **Lift state to parent**: Move `isAcknowledged` state to `ChatInput` component
   - Rejected: More complex, requires more props

2. **useEffect to reset state**: Add effect to reset internal state when hint changes
   - Rejected: Less React-idiomatic than using key prop

3. **Key prop based on model ID**: ✅ Selected
   - Cleanest solution
   - Follows React best practices
   - No additional props needed

## File Changed

- `client/src/features/chat/components/ChatInput.jsx` (line 348)

## Commit

Short hash: [to be filled after commit]
