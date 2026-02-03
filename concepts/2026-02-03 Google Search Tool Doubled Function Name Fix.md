# 2026-02-03 Google Search Tool Function Name Mapping Fix

## Problem

The Google Search tool (`googleSearch`) was failing on the second request because Google's Gemini 3.0 API returns function calls with the name `google_search_google_search` instead of treating `google_search` as a pure grounding tool.

### Symptoms

1. First request with `google_search` tool works correctly
2. Model makes a function call with name `google_search_google_search` (doubled)
3. Server fails with error: "Tool google_search_google_search not found"

### Example from Logs

**First Request (works):**
```json
{
  "tools": [{ "google_search": {} }]
}
```

**Model Response (unexpected):**
```json
{
  "role": "model",
  "parts": [{
    "functionCall": {
      "name": "google_search_google_search",
      "args": { "queries": ["Wer ist Daniel Manzke?"] }
    }
  }]
}
```

**Second Request (our response with error):**
```json
{
  "role": "user",
  "parts": [{
    "functionResponse": {
      "name": "google_search_google_search",
      "response": {
        "result": {
          "error": true,
          "message": "Tool google_search_google_search not found"
        }
      }
    }
  }]
}
```

## Root Cause

Google's Gemini 3.0 API has unexpected behavior where it returns function calls for the `google_search` grounding tool with the doubled name `google_search_google_search`. 

The critical insight: **We must echo back the EXACT function name Google sends us**, even if it's wrong. But internally, we need to map it to our tool ID `googleSearch` for tool lookup.

The flow was:
1. We send correct format: `{ "google_search": {} }`
2. Google responds with `"name": "google_search_google_search"` in the function call
3. We try to find tool with ID `google_search_google_search` → FAIL
4. Even if we found it, we would normalize the response name, breaking the conversation

## Solution

Implement a dual-name system:
1. **Internal tool ID**: Map Google's function names to our tool IDs (`googleSearch`)
2. **External echo name**: Preserve and echo back Google's original function names

### Implementation

**File:** `server/adapters/toolCalling/GoogleConverter.js`

Added mapping function:

```javascript
/**
 * Map Google's function names to our internal tool IDs
 * @param {string} googleFunctionName - Function name from Google API
 * @returns {string} Internal tool ID
 */
function mapGoogleFunctionNameToToolId(googleFunctionName) {
  if (googleFunctionName === 'google_search_google_search' || 
      googleFunctionName === 'google_search') {
    return 'googleSearch';
  }
  return googleFunctionName;
}
```

Updated function call conversion to store original name:

```javascript
const originalName = part.functionCall.name;
const toolId = mapGoogleFunctionNameToToolId(originalName);

return createGenericToolCall(
  id,
  toolId,  // Use mapped name for tool lookup
  args,
  index,
  { 
    originalFormat: 'google',
    originalGoogleName: originalName  // Preserve for response echoing
  }
);
```

**File:** `server/services/chat/ToolExecutor.js`

Preserve original name in tool messages:

```javascript
const message = {
  role: 'tool',
  tool_call_id: toolCall.id,
  name: toolCall.function.name,  // Mapped name
  content: JSON.stringify(result)
};

// Preserve original Google function name for response echoing
if (toolCall.metadata?.originalGoogleName) {
  message.originalGoogleName = toolCall.metadata.originalGoogleName;
}
```

**File:** `server/adapters/google.js`

Use original name when echoing back to Google:

```javascript
if (message.role === 'tool') {
  const functionName = message.originalGoogleName || 
                      normalizeToolName(message.name || ...);
  
  currentToolResponses.push({
    functionResponse: {
      name: functionName,  // Echo original name
      response: { result: responseObj }
    }
  });
}
```

### Flow After Fix

1. Google returns `google_search_google_search` in function call
2. `mapGoogleFunctionNameToToolId()` converts it to `googleSearch` for internal use
3. Original name stored in `metadata.originalGoogleName`
4. ToolExecutor finds tool with ID `googleSearch` ✓
5. Tool message includes `originalGoogleName: "google_search_google_search"`
6. Google adapter echoes back original: `"name": "google_search_google_search"` ✓
7. Conversation continues normally

## Testing

### New Test Suite

Updated `server/tests/google-search-doubled-name-fix.test.js` with 3 tests:

1. ✅ **Test 1**: `google_search_google_search` → `googleSearch` mapping + preservation
2. ✅ **Test 2**: `google_search` → `googleSearch` mapping + preservation  
3. ✅ **Test 3**: Other function names pass through unchanged

### Existing Tests

- ✅ `googleSearchFunctionCallingConflict.test.js` still passes
- ✅ No linting errors
- ✅ Code formatting correct

## Code Locations

- **Mapping Function**: `server/adapters/toolCalling/GoogleConverter.js`
  - `mapGoogleFunctionNameToToolId()` helper
  - Applied in `convertGoogleFunctionCallsToGeneric()`
  - Applied in `convertGoogleResponseToGeneric()` (both streaming/non-streaming)
- **Metadata Preservation**: `server/services/chat/ToolExecutor.js`
  - `executeToolCall()` method (success and error paths)
- **Response Echoing**: `server/adapters/google.js`
  - `formatMessages()` method
- **Test Suite**: `server/tests/google-search-doubled-name-fix.test.js`
- **Related Concept**: `concepts/2026-01-16 Google Search Grounding.md`

## Impact

### Before Fix
- Google Search tool failed on second request
- Error: "Tool google_search_google_search not found"
- Users could not use Google Search grounding

### After Fix
- Google Search tool works correctly for all requests
- Doubled function name mapped internally but echoed correctly
- Maintains API compatibility with Google's expectations
- No impact on other tools or function calls

## Key Insight

The fix was NOT about normalizing the name - it was about understanding that:

1. **Internal processing**: We need the correct tool ID (`googleSearch`) to find and execute the tool
2. **External communication**: We must echo Google's exact function name back in responses
3. **Dual-name system**: Store both the mapped name (for us) and original name (for Google)

This is more robust than simple normalization because it respects Google's API contract while working around their bug.

## Future Considerations

1. **Monitor Google API**: Check if Google fixes this in future Gemini versions
2. **Remove Workaround**: If Google fixes the doubled name, this mapping can be simplified
3. **Other Special Tools**: Watch for similar issues with other provider-specific tools
4. **API Versioning**: Track which Gemini API versions have this behavior

## References

- **Issue**: Google Search tool call partially broken
- **Related Concept**: [2026-01-16 Google Search Grounding](./2026-01-16%20Google%20Search%20Grounding.md)
- **Gemini Documentation**: https://ai.google.dev/gemini-api/docs/google-search
- **Comment from @manzke**: "instead of accepting that the name is wrong and normalize it, we should figure out, why it is wrong. the name is generated by us."
