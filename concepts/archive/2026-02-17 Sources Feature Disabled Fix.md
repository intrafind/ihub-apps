# Fix: Sources Feature Disabled Breaks App Editing

**Date:** 2026-02-17  
**Issue:** If the sources feature is disabled, apps can't be edited anymore  
**Status:** ✅ Fixed

## Problem Description

When the sources feature was disabled in the platform configuration:
1. The `/api/admin/sources` endpoint would return a `403 Forbidden` error with code `FEATURE_DISABLED`
2. The `SourcePicker` component in the app editor would fail to load sources
3. This caused an error state that made the entire app editing form unusable
4. Users could not edit any app configuration when sources was disabled

### Root Cause

The issue occurred because:
- The `SourcePicker` component always tried to fetch sources from `/api/admin/sources` on mount
- When the sources feature was disabled, the `requireFeature('sources')` middleware returned a 403 error
- The `SourcePicker` treated all errors the same way, showing a generic error message
- The error prevented the component from rendering properly, breaking the parent form

## Solution

The fix involved two key changes:

### 1. SourcePicker Component Enhancement

**File:** `client/src/features/admin/components/SourcePicker.jsx`

**Changes:**
- Added `featureDisabled` state to track when the sources feature is disabled
- Modified `loadAdminSources()` to detect 403 errors with the `FEATURE_DISABLED` code
- When feature is disabled, the component returns `null` instead of showing an error
- This allows the component to gracefully handle the disabled state

**Code snippet:**
```javascript
const [featureDisabled, setFeatureDisabled] = useState(false);

const loadAdminSources = async () => {
  try {
    // ... fetch sources
  } catch (err) {
    // Check if this is a feature disabled error (403 with FEATURE_DISABLED code)
    if (err.response?.status === 403 && err.response?.data?.code === 'FEATURE_DISABLED') {
      console.log('Sources feature is disabled');
      setFeatureDisabled(true);
      setError(null); // Don't show error, just hide the component
    } else {
      setError('Failed to load available sources. Please try again.');
    }
  }
};

// Return null when feature is disabled
if (featureDisabled) {
  return null;
}
```

### 2. AppFormEditor Component Enhancement

**File:** `client/src/features/admin/components/AppFormEditor.jsx`

**Changes:**
- Imported `usePlatformConfig` hook to access the platform configuration
- Added `isSourcesEnabled` check using `platformConfig.featuresMap.sources`
- Wrapped the entire "Sources Configuration" section with conditional rendering
- The section only displays when the sources feature is enabled

**Code snippet:**
```javascript
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';

const AppFormEditor = ({ /* props */ }) => {
  const { platformConfig } = usePlatformConfig();
  
  // Check if sources feature is enabled
  const isSourcesEnabled = platformConfig?.featuresMap?.sources ?? true;

  return (
    {/* ... other sections ... */}
    
    {/* Sources Configuration - Only show if sources feature is enabled */}
    {isSourcesEnabled && (
      <div className="bg-white shadow px-4 py-5 sm:rounded-lg sm:p-6">
        {/* Sources configuration UI */}
      </div>
    )}
  );
};
```

## Technical Details

### Feature Flag System

The platform uses a centralized feature registry system:
- **Server:** `server/featureRegistry.js` defines all available features
- **Middleware:** `requireFeature(featureId)` middleware protects routes behind feature flags
- **Client:** `PlatformConfigContext` provides `featuresMap` for checking enabled features
- **Error Response:** 403 status with `{ code: 'FEATURE_DISABLED' }` when feature is off

### Error Handling Flow

When sources feature is disabled:
1. Client attempts to fetch `/api/admin/sources`
2. Server middleware detects feature is disabled
3. Server returns `403` with `{ error: "Feature 'sources' is not enabled", code: "FEATURE_DISABLED" }`
4. Client detects the specific error code and handles it gracefully
5. SourcePicker returns `null` (hidden)
6. AppFormEditor conditionally hides the sources section

### Backward Compatibility

- Default behavior: If `featuresMap.sources` is undefined, defaults to `true` (enabled)
- Existing apps with sources configured continue to work
- When sources is re-enabled, the section reappears without data loss
- No breaking changes to existing functionality

## Testing

### Test Scenarios

1. **Sources Enabled (Default)**
   - ✅ Sources section visible in app editor
   - ✅ SourcePicker loads and displays available sources
   - ✅ Can select and configure sources for apps

2. **Sources Disabled**
   - ✅ Sources section hidden in app editor
   - ✅ No 403 error displayed to user
   - ✅ App editor remains fully functional
   - ✅ Can edit all other app settings without issues

3. **Feature Toggle**
   - ✅ Disabling sources hides the section
   - ✅ Re-enabling sources shows the section again
   - ✅ Existing source configurations preserved

### Test Configuration

To test with sources disabled, create `contents/config/features.json`:
```json
{
  "sources": false,
  "tools": true,
  "usageTracking": true,
  "promptsLibrary": true
}
```

## Benefits

1. **Graceful Degradation:** Feature can be disabled without breaking the admin interface
2. **Better UX:** No confusing error messages when feature is intentionally disabled
3. **Cleaner UI:** Hidden sections don't clutter the interface when not needed
4. **Maintainable:** Follows the established feature flag pattern throughout the codebase
5. **Reusable Pattern:** Can be applied to other feature-gated components

## Related Files

- `client/src/features/admin/components/SourcePicker.jsx` - Component that loads sources
- `client/src/features/admin/components/AppFormEditor.jsx` - Main app configuration form
- `client/src/shared/contexts/PlatformConfigContext.jsx` - Platform config provider
- `server/featureRegistry.js` - Feature flag registry and middleware
- `server/routes/admin/sources.js` - Sources API endpoints with feature middleware

## Future Improvements

Potential enhancements for the feature flag system:
1. Add loading state while checking feature flags
2. Create a reusable `<FeatureGate>` component for cleaner conditional rendering
3. Add visual indicator in admin UI showing which features are enabled/disabled
4. Implement feature-dependent field validation in app schemas
5. Add tooltips explaining why certain sections are hidden

## Conclusion

This fix ensures that the app editing interface remains functional regardless of which features are enabled or disabled. It follows the principle of graceful degradation and maintains a clean, intuitive user experience.
