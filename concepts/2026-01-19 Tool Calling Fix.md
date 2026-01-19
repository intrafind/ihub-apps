# Tool Calling Fix for OpenAI Responses API

**Date**: 2026-01-19  
**Issue**: Tool calling not working with GPT-5.2 via OpenAI Responses API

## Problem Description

When using the chat-with-web app with GPT-5.2, tools were being sent to the API but never executed. The logs showed:
```
No tool calls to process for chat ID chat-6ef174bc-473b-4515-bb46-3ff4652d7877: {
  "finishReason": "stop",
  "collectedToolCalls": []
}
```

The model would respond with a normal text message instead of calling the available tools (webContentExtractor, enhancedWebSearch).

## Root Cause

The OpenAI Responses API has significant differences from the Chat Completions API:

1. **No `finish_reason` field**: The Responses API does NOT include a `finish_reason` field in its responses
2. **Uses `status` instead**: Completion is indicated by `status: "completed"` and `incomplete_details: null`
3. **Tool calls in output array**: Function calls are represented as items with `type: "function_call"` in the output array

Our implementation was incorrectly hardcoding the finish reason to `'stop'` in all cases, even when tool calls were present. This caused the tool execution logic in `ToolExecutor.js` to skip processing:

```javascript
// Line 517 in ToolExecutor.js
if (finishReason !== 'tool_calls' || collectedToolCalls.length === 0) {
  console.log(`No tool calls to process for chat ID ${chatId}:`, ...);
  return; // Exit without executing tools
}
```

## Solution

Modified the finish reason logic to check for the presence of tool calls in the output:

### 1. OpenAIResponsesConverter.js

**Streaming completion events** (lines 146-151):
```javascript
// Check if the completion event contains output with function calls
let hasToolCalls = false;
if (parsed.response?.output && Array.isArray(parsed.response.output)) {
  hasToolCalls = parsed.response.output.some(item => item.type === 'function_call');
}

finishReason = hasToolCalls ? 'tool_calls' : 'stop';
```

**Non-streaming responses** (line 249):
```javascript
complete = true;
// Set finish reason based on whether tool calls are present
finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
```

**Legacy format** (line 276):
```javascript
if (parsed.status === 'completed' || parsed.output_status === 'completed') {
  complete = true;
  finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
}
```

### 2. openai-responses.js

**Completion detection** (line 319):
```javascript
if (parsed.type === 'response.completed' || 
    parsed.status === 'completed' || 
    parsed.output_status === 'completed') {
  result.complete = true;
  // Determine finish reason based on whether tool calls are present
  result.finishReason = result.tool_calls.length > 0 ? 'tool_calls' : 'stop';
}
```

## Testing

Created comprehensive test coverage in `server/tests/openaiResponsesFinishReason.test.js`:

1. ✅ Non-streaming response with tool calls → finish reason = 'tool_calls'
2. ✅ Non-streaming response without tool calls → finish reason = 'stop'
3. ✅ Streaming completion with tool calls → finish reason = 'tool_calls'
4. ✅ Streaming completion without tool calls → finish reason = 'stop'
5. ✅ Multiple tool calls → finish reason = 'tool_calls'
6. ✅ Mixed output (message + tool call) → finish reason = 'tool_calls'

All tests pass successfully.

## Impact

This fix enables tool calling for:
- GPT-5, GPT-5.1, GPT-5.2 models
- Any app using tools with OpenAI Responses API
- Specifically fixes chat-with-web app functionality

## Verification

To verify the fix works with a real API:

1. Set up GPT-5.2 API key: `export GPT_5.2_API_KEY="your-api-key"`
2. Enable the gpt-5 model in `contents/models/gpt-5.json`
3. Use the chat-with-web app and ask a question that requires web search
4. The model should now correctly call the webContentExtractor or enhancedWebSearch tools

Expected behavior:
- Logs should show tool calls being detected
- Tools should execute and return results
- Model should use tool results to formulate final answer

## References

- OpenAI Responses API: https://platform.openai.com/docs/api-reference/responses
- Streaming Events: https://platform.openai.com/docs/api-reference/responses-streaming/response/completed
- Migration Guide: https://platform.openai.com/docs/guides/migrate-to-responses
- Community Discussion: https://community.openai.com/t/responses-api-dont-have-finish-reason/1361347

## Files Modified

- `/server/adapters/openai-responses.js` - Fixed finish reason detection
- `/server/adapters/toolCalling/OpenAIResponsesConverter.js` - Fixed finish reason in all response formats
- `/server/tests/openaiResponsesFinishReason.test.js` - Added comprehensive tests
- `/concepts/2026-01-19 OpenAI Response API Support.md` - Updated documentation
