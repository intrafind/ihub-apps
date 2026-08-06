# OpenAI Response API Support for GPT-5

## Overview

This document describes the implementation of support for OpenAI's new Response API, which is required for GPT-5 and newer models. The implementation maintains backward compatibility with the existing Chat Completions API.

## Background

OpenAI released the Response API alongside GPT-5 as an evolution of the Chat Completions API. The new API incorporates several improvements:

- Better performance with reasoning models (3% improvement on SWE-bench)
- Agentic loop with built-in tools (web search, file search, code interpreter, etc.)
- Lower costs due to improved cache utilization (40-80% improvement)
- Stateful context with `store: true` by default
- Flexible inputs (string or array of messages)
- Native multimodal support
- Future-proofed for upcoming models

## Key Differences from Chat Completions API

### Endpoint
- **Chat Completions**: `/v1/chat/completions`
- **Responses API**: `/v1/responses`

### Request Structure
- **Input**: Uses `input` field instead of `messages` (but accepts both)
- **Instructions**: Separate `instructions` field for system-level guidance
- **Tools**: Internally-tagged format (no nested `function` object), strict by default
- **Structured Outputs**: Uses `text.format` instead of `response_format`
- **Token Limit**: Uses `max_output_tokens` instead of `max_tokens`
- **Temperature**: NOT supported (GPT-5 uses fixed temperature of 1.0)
- **Control Parameters**: Use `verbosity` and `reasoning.effort` instead of temperature
- **Statefulness**: `store: true` by default for maintaining conversation context

### Response Structure
- **Output**: Returns `output` array of Items instead of `choices`
- **Items**: Union type representing message, function_call, reasoning, etc.
- **Text Extraction**: `output_text` helper for easy text extraction
- **Reasoning**: Separate reasoning items with summary (full reasoning encrypted for ZDR)

### Unsupported Parameters (GPT-5)
The following parameters from Chat Completions are NOT supported:
- ❌ `temperature` (fixed at 1.0)
- ❌ `top_p`
- ❌ `presence_penalty`
- ❌ `frequency_penalty`

**Alternatives for Output Control:**
- ✅ `verbosity`: "low", "medium", "high" - Controls detail level
- ✅ `reasoning.effort`: "minimal", "low", "medium", "high" - Controls reasoning depth

## Implementation

### Architecture

The implementation follows the existing adapter pattern used in the repository:

```
server/
├── adapters/
│   ├── openai.js                    # Original Chat Completions adapter (unchanged)
│   ├── openai-responses.js          # New Responses API adapter
│   ├── index.js                     # Updated to register new adapter
│   └── toolCalling/
│       ├── OpenAIConverter.js       # Original OpenAI tool converter (unchanged)
│       ├── OpenAIResponsesConverter.js  # New Responses API tool converter
│       ├── ToolCallingConverter.js  # Updated to include new converter
│       └── index.js                 # Updated exports
└── validators/
    └── modelConfigSchema.js         # Updated to accept 'openai-responses' provider
```

### Files Created/Modified

**Created:**
1. `server/adapters/openai-responses.js` - New adapter for Responses API
2. `server/adapters/toolCalling/OpenAIResponsesConverter.js` - Tool calling converter
3. `examples/models/gpt-5.json` - Example GPT-5 model configuration
4. `server/defaults/models/gpt-5.json` - Default GPT-5 model configuration

**Modified:**
1. `server/adapters/index.js` - Registered new adapter
2. `server/adapters/toolCalling/ToolCallingConverter.js` - Added new converter mapping
3. `server/adapters/toolCalling/index.js` - Exported new converter
4. `server/validators/modelConfigSchema.js` - Added 'openai-responses' to provider enum
5. `docs/models.md` - Updated documentation

### Adapter Implementation Details

#### openai-responses.js

The new adapter extends `BaseAdapter` and implements:

1. **formatMessages(messages)**: Formats messages for Responses API
   - Handles image data (single and multiple images)
   - Maintains compatibility with existing message format

2. **separateInstructions(messages)**: Extracts system messages
   - System messages are converted to top-level `instructions` field
   - Non-system messages become the `input`

3. **createCompletionRequest(model, messages, apiKey, options)**: Creates API request
   - Separates instructions from input
   - Uses `text.format` for structured outputs instead of `response_format`
   - Sets `store: true` by default for statefulness
   - Converts tools to Responses API format

