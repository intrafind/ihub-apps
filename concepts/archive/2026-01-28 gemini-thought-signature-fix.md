# Gemini 3 ThoughtSignature Fix - Implementation Summary

## Issue Description

When using Gemini 3 Flash/Pro models with thinking enabled and tool calling, the system failed on the second API request (after the first tool execution) with a 400 error indicating a missing `thought_signature`.

### Root Cause

Gemini 3 models with thinking enabled return a `thoughtSignature` field in response parts. According to Google's API documentation, this signature is an opaque token representing the model's internal reasoning state at that step. When continuing a multi-turn conversation with tool calls, **ALL thoughtSignatures must be passed back exactly as received**, otherwise the API rejects the request with `INVALID_ARGUMENT` error.

**Critical Discovery:** ThoughtSignatures can appear in BOTH:
1. **Text parts** - Regular response content with thinking
2. **Function call parts** - Tool calls with thinking

The system was only preserving thoughtSignatures from function call parts, **losing the signatures from text parts**. This caused the validation error on continuation requests.

The system was:
1. ✅ Extracting thoughtSignatures from function call parts
2. ❌ **Discarding thoughtSignatures from text parts**
3. ✅ Preserving function call signatures through tool execution
4. ❌ **Not reconstructing text part signatures in continuation requests**

## Solution

The fix ensures **ALL** thoughtSignatures (from both text and function call parts) are preserved and passed through all stages of the tool calling flow:

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

### 3. Tool Call Collection (ToolExecutor.js) - NEW: Collect ALL thoughtSignatures

**Added:**
```javascript
const collectedThoughtSignatures = []; // Collect ALL signatures from response

// During response processing:
if (result.thoughtSignatures && result.thoughtSignatures.length > 0) {
  collectedThoughtSignatures.push(...result.thoughtSignatures);
}

// When creating assistant message:
const assistantMessage = { role: 'assistant', tool_calls: collectedToolCalls };
assistantMessage.content = assistantContent || null;

// Preserve ALL thoughtSignatures (from both text and function call parts)
if (collectedThoughtSignatures.length > 0) {
  assistantMessage.thoughtSignatures = collectedThoughtSignatures;
}
```

### 4. Message Formatting (google.js) - NEW: Reconstruct with ALL signatures

**Before:**
```javascript
const parts = [];
if (message.content) {
  parts.push({ text: message.content }); // No signature!
}
for (const call of message.tool_calls) {
  parts.push({
    functionCall: {...},
    thoughtSignature: call.metadata?.thoughtSignature // Only function call signature
  });
}
```

**After:**
```javascript
const parts = [];

// Add text part with its thoughtSignature if present
if (message.content) {
  const textPart = { text: message.content };
  
  // Find thoughtSignatures not in tool_calls metadata (these belong to text parts)
  if (message.thoughtSignatures) {
    const toolCallSignatures = message.tool_calls
      .map(call => call.metadata?.thoughtSignature)
      .filter(Boolean);
    const unusedSignatures = message.thoughtSignatures.filter(
      sig => !toolCallSignatures.includes(sig)
    );
    
    if (unusedSignatures.length > 0) {
      textPart.thoughtSignature = unusedSignatures[0]; // Add to text part!
    }
  }
  
  parts.push(textPart);
}

// Add function call parts with their signatures
for (const call of message.tool_calls) {
  const functionCallPart = {
    functionCall: {
      name: normalizeToolName(call.function.name),
      args: argsObj
    }
  };
  
  // Include thoughtSignature from metadata
  if (call.metadata && call.metadata.thoughtSignature) {
    functionCallPart.thoughtSignature = call.metadata.thoughtSignature;
  }
  
  parts.push(functionCallPart);
}
```

## Data Flow

**Complete Flow with Text and Function Call Signatures:**

```
1. Gemini API Response
   ↓
   {
     role: "model",
     parts: [
       {text: "Let me search...", thoughtSignature: "text_sig_abc"},
       {functionCall: {name: "search", args: {...}}, thoughtSignature: "func_sig_xyz"}
     ]
   }
   ↓
2. GoogleConverter.convertGoogleResponseToGeneric()
   ↓
   {
     content: ["Let me search..."],
     tool_calls: [{
       function: {name: "search", ...},
       metadata: {thoughtSignature: "func_sig_xyz"}
     }],
     thoughtSignatures: ["text_sig_abc", "func_sig_xyz"]  ← ALL signatures collected
   }
   ↓
3. ToolExecutor collects and preserves
   ↓
   assistantMessage = {
     role: "assistant",
     content: "Let me search...",
     tool_calls: [{metadata: {thoughtSignature: "func_sig_xyz"}}],
     thoughtSignatures: ["text_sig_abc", "func_sig_xyz"]  ← Preserved
   }
   ↓
4. GoogleAdapter.formatMessages() reconstructs
   ↓
   {
     role: "model",
     parts: [
       {text: "Let me search...", thoughtSignature: "text_sig_abc"},  ← Restored!
       {functionCall: {...}, thoughtSignature: "func_sig_xyz"}
     ]
   }
   ↓
5. Next Gemini API Request (continuation)
   ↓
   ✅ Request accepted - ALL signatures present!
```

## Old Data Flow (Missing Text Signatures - BROKEN)

```
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
