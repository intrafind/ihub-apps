# Gemini 3 ThoughtSignature Fix - Implementation Summary

## Issue Description

When using Gemini 3 Flash/Pro models with thinking enabled and tool calling, the system failed on the second API request (after the first tool execution) with a 400 error indicating a missing `thought_signature`.

### Root Cause

Gemini 3 models with thinking enabled return a `thoughtSignature` field in response parts that contain function calls. According to Google's API documentation, this signature is an opaque token representing the model's internal reasoning state at that step. When continuing a multi-turn conversation with tool calls, this signature MUST be included in the corresponding function call part, otherwise the API rejects the request with `INVALID_ARGUMENT` error.

The system was correctly collecting `thoughtSignatures` from responses but was not:
1. Associating them with specific tool calls
2. Preserving them through the tool execution flow
3. Including them when formatting continuation requests

## Solution

The fix ensures `thoughtSignature` is preserved and passed through all stages of the tool calling flow:

### 1. Response Parsing (GoogleConverter.js)

**Before:**
```javascript
result.tool_calls.push(
  createGenericToolCall(
    `call_${result.tool_calls.length}_${Date.now()}`,
    part.functionCall.name,
    part.functionCall.args || {},
    result.tool_calls.length,
    { originalFormat: 'google' }  // thoughtSignature not included
  )
);
```

**After:**
```javascript
const metadata = { originalFormat: 'google' };
if (part.thoughtSignature) {
  metadata.thoughtSignature = part.thoughtSignature;
}
result.tool_calls.push(
  createGenericToolCall(
    `call_${result.tool_calls.length}_${Date.now()}`,
    part.functionCall.name,
    part.functionCall.args || {},
    result.tool_calls.length,
    metadata  // thoughtSignature now in metadata
  )
);
```

### 2. Tool Call Collection (ToolExecutor.js)

**Before:**
```javascript
collectedToolCalls.push({
  index: call.index,
  id: call.id || null,
  type: call.type || 'function',
  function: {
    name: call.function?.name || '',
    arguments: call.function?.arguments || ''
  }
  // metadata not preserved
});
```

**After:**
```javascript
collectedToolCalls.push({
  index: call.index,
  id: call.id || null,
  type: call.type || 'function',
  function: {
    name: call.function?.name || '',
    arguments: call.function?.arguments || ''
  },
  // Preserve metadata for provider-specific requirements
  metadata: call.metadata || {}
});
```

### 3. Message Formatting (google.js)

**Before:**
```javascript
for (const call of message.tool_calls) {
  let argsObj = this.safeJsonParse(call.function.arguments, {});
  parts.push({
    functionCall: {
      name: normalizeToolName(call.function.name),
      args: argsObj
    }
    // thoughtSignature not included
  });
}
```

**After:**
```javascript
for (const call of message.tool_calls) {
  let argsObj = this.safeJsonParse(call.function.arguments, {});
  const functionCallPart = {
    functionCall: {
      name: normalizeToolName(call.function.name),
      args: argsObj
    }
  };
  
  // Include thoughtSignature if present (required for Gemini 3 with thinking)
  if (call.metadata && call.metadata.thoughtSignature) {
    functionCallPart.thoughtSignature = call.metadata.thoughtSignature;
  }
  
  parts.push(functionCallPart);
}
```

## Data Flow

```
1. Gemini API Response
   ↓
   {
     parts: [{
       functionCall: { name: "tool", args: {...} },
       thoughtSignature: "AgQKA..."  ← Signature from API
     }]
   }
   ↓
2. GoogleConverter.convertGoogleResponseToGeneric()
   ↓
   {
     tool_calls: [{
       metadata: {
         thoughtSignature: "AgQKA..."  ← Stored in metadata
       }
     }]
   }
   ↓
3. ToolExecutor collects tool calls
   ↓
   assistantMessage = {
     tool_calls: [{
       metadata: {
         thoughtSignature: "AgQKA..."  ← Preserved
       }
     }]
   }
   ↓
4. GoogleAdapter.formatMessages()
   ↓
   {
     parts: [{
       functionCall: { name: "tool", args: {...} },
       thoughtSignature: "AgQKA..."  ← Included in request
     }]
   }
   ↓
5. Next Gemini API Request (continuation)
   ↓
   ✅ Request accepted by API
```

## Testing

Created comprehensive test suite (`server/tests/gemini-thought-signature.test.js`) covering:

1. **Response Parsing**: Verify thoughtSignature extraction from Gemini responses
2. **Multiple Tool Calls**: Ensure each tool call preserves its own signature
3. **Graceful Degradation**: Handle responses without thoughtSignature
4. **Message Formatting**: Verify thoughtSignature inclusion in continuation requests
5. **End-to-End Flow**: Validate complete conversation cycle

All 7 tests passing ✅

## Backward Compatibility

The fix maintains backward compatibility:

- **Preserves `thoughtSignatures` array**: Original code that collected signatures in a separate array is preserved
- **Optional field**: `thoughtSignature` is only added when present in the response
- **Non-thinking models**: Models without thinking enabled continue to work as before
- **Metadata-agnostic**: Other providers not affected as metadata is provider-specific

## References

- [Google Gemini Thought Signatures Documentation](https://ai.google.dev/gemini-api/docs/thought-signatures)
- [Vertex AI Thought Signatures Guide](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/thought-signatures)
- Issue: "Gemini 3 Flash/Pro - Tool usage broken?"

## Related Files

- `server/adapters/toolCalling/GoogleConverter.js` - Response parsing
- `server/adapters/google.js` - Message formatting
- `server/services/chat/ToolExecutor.js` - Tool call collection
- `server/tests/gemini-thought-signature.test.js` - Test suite