4. **processResponseBuffer(data)**: Processes streaming responses
   - Handles `output` array of Items
   - Extracts text from `output_text` content items
   - Processes function calls
   - Ignores reasoning items (summary only)

#### OpenAIResponsesConverter.js

The tool calling converter implements:

1. **convertGenericToolsToOpenaiResponses**: Converts to internally-tagged format
2. **convertOpenaiResponsesToolsToGeneric**: Converts from Responses format
3. **convertGenericToolCallsToOpenaiResponses**: Converts tool call requests
4. **convertOpenaiResponsesToolCallsToGeneric**: Converts tool call responses
5. **convertOpenaiResponsesResponseToGeneric**: Processes streaming responses

### Configuration

To use GPT-5 with the Responses API, create a model configuration:

```json
{
  "id": "gpt-5",
  "modelId": "gpt-5",
  "name": {
    "en": "GPT-5",
    "de": "GPT-5"
  },
  "description": {
    "en": "OpenAI's most advanced reasoning model",
    "de": "OpenAIs fortschrittlichstes Reasoning-Modell"
  },
  "url": "https://api.openai.com/v1/responses",
  "provider": "openai-responses",
  "tokenLimit": 128000,
  "supportsTools": true,
  "enabled": true,
  "default": false
}
```

**Required Environment Variable:**
- `OPENAI_API_KEY` - Same API key used for Chat Completions

## Backward Compatibility

The implementation maintains full backward compatibility:

1. **Existing OpenAI Adapter**: Unchanged, continues to work with GPT-4 and older models
2. **Separate Provider**: New `openai-responses` provider doesn't affect existing `openai` provider
3. **API Key**: Uses the same `OPENAI_API_KEY` environment variable
4. **Model Configurations**: Existing model configurations continue to work

## Testing

The implementation was validated by:

1. **Server Startup**: Server starts successfully and loads the new model configuration
2. **Linting**: Code passes ESLint checks with no errors
3. **Formatting**: Code passes Prettier formatting checks
4. **Integration**: New adapter integrates seamlessly with existing adapter registry

## Future Enhancements

Potential future enhancements include:

1. **Built-in Tools**: Expose OpenAI's native tools (web search, file search, code interpreter)
2. **Reasoning Visibility**: Option to show reasoning summaries to users
3. **Encrypted Reasoning**: Support for ZDR organizations with encrypted reasoning items
4. **Previous Response ID**: Support for `previous_response_id` for conversation chains
5. **Conversations API**: Integration with OpenAI's Conversations API for persistent state

## Known Issues and Fixes

### Tool Calling Fix (2026-01-19)

**Issue**: Tool calling was not working because the finish reason was always set to 'stop' even when tool calls were present.

**Root Cause**: The OpenAI Responses API does NOT include a `finish_reason` field (unlike Chat Completions API). Instead, it uses `status` and `incomplete_details` to indicate completion status. The implementation needs to determine the finish reason by checking if tool calls are present in the output.

**Solution**: Modified both `OpenAIResponsesConverter.js` and `openai-responses.js` to check for the presence of tool calls in the output and set finish reason accordingly:
- `'tool_calls'` when function_call items are present in the output
- `'stop'` when no tool calls are present

**Files Modified**:
- `/server/adapters/openai-responses.js` - Line 319: Check tool_calls array length
- `/server/adapters/toolCalling/OpenAIResponsesConverter.js` - Lines 146-151, 249, 276: Check for function_call items in output

**Tests Added**:
- `/server/tests/openaiResponsesFinishReason.test.js` - Comprehensive test coverage for finish reason handling

## References

- [OpenAI Responses API Documentation](https://platform.openai.com/docs/api-reference/responses)
- [Migration Guide](https://platform.openai.com/docs/guides/migrate-to-responses)
- [Reasoning Models Guide](https://platform.openai.com/docs/guides/reasoning)

## Code Locations

- Adapter: `/server/adapters/openai-responses.js`
- Tool Converter: `/server/adapters/toolCalling/OpenAIResponsesConverter.js`
- Model Schema: `/server/validators/modelConfigSchema.js`
- Example Config: `/examples/models/gpt-5.json`
- Documentation: `/docs/models.md`
