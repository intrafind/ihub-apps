# Streaming Function Call Events Support

**Date**: 2026-01-19  
**Issue**: Function calls are streamed but not being captured

## Problem

After fixing strict mode validation, function calls were being sent by the API but not detected. The logs showed new streaming event types that weren't being handled:

```
response.output_item.added
response.function_call_arguments.delta
response.function_call_arguments.done
```

## Root Cause

The OpenAI Responses API uses a different streaming format for function calls compared to the old format we were handling. We were only looking for:
- `response.output_chunk.delta` with `delta.type === 'function_call'`

But the actual streaming format uses separate event types:
1. **`response.output_item.added`** - Signals a new function call is starting
2. **`response.function_call_arguments.delta`** - Streams function arguments piece by piece
3. **`response.function_call_arguments.done`** - Provides the complete final arguments

## Solution

Added support for all three streaming function call event types in `OpenAIResponsesConverter.js`:

### 1. Handle `response.output_item.added`

This event is sent when a function call starts. It contains the function name and call ID:

```javascript
if (parsed.type === 'response.output_item.added' && parsed.item?.type === 'function_call') {
  toolCalls.push({
    id: parsed.item.call_id || parsed.item.id,
    type: 'function',
    index: parsed.output_index || 0,
    function: {
      name: parsed.item.name || '',
      arguments: parsed.item.arguments || ''
    }
  });
}
```

### 2. Handle `response.function_call_arguments.delta`

This event streams the function arguments as they're generated:

```javascript
if (parsed.type === 'response.function_call_arguments.delta') {
  toolCalls.push({
    id: parsed.item_id,
    type: 'function',
    index: parsed.output_index || 0,
    function: {
      name: '',
      arguments: parsed.delta || ''
    }
  });
}
```

### 3. Handle `response.function_call_arguments.done`

This event provides the complete, final function arguments:

```javascript
if (parsed.type === 'response.function_call_arguments.done') {
  toolCalls.push({
    id: parsed.item_id,
    type: 'function',
    index: parsed.output_index || 0,
    function: {
      name: '',
      arguments: parsed.arguments || ''
    },
    complete: true
  });
}
```

### 4. Handle `response.output_item.done`

This event provides the final complete function call with both name and arguments. This is critical for ensuring the function name is properly captured:

```javascript
if (parsed.type === 'response.output_item.done' && parsed.item?.type === 'function_call') {
  toolCalls.push({
    id: parsed.item.call_id || parsed.item.id,
    type: 'function',
    index: parsed.output_index || 0,
    function: {
      name: parsed.item.name || '',
      arguments: parsed.item.arguments || ''
    },
    complete: true
  });
}
```

## Example Streaming Sequence

From the user's logs, here's a real streaming sequence:

```javascript
// 1. Function call starts
{
  "type": "response.output_item.added",
  "item": {
    "id": "fc_02939...",
    "type": "function_call",
    "call_id": "call_FhLW...",
    "name": "enhancedWebSearch"
  }
}

// 2. Arguments stream in piece by piece
{ "type": "response.function_call_arguments.delta", "delta": "{\"" }
{ "type": "response.function_call_arguments.delta", "delta": "query" }
{ "type": "response.function_call_arguments.delta", "delta": "\":\"" }
{ "type": "response.function_call_arguments.delta", "delta": "IntraFind" }
// ... more deltas ...

// 3. Complete arguments provided
{
  "type": "response.function_call_arguments.done",
  "arguments": "{\"query\":\"Intrafind iHub\",\"extractContent\":true,\"maxResults\":3,\"contentMaxLength\":3000}"
}

// 4. Final complete function call with name and arguments
{
  "type": "response.output_item.done",
  "item": {
    "type": "function_call",
    "call_id": "call_Uy1WdAKT2ZA4beABlIYCjLR2",
    "name": "enhancedWebSearch",
    "arguments": "{\"query\":\"Intrafind iHub\",...}"
  }
}
```

**Important:** The `response.output_item.done` event is crucial because it provides the complete function call with both the function name and the final arguments together. Without handling this event, the function name may not be properly associated with the arguments.

## Testing

Created comprehensive test coverage in `server/tests/openaiResponsesStreamingFunctionCalls.test.js`:

1. ✅ response.output_item.added creates function call
2. ✅ response.function_call_arguments.delta accumulates arguments
3. ✅ response.function_call_arguments.done provides complete arguments
4. ✅ response.output_item.done provides complete function call with name
5. ✅ Full streaming sequence from user logs works correctly

All tests pass successfully, including existing adapter, finish reason, and strict mode tests.

## Impact

This change enables:
- Proper detection of streaming function calls from GPT-5.x models
- Real-time accumulation of function arguments as they stream
- Complete function call data when streaming is finished
- Tool execution workflow to proceed correctly

## How It Works

The streaming events are processed by the existing `ToolExecutor` which:
1. Collects tool call chunks as they arrive
2. Accumulates arguments from delta events
3. Uses the complete arguments from the done event
4. Executes the tools when the response is complete

The finish reason is still determined by checking if tool calls are present in the final output.

## Files Modified

- `/server/adapters/toolCalling/OpenAIResponsesConverter.js` - Added streaming event handlers
- `/server/tests/openaiResponsesStreamingFunctionCalls.test.js` - Comprehensive test coverage (new file)
- `/concepts/2026-01-19 Streaming Function Call Events.md` - This documentation (new file)

## References

- User's logs showing actual streaming events
- OpenAI Responses API streaming documentation
- Previous fixes: finish reason detection and strict mode requirements
