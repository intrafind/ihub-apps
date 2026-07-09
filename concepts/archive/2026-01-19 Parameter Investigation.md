# Parameter Investigation: OpenAI Responses API

## Investigation Date
2026-01-19

## Issues Investigated
User requested investigation of parameter changes in OpenAI Responses API:
1. `max_tokens` support status - FIXED
2. Tool/function calling schema changes - VERIFIED CORRECT
3. `temperature` parameter support - FIXED

## Findings

### 1. Token Limit Parameter Change ✅ FIXED

**Issue Found:** The implementation was using `max_tokens` which is the Chat Completions API parameter.

**Correct Parameter:** The Responses API uses `max_output_tokens` instead.

**Details:**
- **Chat Completions API**: Uses `max_tokens` to limit completion length
- **Responses API**: Uses `max_output_tokens` to limit output length
- **Maximum value**: 128,000 tokens for GPT-5 models
- **Context window**: 400,000 total tokens (input + output)

**Source:** OpenAI API documentation and developer guides confirm this parameter name change.

### 2. Tool/Function Calling Schema ✅ CORRECT

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

### 3. Temperature Parameter NOT Supported ✅ FIXED

**Issue Found:** The implementation was including `temperature` parameter which is NOT supported by GPT-5 models.

**Error Message:**
```
"Unsupported parameter: 'temperature' is not supported with this model."
```

**Details:**
- **GPT-5 models**: Do NOT support the `temperature` parameter
- **Fixed Value**: GPT-5 uses a fixed temperature of 1.0
- **Reason**: GPT-5's reasoning architecture handles output diversity internally
- **Alternatives**: Use `verbosity` and `reasoning.effort` parameters instead

**Supported Control Parameters for GPT-5:**
- `verbosity`: "low", "medium" (default), "high" - Controls detail level
- `reasoning.effort`: "minimal", "low", "medium", "high" - Controls reasoning depth
- `max_output_tokens`: Controls output length

**Not Supported by GPT-5:**
- ❌ `temperature`
- ❌ `top_p`
- ❌ `presence_penalty`
- ❌ `frequency_penalty`

## Changes Made

### 1. Fixed max_tokens → max_output_tokens
**File:** `server/adapters/openai-responses.js`
- Changed `max_tokens: maxTokens` to `max_output_tokens: maxTokens`
- Line 107

### 2. Removed temperature parameter
**File:** `server/adapters/openai-responses.js`
- Removed `temperature: parseFloat(temperature)` from request body
- Added comment explaining GPT-5 doesn't support temperature
- Line 106 (removed)

### 3. Updated Tests
**File:** `server/tests/openaiResponsesAdapter.test.js`
- Added assertions to verify `max_output_tokens` is used
- Added assertion to verify `max_tokens` is NOT present
- Added assertion to verify `temperature` is NOT present
- Tests pass successfully

### 4. Updated Documentation
**File:** `concepts/2026-01-19 OpenAI Response API Support.md`
- Added note about `max_output_tokens` vs `max_tokens` difference
- Added note about temperature not being supported
- Included in Key Differences section

**File:** `concepts/2026-01-19 Parameter Investigation.md`
- Added temperature parameter investigation
- Documented alternatives (verbosity, reasoning.effort)
- Listed unsupported parameters

## Verification

All tests pass with the corrected parameters:
- ✅ Test 1: Basic message formatting (no temperature, uses max_output_tokens)
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

2. **Temperature Parameter:**
   - NOT supported by GPT-5 models
   - Fixed at 1.0 internally
   - Use `verbosity` and `reasoning.effort` for control

3. **Tool Schema:**
   - Internally-tagged format confirmed
   - Custom tools supported (free-form)
   - Multi-turn capabilities validated

## Conclusion

**max_tokens Issue:** FIXED ✅ - Changed to `max_output_tokens`

**temperature Issue:** FIXED ✅ - Removed from request (not supported by GPT-5)

**Tool Schema:** CORRECT ✅ - Implementation matches Responses API specification

The adapter now correctly uses only the parameters supported by the Responses API and GPT-5 models.
