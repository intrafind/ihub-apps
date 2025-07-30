# Generic Tool Calling System

This directory contains a unified tool calling system that provides seamless bidirectional conversion between different LLM provider formats (OpenAI, Anthropic, Google Gemini, Mistral).

## Overview

The generic tool calling system solves the problem of having to maintain provider-specific tool calling logic throughout the codebase. Instead of handling each provider's unique format separately, this system provides:

- **Unified Interface**: Work with tools using a single, normalized format
- **Bidirectional Conversion**: Convert between any provider formats seamlessly  
- **Cross-Provider Compatibility**: Use OpenAI tools with Anthropic, Google tools with Mistral, etc.
- **Simplified Maintenance**: Add new providers by implementing a single converter interface

## Architecture

### Core Components

1. **`GenericToolCalling.js`** - Core types and utilities for the normalized format
2. **Provider Converters** - Individual converters for each provider:
   - `OpenAIConverter.js` - OpenAI format ↔ Generic format
   - `AnthropicConverter.js` - Anthropic format ↔ Generic format  
   - `GoogleConverter.js` - Google Gemini format ↔ Generic format
   - `MistralConverter.js` - Mistral format ↔ Generic format
3. **`ToolCallingConverter.js`** - Main interface for cross-provider conversions
4. **`index.js`** - Unified exports and convenience functions

### Generic Format

The system uses a normalized format that can represent tools from any provider:

```javascript
// Generic Tool Definition
{
  id: "search_web",
  name: "search_web", 
  description: "Search the web for information",
  parameters: {
    type: "object", 
    properties: {
      query: { type: "string", description: "Search query" }
    },
    required: ["query"]
  },
  metadata: { originalFormat: "openai" }
}

// Generic Tool Call
{
  id: "call_123",
  name: "search_web",
  arguments: { query: "AI news" },
  index: 0,
  metadata: { originalFormat: "anthropic" }
}

// Generic Streaming Response
{
  content: ["Hello", " world"],
  tool_calls: [{ id: "call_123", name: "search", arguments: {...} }],
  complete: false,
  error: false,
  errorMessage: null,
  finishReason: "tool_calls"
}
```

## Usage Examples

### Basic Tool Conversion

```javascript
import { convertToolsBetweenProviders } from './toolCalling/index.js';

// Convert OpenAI tools to work with Anthropic
const openaiTools = [{
  type: 'function',
  function: {
    name: 'search',
    description: 'Search for information',
    parameters: { type: 'object', properties: { query: { type: 'string' } } }
  }
}];

const anthropicTools = convertToolsBetweenProviders(openaiTools, 'openai', 'anthropic');
// Result: [{ name: 'search', description: '...', input_schema: {...} }]
```

### Processing Streaming Responses

```javascript
import { convertResponseToGeneric, convertResponseFromGeneric } from './toolCalling/index.js';

// Normalize any provider's streaming response
const genericResponse = convertResponseToGeneric(rawAnthropicData, 'anthropic');

// Convert to OpenAI format for consistent handling
const openaiChunk = convertResponseFromGeneric(
  genericResponse, 
  'openai', 
  { completionId: 'chat-123', modelId: 'gpt-4', isFirstChunk: true }
);
```

### Creating a Unified Interface

```javascript
import { createUnifiedInterface } from './toolCalling/index.js';

const anthropicInterface = createUnifiedInterface('anthropic');

// Now you can work with Anthropic using a consistent interface
const genericTools = anthropicInterface.convertToolsToGeneric(anthropicTools);
const openaiTools = anthropicInterface.convertToolsTo(anthropicTools, 'openai');
const genericResponse = anthropicInterface.convertResponseToGeneric(rawData);
```

## Provider Format Differences

### Tool Definitions

| Provider | Format |
|----------|--------|
| OpenAI | `{ type: "function", function: { name, description, parameters } }` |
| Anthropic | `{ name, description, input_schema }` |
| Google | `{ functionDeclarations: [{ name, description, parameters }] }` |
| Mistral | Same as OpenAI |

### Tool Calls

