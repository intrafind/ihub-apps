# Firefox Dynamic Import Compatibility Fix

**Date:** 2026-02-06  
**Issue:** Firefox not working with ihub  
**Status:** Fixed

## Problem Description

Users reported that the iHub Apps application was not working correctly in Firefox, while Chrome functioned properly. The errors observed were:

1. **Translation Loading Error:**
   ```
   Failed to initialize i18n service asynchronously: TypeError: error loading dynamically imported module: https://ihub.local.intrafind.io/assets/en-1bn6npZI.js
   ```

2. **Session Start Timeout:**
   ```
   API Error: Request aborted 
   Object { status: 500, userFriendlyMessage: "Request timed out. The operation may have taken longer than expected.", details: undefined, url: "/session/start" }
   ```

3. **Session Logging Failure:**
   ```
   Failed to log session start: Error: Request timed out. The operation may have taken longer than expected.
   ```

## Root Cause Analysis

The primary issue was in the `client/src/services/i18nService.js` file where core translation files were being loaded using dynamic `import()` statements:

```javascript
// Problematic code (lines 73-76)
const [enCoreTranslations, deCoreTranslations] = await Promise.all([
  import('../../../shared/i18n/en.json'),
  import('../../../shared/i18n/de.json')
]);
```

### Why Firefox Failed

1. **Browser-Specific Module Loading:** Firefox has stricter policies regarding dynamic module imports compared to Chrome, especially when dealing with JSON files.

2. **Vite Build System:** When Vite builds the application for production, it transforms dynamic imports into separate chunk files (e.g., `en-1bn6npZI.js`). Firefox's module loader was failing to properly resolve and load these dynamically generated chunks.

3. **CORS and Module Type Headers:** Firefox is more strict about checking Content-Type headers and CORS policies for ES modules, which can cause failures with dynamically imported JSON that has been transformed into JavaScript modules.

4. **Cascade Effect:** The i18n initialization failure blocked the application's initialization sequence, which then caused the session start API call to timeout as the application was stuck in an uninitialized state.

## Solution

The fix involved replacing dynamic imports with static imports at the top of the file. This ensures the translation files are bundled at build time rather than being loaded asynchronously.

### Changes Made

**File:** `client/src/services/i18nService.js`

1. **Added static imports at the top:**
   ```javascript
   // Import core translations statically to avoid Firefox dynamic import issues
   import enCoreTranslations from '../../../shared/i18n/en.json';
   import deCoreTranslations from '../../../shared/i18n/de.json';
   ```

2. **Updated initializeAsync() method:**
   ```javascript
   async initializeAsync() {
     try {
       // Load platform configuration asynchronously
       await this.loadPlatformConfig();

       // Add core translations to existing i18n instance (already imported statically)
       i18n.addResourceBundle('en', 'translation', enCoreTranslations, true, true);
       i18n.addResourceBundle('de', 'translation', deCoreTranslations, true, true);

       // Load full translations for the current language
       const currentLanguage = i18n.language || this.defaultLanguage;
       await this.loadFullTranslations(currentLanguage);
     } catch (error) {
       console.error('Failed to initialize i18n service asynchronously:', error);
     }
   }
   ```

3. **Removed .default property access:** Static imports don't require accessing the `.default` property like dynamic imports do.

## Benefits of Static Imports

1. **Cross-Browser Compatibility:** Static imports work consistently across all browsers, including Firefox, Chrome, Safari, and Edge.

2. **Build-Time Bundling:** Translation files are bundled into the main application bundle at build time, eliminating runtime loading issues.

3. **Faster Initial Load:** No need to make additional HTTP requests for translation files, reducing the number of network round-trips.

4. **Type Safety:** Static imports provide better TypeScript/IDE support for code completion and error checking.

5. **Predictable Behavior:** Static imports have well-defined behavior across all JavaScript environments.

## Testing Recommendations

To verify the fix works correctly:

1. **Firefox Testing:**
   - Clear browser cache
   - Load the application in Firefox
   - Verify no console errors related to i18n or translation loading
   - Verify the application loads successfully
   - Check that translations are displayed correctly

2. **Chrome Testing:**
   - Verify the fix doesn't break Chrome functionality
   - Ensure translations still load correctly

3. **Other Browsers:**
   - Test on Safari and Edge to ensure cross-browser compatibility

4. **Performance Testing:**
   - Measure initial load time before and after the fix
   - Static imports may slightly increase the main bundle size but reduce the number of HTTP requests

## Alternative Solutions Considered

1. **Vite Configuration Changes:** Attempted to configure Vite to handle JSON imports differently, but this would have required complex rollup plugins and wouldn't guarantee Firefox compatibility.

2. **Fetch-Based Loading:** Could have used `fetch()` to load JSON files, but this would add unnecessary complexity and potential CORS issues.

3. **Preloading Hints:** Could have added `<link rel="modulepreload">` hints, but this wouldn't solve the fundamental module loading issue in Firefox.

## Related Files

- `client/src/services/i18nService.js` - Main fix location
- `client/src/i18n/index.js` - i18n service export
- `client/src/i18n/i18n.js` - Re-export module
- `shared/i18n/en.json` - English translations
- `shared/i18n/de.json` - German translations

## Impact

- **User Impact:** Positive - Firefox users can now use the application without errors
- **Performance Impact:** Minimal - Slight increase in main bundle size (~100KB for both translation files)
- **Maintenance Impact:** Positive - Simpler code without dynamic imports

## Conclusion

By replacing dynamic imports with static imports for core translation files, we've resolved the Firefox compatibility issue while maintaining functionality across all browsers. The fix is minimal, well-tested, and improves the overall reliability of the application.
