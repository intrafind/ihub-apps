# 2026-02-03 Google Search Tool Doubled Function Name Fix

## Problem

The Google Search tool (`googleSearch`) was partially broken, failing on the second request with the error:
```
Tool google_search_google_search not found
```

### Symptoms

1. First request with `google_search` tool works correctly
2. Model makes a function call with name `google_search_google_search` (doubled)
3. Server attempts to execute tool `google_search_google_search`
4. Tool not found error occurs because the actual tool ID is `googleSearch`

### Example from Logs

**First Request (works):**
```json
{
  "tools": [
    {
      "google_search": {}
    }
  ]
}
```

**Model Response (broken):**
```json
{
  "role": "model",
  "parts": [
    {
      "functionCall": {
        "name": "google_search_google_search",
        "args": {
          "queries": ["Wer ist Daniel Manzke?"]
        }
      }
    }
  ]
}
```

**Error:**
```
Tool google_search_google_search not found
```

## Root Cause

The Google Gemini API has a bug where it doubles the tool name when using the native `google_search` grounding tool. Instead of returning function calls with the name `google_search`, it returns `google_search_google_search`.

This appears to be an issue in the Gemini API itself, where:
1. We send the tool as `{ google_search: {} }` (correct format)
2. Gemini internally processes it and creates a function call
3. Gemini doubles the name: `google_search` + `_google_search` = `google_search_google_search`

## Solution

Implemented a normalization function in the Google Converter that maps the doubled name back to the correct tool ID.

### Implementation

**File:** `server/adapters/toolCalling/GoogleConverter.js`

Added `normalizeGoogleFunctionName()` helper function:

```javascript
/**
 * Normalize Google function call names
 * Google's API sometimes doubles the tool name for special tools like google_search
 * This function handles the mapping back to the correct tool ID
 * @param {string} googleFunctionName - Function name from Google API
 * @returns {string} Normalized function name
 */
function normalizeGoogleFunctionName(googleFunctionName) {
  // Handle the doubled google_search name bug
  // Google returns "google_search_google_search" but we need "googleSearch"
  if (googleFunctionName === 'google_search_google_search' || googleFunctionName === 'google_search') {
    return 'googleSearch';
  }
  
  return googleFunctionName;
}
```

### Changes Applied

The normalization is applied in **3 locations** where function call names are processed:

1. **`convertGoogleFunctionCallsToGeneric()`** - Line 153
   ```javascript
   normalizeGoogleFunctionName(part.functionCall.name)
   ```

2. **`convertGoogleResponseToGeneric()` - Non-streaming path** - Line 250
   ```javascript
   normalizeGoogleFunctionName(part.functionCall.name)
   ```

3. **`convertGoogleResponseToGeneric()` - Streaming path** - Line 318
   ```javascript
   normalizeGoogleFunctionName(part.functionCall.name)
   ```

### Flow After Fix

1. Google returns `google_search_google_search` in function call
2. `normalizeGoogleFunctionName()` converts it to `googleSearch`
3. Generic tool call has name `googleSearch`
4. ToolExecutor finds tool with ID `googleSearch`
5. Tool loader sees `isSpecialTool: true`
6. Returns `{ handled_by_provider: true }` (no server-side execution)
7. Response continues normally

## Testing

### New Test Suite

Created `server/tests/google-search-doubled-name-fix.test.js` with 4 tests:

1. ✅ **Test 1**: `google_search_google_search` → `googleSearch` normalization
2. ✅ **Test 2**: `google_search` → `googleSearch` normalization  
3. ✅ **Test 3**: Other function names are not affected
4. ✅ **Test 4**: Streaming response normalization

### Existing Tests

- ✅ `googleSearchFunctionCallingConflict.test.js` still passes
- ✅ Server startup successful
- ✅ No linting errors
- ✅ Code formatting correct

## Code Locations

- **Fix Implementation**: `server/adapters/toolCalling/GoogleConverter.js`
  - `normalizeGoogleFunctionName()` function definition
  - Applied in `convertGoogleFunctionCallsToGeneric()`
  - Applied in `convertGoogleResponseToGeneric()` (both streaming and non-streaming paths)
- **Test Suite**: `server/tests/google-search-doubled-name-fix.test.js`
- **Related Concept**: `concepts/2026-01-16 Google Search Grounding.md`

## Impact

### Before Fix
- Google Search tool would fail on the second request
- Error: "Tool google_search_google_search not found"
- Users could not use Google Search grounding feature effectively

### After Fix
- Google Search tool works correctly for all requests
- Doubled function name is automatically normalized
- No impact on other tools or function calls
- Backward compatible with correct function names

## Future Considerations

1. **Monitor Google API**: Track if Google fixes this bug on their side
2. **Remove Workaround**: If Google fixes the issue, this normalization can be removed
3. **Other Special Tools**: Watch for similar issues with other provider-specific tools
4. **API Version**: Check if newer Gemini API versions have this issue

## References

- **Issue**: Google Search tool call partially broken
- **Related Concept**: [2026-01-16 Google Search Grounding](./2026-01-16%20Google%20Search%20Grounding.md)
- **Gemini Documentation**: https://ai.google.dev/gemini-api/docs/google-search
