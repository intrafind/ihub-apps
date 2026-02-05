# Ask User Tool - Server-Side Implementation

**Date:** 2026-02-06
**Status:** Implemented

## Overview

This document describes the server-side implementation of the `ask_user` tool, which allows LLMs to request clarification or additional input from users during conversations.

## Files Created/Modified

### New Files

1. **`/server/tools/askUser.js`**
   - Tool implementation with validation logic
   - Exports `validateAskUserParams` for parameter validation
   - Exports `MAX_CLARIFICATIONS_PER_CONVERSATION` constant (default: 10)
   - Includes safe-regex validation to prevent ReDoS attacks
   - Defines parameter limits:
     - Max question length: 500 characters
     - Max options: 20
     - Max option label/value: 100 characters
     - Max regex pattern length: 200 characters

### Modified Files

1. **`/shared/unifiedEventSchema.js`**
   - Added `CLARIFICATION: 'clarification'` to UnifiedEvents

2. **`/server/actionTracker.js`**
   - Added `trackClarification(chatId, data)` method for emitting clarification events via SSE

3. **`/server/services/chat/ToolExecutor.js`**
   - Added clarification counter tracking per conversation
   - Added `isAskUserTool()` method to detect ask_user tool calls
   - Added `isUserInputTool()` method for generic user-input tool detection
   - Added `executeClarificationTool()` method for special handling
   - Modified `executeToolCall()` to check for ask_user before other execution paths
   - Modified tool result processing loop to handle clarification responses
   - Rate limiting: max 10 clarifications per conversation

4. **`/contents/config/tools.json`**
   - Added complete `ask_user` tool definition with multilingual descriptions

5. **`/server/defaults/config/tools.json`**
   - Added `ask_user` tool definition to defaults

## Tool Schema

```json
{
  "id": "ask_user",
  "name": { "en": "Ask User for Clarification", "de": "Benutzer um Klärung bitten" },
  "description": { ... },
  "script": "askUser.js",
  "requiresUserInput": true,
  "parameters": {
    "type": "object",
    "properties": {
      "question": { "type": "string", "maxLength": 500 },
      "input_type": { "type": "string", "enum": ["text", "select", "multiselect", "confirm", "number", "date"] },
      "options": { "type": "array", "maxItems": 20 },
      "allow_other": { "type": "boolean" },
      "allow_skip": { "type": "boolean" },
      "placeholder": { "type": "string", "maxLength": 200 },
      "validation": { "type": "object" },
      "context": { "type": "string", "maxLength": 500 }
    },
    "required": ["question"]
  }
}
```

## Event Flow

1. **LLM calls ask_user tool** with question and parameters
2. **ToolExecutor detects ask_user** in `executeToolCall()`
3. **Rate limit check** - if exceeded, returns error to LLM
4. **Parameter validation** using `validateAskUserParams()`
5. **Clarification event emitted** via `actionTracker.trackClarification()`
6. **Done event emitted** with `finishReason: 'clarification'`
7. **Processing stops** - awaiting user response

## SSE Event Format

```javascript
{
  event: 'clarification',
  chatId: '...',
  toolCallId: '...',
  question: 'What format would you like the report in?',
  input_type: 'select',
  options: [
    { label: 'PDF', value: 'pdf' },
    { label: 'Word Document', value: 'docx' }
  ],
  allow_skip: false,
  clarificationNumber: 1,
  maxClarifications: 10,
  timestamp: '2026-02-06T10:30:00.000Z'
}
```

## Rate Limiting

- Maximum 10 clarifications per conversation
- Counter stored in `ToolExecutor.clarificationCounts` Map
- When limit reached, LLM receives error message:
  > "Maximum clarification limit (10) reached for this conversation. Please proceed with the available information or make reasonable assumptions."

## Security Measures

### ReDoS Prevention
Regex patterns are validated for unsafe patterns that could cause exponential backtracking:
- `(.*)+`
- `(.+)+`
- Nested quantifiers like `(a+)+`, `(a*)*`
- Pattern length limited to 200 characters

### Input Sanitization
- Question text limited to 500 characters
- Option labels/values limited to 100 characters
- Placeholder text limited to 200 characters
- Context text limited to 500 characters

## Testing the Implementation

To test the ask_user tool:

1. Add `"ask_user"` to an app's tools array in `contents/apps/{app}.json`
2. Send a request that the LLM might find ambiguous
3. The LLM should call the ask_user tool
4. Client should receive the clarification SSE event
5. Client displays the clarification UI
6. User responds
7. Response is sent back to continue the conversation

## Next Steps (Client-Side)

The client-side implementation needs to:
1. Handle the `clarification` SSE event
2. Display appropriate UI based on `input_type`
3. Collect user response
4. Send response back as a new user message
5. Resume conversation with LLM receiving the clarification response
