# Gemini 3 Function Calling Fix

## Problem Description

Function calling was working correctly with:
- Anthropic Claude models
- OpenAI GPT models
- Mistral models
- Google Gemini 2.5 models

However, **Gemini 3.0 models** (including `gemini-3.0-flash` and `gemini-3.0-pro`) failed to execute function calls even though they were correctly detected and collected.

### Root Cause

The issue was identified in the Google adapter's response processing logic. When Gemini 3.0 makes a function call, the API returns:
- `candidates[0].content.parts` containing the `functionCall`
- `candidates[0].finishReason: "STOP"` (instead of a tool-specific finish reason)

The adapter was processing this response in the following order:
1. Parse the `functionCall` and add it to `result.tool_calls`
2. Set `result.finishReason = 'tool_calls'` (correctly indicating a function call)
3. Then check the API's `finishReason` field
4. **OVERWRITE** `result.finishReason` to `'stop'` because the API returned `"STOP"`

This caused the ToolExecutor to skip tool execution since it requires `finishReason === 'tool_calls'`.

### Example from Logs

```
[0] Processing chat with tools for chat ID: chat-98d7d035-6958-4a95-8bbf-ae5e05eba67a
[0] No tool calls to process for chat ID chat-98d7d035-6958-4a95-8bbf-ae5e05eba67a: {
[0]   "finishReason": "stop",  // ❌ Should be "tool_calls"
[0]   "collectedToolCalls": [
[0]     {
[0]       "index": 0,
[0]       "id": "call_0_1768906445558",
[0]       "type": "function",
[0]       "function": {
[0]         "name": "enhancedWebSearch",
[0]         "arguments": "{\"query\":\"IntraFind iHub was ist das\"}"
[0]       }
[0]     }
[0]   ]
[0] }
```

## Solution

The fix adds an additional check before overwriting the `finishReason`. The adapter now:
1. Checks if `finishReason` is already set to `'tool_calls'`
2. **AND** checks if `tool_calls.length === 0`
3. Only overwrites the `finishReason` if BOTH conditions are true

This ensures that when there ARE tool calls in the response, the `finishReason` remains as `'tool_calls'` regardless of what the API returns.

### Code Changes

**File: `server/adapters/google.js`**

Before:
```javascript
if (result.finishReason !== 'tool_calls') {
  if (fr === 'STOP') {
    result.finishReason = 'stop';
  }
  // ... other cases
}
```

After:
```javascript
// Check both the finishReason flag AND the actual tool_calls array
// This is needed because Gemini 3.0 returns "STOP" even when making function calls
if (result.finishReason !== 'tool_calls' && result.tool_calls.length === 0) {
  if (fr === 'STOP') {
    result.finishReason = 'stop';
  }
  // ... other cases
}
```

The same fix was applied to:
- `server/adapters/google.js` (2 locations: non-streaming and streaming responses)
- `server/adapters/toolCalling/GoogleConverter.js` (2 locations: non-streaming and streaming responses)

## Testing

Comprehensive tests were added to verify the fix:

### Test Coverage

1. **Gemini 3 response with function call and STOP finish reason**
   - Verifies that `finishReason: "tool_calls"` is preserved
   - Validates that tool calls are correctly detected

2. **Normal response without function call**
   - Ensures regular text responses still work
   - Confirms `finishReason: "stop"` for non-tool responses

3. **Streaming responses with function calls**
   - Tests streaming chunks with function calls
   - Verifies finish reason preservation across chunks

4. **Multiple function calls in one response**
   - Validates handling of multiple tool calls
   - Ensures all tool calls are collected correctly

### Test Files

- `server/tests/gemini3-tool-calling.test.js` - Tests the main Google adapter
- `server/tests/gemini3-converter.test.js` - Tests the GoogleConverter (generic tool calling)

### Running Tests

```bash
# Test Google adapter
node server/tests/gemini3-tool-calling.test.js

# Test GoogleConverter
node server/tests/gemini3-converter.test.js

# Test existing functionality
node server/tests/googleAdapter.test.js
```

All tests pass ✅

## Backward Compatibility

The fix is fully backward compatible:
- **Gemini 2.5 models** continue to work as before
- **Normal text responses** (without tool calls) are unaffected
- **Streaming and non-streaming modes** both work correctly
- **Other LLM providers** (OpenAI, Anthropic, Mistral) are not affected

## Impact

This fix enables Gemini 3.0 models to properly use function calling, unlocking features like:
- Web search capabilities
- External API integration
- Tool-based workflows
- Enhanced context through data retrieval

The fix ensures consistent behavior across all Gemini model versions (2.5 and 3.0).

## Related Files

- `server/adapters/google.js` - Main Google adapter
- `server/adapters/toolCalling/GoogleConverter.js` - Generic tool calling converter
- `server/services/chat/ToolExecutor.js` - Tool execution logic (unchanged)
- `server/tests/gemini3-tool-calling.test.js` - New test file
- `server/tests/gemini3-converter.test.js` - New test file
