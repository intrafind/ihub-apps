# Parameter Investigation: OpenAI Responses API

## Investigation Date
2026-01-19

## Issue
User requested investigation of parameter changes in OpenAI Responses API, specifically:
1. `max_tokens` support status
2. Tool/function calling schema changes

## Findings

### 1. Token Limit Parameter Change

**Issue Found:** The implementation was using `max_tokens` which is the Chat Completions API parameter.

**Correct Parameter:** The Responses API uses `max_output_tokens` instead.

**Details:**
- **Chat Completions API**: Uses `max_tokens` to limit completion length
- **Responses API**: Uses `max_output_tokens` to limit output length
- **Maximum value**: 128,000 tokens for GPT-5 models
- **Context window**: 400,000 total tokens (input + output)

**Source:** OpenAI API documentation and developer guides confirm this parameter name change.

### 2. Tool/Function Calling Schema

**Investigation Result:** The implementation is CORRECT.

**Key Differences:**
- **Chat Completions** (externally-tagged):
  ```json
  {
    "type": "function",
    "function": {
      "name": "get_weather",
      "description": "...",
      "parameters": {...}
    }
  }
  ```

- **Responses API** (internally-tagged):
  ```json
  {
    "type": "function",
    "name": "get_weather",
    "description": "...",
    "parameters": {...}
  }
  ```

**Additional Features in Responses API:**
- `strict: true` is the default (no need to specify)
- Support for custom/free-form tools (no schema required)
- Multi-turn tool usage with better context preservation
- Tool allowlists and preambles for better control

**Our Implementation:** Correctly uses the flat, internally-tagged format.

## Changes Made

### 1. Fixed Parameter Name
**File:** `server/adapters/openai-responses.js`
- Changed `max_tokens: maxTokens` to `max_output_tokens: maxTokens`
- Line 107

### 2. Updated Tests
**File:** `server/tests/openaiResponsesAdapter.test.js`
- Added assertions to verify `max_output_tokens` is used
- Added assertion to verify `max_tokens` is NOT present
- Tests pass successfully

### 3. Updated Documentation
**File:** `concepts/2026-01-19 OpenAI Response API Support.md`
- Added note about `max_output_tokens` vs `max_tokens` difference
- Included in Key Differences section

## Verification

All tests pass with the corrected parameter:
- ✅ Test 1: Basic message formatting
- ✅ Test 2: Multiple user messages
- ✅ Test 3: Structured output
- ✅ Test 4: Response processing
- ✅ Test 5: Tool calls processing

## Tool Calling Validation

The tool calling schema implementation was reviewed and confirmed correct:
- ✅ Uses internally-tagged format (flat structure)
- ✅ No nested `function` object
- ✅ `strict: true` behavior matches API defaults
- ✅ Converter handles both directions correctly

## References

1. **Token Parameters:**
   - OpenAI Responses API uses `max_output_tokens`
   - Maximum: 128,000 output tokens for GPT-5
   - Context window: 400,000 total tokens

2. **Tool Schema:**
   - Internally-tagged format confirmed
   - Custom tools supported (free-form)
   - Multi-turn capabilities validated

## Conclusion

**Parameter Issue:** FIXED - Changed `max_tokens` to `max_output_tokens`

**Tool Schema:** CORRECT - Implementation matches Responses API specification

The adapter now correctly uses the Responses API parameter names and maintains the correct tool calling schema format.