| Provider | Format |
|----------|--------|
| OpenAI | `{ id, type: "function", function: { name, arguments } }` |
| Anthropic | `{ type: "tool_use", id, name, input }` |
| Google | `{ functionCall: { name, args } }` |
| Mistral | Same as OpenAI |

### Streaming Responses

| Provider | Tool Call Events |
|----------|------------------|
| OpenAI | `choices[0].delta.tool_calls` |
| Anthropic | `content_block_start` + `content_block_delta` events |
| Google | `candidates[0].content.parts[].functionCall` |
| Mistral | Same as OpenAI |

## API Reference

### Main Conversion Functions

#### `convertToolsBetweenProviders(tools, sourceProvider, targetProvider)`
Convert tools between any two provider formats.

#### `convertResponseToGeneric(data, sourceProvider)`
Convert any provider's response to the generic format.

#### `convertResponseFromGeneric(genericResponse, targetProvider, options)`
Convert generic response to any provider's format.

### Utility Functions

#### `normalizeToolName(name)`
Normalize tool names to be compatible with all providers.

#### `normalizeFinishReason(reason, provider)`
Normalize finish reasons across providers (`"stop"`, `"length"`, `"tool_calls"`, `"content_filter"`).

#### `sanitizeSchemaForProvider(schema, provider)`
Clean JSON Schema for provider-specific compatibility.

### Error Handling

The system includes custom error types:

- `ToolCallingError` - Base error for tool calling operations
- `UnsupportedProviderError` - When an unsupported provider is used
- `ConversionError` - When conversion between formats fails

## Migration Guide

### From Old System

The old system required provider-specific handling:

```javascript
// OLD: Provider-specific handling
if (model.provider === 'openai') {
  // OpenAI-specific logic
} else if (model.provider === 'anthropic') {
  // Anthropic-specific logic
} else if (model.provider === 'google') {
  // Google-specific logic
}
```

The new system uses unified processing:

```javascript
// NEW: Unified handling
const genericResponse = convertResponseToGeneric(data, model.provider);
const openaiResponse = convertResponseFromGeneric(genericResponse, 'openai', options);
```

### Breaking Changes

1. **`processResponseBuffer` deprecated** - Use `convertResponseToGeneric` instead
2. **Provider-specific formatters deprecated** - Use `convertToolsBetweenProviders` instead
3. **Manual response transformation removed** - System handles all conversions automatically

## Testing

The system includes comprehensive tests that verify:

- Tool format consistency across providers
- Request generation compatibility
- Multi-round conversation handling
- Message format consistency
- Streaming response processing

Run tests with:
```bash
npm run test:tool-calling
```

## Contributing

When adding a new provider:

1. Create a new converter file (e.g., `NewProviderConverter.js`)
2. Implement the required conversion functions:
   - `convertGenericToolsToNewProvider(genericTools)`
   - `convertNewProviderToolsToGeneric(providerTools)`
   - `convertGenericToolCallsToNewProvider(genericToolCalls)`
   - `convertNewProviderToolCallsToGeneric(providerToolCalls)`
   - `convertNewProviderResponseToGeneric(data)`
   - `convertGenericResponseToNewProvider(genericResponse, options)`
3. Add the converter to the registry in `ToolCallingConverter.js`
4. Add test cases to verify compatibility

## Implementation Details

### Why Generic Format?

The generic format was designed to be a superset that can represent features from all providers:

- **OpenAI**: Simple function-based tools
- **Anthropic**: Rich input schemas with validation
- **Google**: Function declarations with parameters
- **Mistral**: OpenAI-compatible format

### Performance Considerations

- **Lazy Loading**: Converters are only loaded when needed
- **Caching**: Converted tools are cached to avoid repeated conversions
- **Streaming Optimized**: Minimal overhead for streaming response processing

### Error Recovery

The system includes robust error handling:
- Malformed tool definitions are sanitized automatically
- Invalid JSON in tool arguments is handled gracefully
- Provider-specific quirks are normalized away
- Fallback mechanisms for unsupported features

This generic tool calling system eliminates the complexity of managing multiple provider formats while maintaining full compatibility with each provider's unique features.