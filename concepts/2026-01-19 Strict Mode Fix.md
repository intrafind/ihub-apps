# Strict Mode Fix for OpenAI Responses API Tool Calling

**Date**: 2026-01-19  
**Issue**: Tools not being called despite previous finish reason fix

## Problem

After fixing the finish reason detection, tools were still not being called by GPT-5.2. The model was receiving the tool definitions but choosing not to use them.

## Root Cause

According to the OpenAI Responses API documentation, tools must be defined with:
1. **`strict: true`** - Enables strict schema validation
2. **`additionalProperties: false`** - Required on ALL object schemas (including nested ones)

Our implementation was not adding these required fields, causing the model to potentially ignore or misinterpret the tool definitions.

## Solution

Modified `convertGenericToolsToOpenaiResponses` in `OpenAIResponsesConverter.js` to:

1. **Add a helper function** `addStrictModeToSchema` that recursively adds `additionalProperties: false` to all object schemas
2. **Explicitly set** `strict: true` on each tool definition
3. **Process all nested objects** including those in arrays, anyOf, allOf, and oneOf

### Code Changes

```javascript
// Before
export function convertGenericToolsToOpenaiResponses(genericTools = []) {
  return genericTools.map(tool => ({
    type: 'function',
    name: tool.id || tool.name,
    description: tool.description,
    parameters: sanitizeSchemaForProvider(tool.parameters, 'openai-responses')
    // Note: strict: true is the default in Responses API, no need to specify
  }));
}

// After
export function convertGenericToolsToOpenaiResponses(genericTools = []) {
  return genericTools.map(tool => {
    const sanitizedParams = sanitizeSchemaForProvider(tool.parameters, 'openai-responses');
    const strictParams = addStrictModeToSchema(sanitizedParams);

    return {
      type: 'function',
      name: tool.id || tool.name,
      description: tool.description,
      parameters: strictParams,
      strict: true // Explicitly enable strict mode for tool calling
    };
  });
}
```

### Example Tool Output

**Before:**
```json
{
  "type": "function",
  "name": "get_weather",
  "description": "Get the current weather",
  "parameters": {
    "type": "object",
    "properties": {
      "location": { "type": "string" }
    },
    "required": ["location"]
  }
}
```

**After:**
```json
{
  "type": "function",
  "name": "get_weather",
  "description": "Get the current weather",
  "parameters": {
    "type": "object",
    "properties": {
      "location": { "type": "string" }
    },
    "required": ["location"],
    "additionalProperties": false
  },
  "strict": true
}
```

## Testing

Created comprehensive test coverage in `server/tests/openaiResponsesStrictMode.test.js`:

1. ✅ Simple tool with object parameters gets strict mode
2. ✅ Nested objects also get additionalProperties: false
3. ✅ Format matches OpenAI documentation example

All tests pass successfully, including existing adapter and tool calling tests.

## Impact

This change ensures that:
- All tools sent to GPT-5.x models via Responses API have strict schema validation
- The tool format matches the official OpenAI documentation requirements
- Nested object schemas are properly validated
- The model can reliably parse and use tool definitions

## Verification Steps

To verify the fix works with a real API:

1. Check the server logs for the request body when sending a chat message with tools
2. Look for the `OpenAI Responses API request body:` log entry
3. Verify that tools have:
   - `strict: true` at the tool level
   - `additionalProperties: false` in all object schemas (including nested)

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
          "maxLength": { "type": "integer", "default": 5000 }
        },
        "required": ["url"],
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
- User's documentation example showing required format

## Files Modified

- `/server/adapters/toolCalling/OpenAIResponsesConverter.js` - Added strict mode helper and updated converter
- `/server/tests/openaiResponsesStrictMode.test.js` - Comprehensive test coverage (new file)
- `/concepts/2026-01-19 Strict Mode Fix.md` - This documentation (new file)
