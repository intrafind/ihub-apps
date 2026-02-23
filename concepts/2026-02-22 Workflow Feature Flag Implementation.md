# Workflow Feature Flag Implementation

**Date:** 2026-02-22  
**Issue:** Frontend should not call workflow endpoints if feature is disabled  
**Status:** ✅ Completed

## Problem Statement

The frontend was making API calls to workflow endpoints regardless of whether the `workflows` feature was enabled in the platform configuration. This resulted in unnecessary 403 errors when the feature was disabled, as the server's `requireFeature('workflows')` middleware correctly rejected the requests.

## Root Cause

The frontend hooks and components were not checking the `workflows` feature flag before making API calls. While the server was properly protected with the `requireFeature('workflows')` middleware, the frontend would still attempt to call these endpoints, causing:

1. Unnecessary network requests
2. Console errors and user-visible error messages
3. Inconsistent user experience when features are disabled

## Solution

Implemented feature flag checks in all frontend components and hooks that interact with workflow endpoints. This follows the existing pattern used for other features (like `tools`, `sources`, etc.).

### Files Modified

#### 1. `client/src/features/workflows/hooks/useWorkflowList.js`
- Added `useFeatureFlags` hook import
- Check `workflows` feature flag before fetching workflow list
- Return empty array immediately if feature is disabled

#### 2. `client/src/features/workflows/hooks/useMyExecutions.js`
- Added `useFeatureFlags` hook import
- Check `workflows` feature flag before fetching user's executions
- Return empty array immediately if feature is disabled

#### 3. `client/src/features/workflows/hooks/useWorkflowExecution.js`
- Added `useFeatureFlags` hook import
- Check feature flag in `fetchState()` before API call
- Check feature flag in `connectSSE()` before establishing SSE connection
- Check feature flag in `respondToCheckpoint()` and `cancelExecution()` before API calls
- Return appropriate error messages when feature is disabled

#### 4. `client/src/features/chat/components/WorkflowMentionSearch.jsx`
- Added `useFeatureFlags` hook import
- Check `workflows` feature flag before fetching workflow metadata for @mention autocomplete
- Return empty array immediately if feature is disabled

#### 5. `client/src/features/chat/components/ChatInputActionsMenu.jsx`
- Added `useFeatureFlags` hook import
- Check `workflows` feature flag before fetching workflow metadata for tools menu
- Only fetch workflow details if both `hasWorkflowTools` and feature is enabled
- Updated dependency array to include `featureFlags`

#### 6. `client/src/App.jsx`
- Conditionally render workflow routes based on `workflows` feature flag
- Prevents users from navigating to `/workflows` when feature is disabled
- Consistent with other feature-gated routes (e.g., prompts library)

## Implementation Pattern

The implementation follows the established pattern for feature flag checks:

```javascript
import useFeatureFlags from '../../../shared/hooks/useFeatureFlags';

function MyComponent() {
  const featureFlags = useFeatureFlags();
  
  // Check feature flag before API call
  if (!featureFlags.isEnabled('workflows', true)) {
    // Return early or skip API call
    return;
  }
  
  // Make API call only if feature is enabled
  const response = await apiClient.get('/workflows');
}
```

## Testing

1. **Linting:** All files pass ESLint checks (only pre-existing warnings remain)
2. **Formatting:** All files pass Prettier formatting
3. **Server Startup:** Server starts successfully without errors
4. **Feature Configuration:** Workflows feature is disabled by default in `contents/config/features.json`

## Expected Behavior

### When `workflows` feature is enabled:
- All workflow-related hooks fetch data normally
- Workflow routes are accessible
- @mention workflow autocomplete works
- Workflow tools appear in chat input menu

### When `workflows` feature is disabled:
- No API calls are made to workflow endpoints
- Workflow routes are not rendered (404 if navigated to directly)
- @mention workflow autocomplete is skipped
- Workflow tools are not loaded
- No console errors or 403 responses
- Clean user experience with no visible workflow features

## Related Files

### Server-side Feature Protection
- `server/featureRegistry.js` - Contains `requireFeature()` middleware
- `server/routes/workflow/workflowRoutes.js` - Uses `requireFeature('workflows')` on all routes

### Feature Flag System
- `shared/featureFlags.js` - Core feature flag checking logic
- `client/src/shared/hooks/useFeatureFlags.js` - React hook wrapper
- `client/src/shared/contexts/PlatformConfigContext.jsx` - Builds `featuresMap` from platform config

### Configuration
- `contents/config/features.json` - Feature flags configuration (workflows: false by default)
- `server/defaults/config/features.json` - Default feature flags

## Benefits

1. **Reduced Network Traffic:** No unnecessary API calls when feature is disabled
2. **Better Performance:** Fewer HTTP requests and faster page loads
3. **Cleaner Console:** No error messages about disabled features
4. **Better UX:** No broken UI elements or failed requests visible to users
5. **Consistency:** Follows established pattern for other features (tools, sources, etc.)
6. **Maintainability:** Standard approach makes it easier to add feature flags to new features

## Future Considerations

This pattern should be applied to ALL features:
- Tools feature
- Sources feature
- Short links feature
- Any new features that can be toggled

The general principle: **If a feature can be disabled, the frontend should check the flag before making any API calls.**
