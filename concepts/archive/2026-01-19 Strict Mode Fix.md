# Strict Mode Fix for OpenAI Responses API Tool Calling

**Date**: 2026-01-19  
**Issue**: Tools not being called despite previous finish reason fix

## Problem

After fixing the finish reason detection, tools were still not being called by GPT-5.2. The model was receiving the tool definitions but choosing not to use them.

### Evolution of the Issue

1. **Initial attempt**: Added `strict: true` and `additionalProperties: false`
2. **Error encountered**: `Invalid schema for function 'webContentExtractor': In context=(), 'required' is required to be supplied and to be an array including every key in properties. Missing 'maxLength'.`
3. **Root cause discovered**: In OpenAI Responses API strict mode, **ALL** properties must be listed in the `required` array, not just mandatory ones.

## Root Cause

According to the OpenAI Responses API strict mode requirements, tools must be defined with:

1. **`strict: true`** - Enables strict schema validation
2. **`additionalProperties: false`** - Required on ALL object schemas (including nested ones)
3. **All properties in `required` array** - This is the critical requirement that differs from standard JSON Schema

**Key Insight**: In standard JSON Schema, the `required` array only lists mandatory fields. However, in OpenAI Responses API strict mode, the `required` array must include **every property** defined in `properties`, even optional ones with defaults.

This is a fundamental difference from normal JSON Schema behavior and is specific to OpenAI's strict mode implementation.

## Solution

Modified `convertGenericToolsToOpenaiResponses` in `OpenAIResponsesConverter.js` to:

1. **Add a helper function** `addStrictModeToSchema` that:
   - Recursively adds `additionalProperties: false` to all object schemas
   - Automatically adds ALL property keys to the `required` array
   - Processes nested objects, array items, anyOf/allOf/oneOf

2. **Explicitly set** `strict: true` on each tool definition

### Code Changes

```javascript
function addStrictModeToSchema(schema) {
  // ... clone and setup ...
  
  function enforceStrictMode(obj) {
    if (obj.type === 'object') {
      obj.additionalProperties = false;

      // CRITICAL: In strict mode, ALL properties must be in required array
      if (obj.properties && Object.keys(obj.properties).length > 0) {
        const existingRequired = Array.isArray(obj.required) ? obj.required : [];
        const allPropertyKeys = Object.keys(obj.properties);
        
        // Ensure all property keys are in required array
        const requiredSet = new Set(existingRequired);
        allPropertyKeys.forEach(key => requiredSet.add(key));
        
        obj.required = Array.from(requiredSet);
      }
    }
    // ... process nested schemas ...
  }
}
```

### Example Tool Output

**Before (caused error):**
```json
{
  "type": "function",
  "name": "webContentExtractor",
  "parameters": {
    "type": "object",
    "properties": {
      "url": { "type": "string" },
      "maxLength": { "type": "integer", "default": 5000 },
      "ignoreSSL": { "type": "boolean", "default": false }
    },
    "required": ["url"],  // ❌ Missing maxLength and ignoreSSL
    "additionalProperties": false
  },
  "strict": true
}
```

**After (works correctly):**
```json
{
  "type": "function",
  "name": "webContentExtractor",
  "parameters": {
    "type": "object",
    "properties": {
      "url": { "type": "string" },
      "maxLength": { "type": "integer", "default": 5000 },
      "ignoreSSL": { "type": "boolean", "default": false }
    },
    "required": ["url", "maxLength", "ignoreSSL"],  // ✅ All properties included
    "additionalProperties": false
  },
  "strict": true
}
```

## Testing

Updated comprehensive test coverage in `server/tests/openaiResponsesStrictMode.test.js`:

1. ✅ Tool with optional parameters - all properties in required array
2. ✅ Tool matching webContentExtractor error case - all properties required
3. ✅ Nested objects also get all properties in required
4. ✅ Format matches OpenAI strict mode requirements

All tests pass successfully, including existing adapter and tool calling tests.

## Impact

This change ensures that:
- All tools sent to GPT-5.x models via Responses API comply with strict mode requirements
- Optional parameters with defaults are properly included in the required array
- Nested object schemas are properly validated
- The model can reliably parse and use tool definitions without validation errors

## Important Note on Optional Parameters

Even though all parameters are now in the `required` array for strict mode compliance, parameters with `default` values are still effectively optional from the caller's perspective. The API will use the default value if the parameter is not provided.

Example:
```json
{
  "maxLength": {
    "type": "integer",
    "default": 5000,
    "minimum": 100,
    "maximum": 50000
  }
}
```

This parameter:
- Is in the `required` array (for strict mode)
- Has a default value of 5000
- Will use 5000 if not provided in the function call
- Can be overridden by providing a value

## Verification Steps

To verify the fix works with a real API:

1. Check the server logs for the request body when sending a chat message with tools
2. Look for the `OpenAI Responses API request body:` log entry
3. Verify that tools have:
   - `strict: true` at the tool level
   - `additionalProperties: false` in all object schemas (including nested)
   - ALL property keys in the `required` array

Example expected output in logs:
```json
{
  "tools": [
    {
      "type": "function",
      "name": "webContentExtractor",
      "description": "Extract clean, readable content from a URL...",
      "parameters": {
        "type": "object",
        "properties": {
          "url": { "type": "string", "description": "..." },
          "maxLength": { "type": "integer", "default": 5000 },
          "ignoreSSL": { "type": "boolean", "default": false }
        },
        "required": ["url", "maxLength", "ignoreSSL"],
        "additionalProperties": false
      },
      "strict": true
    }
  ]
}
```

## References

- OpenAI Responses API Documentation: https://platform.openai.com/docs/api-reference/responses
- OpenAI Function Calling Guide: https://platform.openai.com/docs/guides/function-calling
- OpenAI Strict Mode Requirements: All properties must be in required array

## Files Modified

- `/server/adapters/toolCalling/OpenAIResponsesConverter.js` - Added strict mode helper with required array handling
- `/server/tests/openaiResponsesStrictMode.test.js` - Comprehensive test coverage including required array validation
- `/concepts/2026-01-19 Strict Mode Fix.md` - This documentation
