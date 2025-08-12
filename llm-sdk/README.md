# LLM SDK

A unified, extensible SDK for integrating multiple Large Language Model (LLM) providers with a consistent API. This SDK provides a standardized interface for OpenAI, Anthropic, Google Gemini, and other LLM providers while supporting advanced features like tool calling, streaming, structured output, and multimodal inputs.

## Features

- 🔧 **Unified API**: Single interface for multiple LLM providers
- 🛠️ **Tool Calling**: Cross-provider tool/function calling support
- 📡 **Streaming**: Real-time response streaming
- 🎯 **Structured Output**: JSON schema-based response formatting
- 🖼️ **Multimodal**: Image processing and vision capabilities
- ⚙️ **Configuration Management**: Flexible configuration with environment variable support
- 🔒 **Type Safety**: Comprehensive validation and error handling
- 📊 **Logging**: Structured logging with configurable levels
- 🧪 **Testing**: Extensive test coverage and mocking support

## Supported Providers

| Provider  | Models               | Tools | Streaming | Images | Structured Output |
| --------- | -------------------- | ----- | --------- | ------ | ----------------- |
| OpenAI    | GPT-4, GPT-3.5-turbo | ✅    | ✅        | ✅     | ✅                |
| Anthropic | Claude 3.x series    | ✅    | ✅        | ✅     | ✅\*              |
| Google    | Gemini Pro/Flash     | ✅    | ✅        | ✅     | ❌                |
| Mistral   | Mistral models       | ✅    | ✅        | ❌     | ❌                |
| VLLM      | Custom endpoints     | ✅    | ✅        | ❌     | ❌                |

\*via tool calling approach

## Installation

```bash
npm install llm-sdk
```

## Quick Start

### Basic Usage

```javascript
import { createSimpleClient, Message } from 'llm-sdk';

// Create a client with OpenAI
const client = createSimpleClient('openai', 'sk-your-api-key');
await client.ready(); // Wait for initialization

// Send a chat message
const response = await client.chat({
  model: 'gpt-4',
  messages: [
    Message.system('You are a helpful assistant.'),
    Message.user('What is the capital of France?')
  ]
});

console.log(response.content); // "The capital of France is Paris."
```

### Multi-Provider Setup

```javascript
import { LLMClient } from 'llm-sdk';

const client = new LLMClient({
  providers: {
    openai: {
      apiKey: process.env.OPENAI_API_KEY
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY
    },
    google: {
      apiKey: process.env.GOOGLE_API_KEY
    }
  },
  defaultProvider: 'openai'
});

await client.ready();

// Use different providers
const openaiResponse = await client.chat({
  provider: 'openai',
  model: 'gpt-4',
  messages: [Message.user('Hello from OpenAI!')]
});

const claudeResponse = await client.chat({
  provider: 'anthropic',
  model: 'claude-3-5-sonnet-20241022',
  messages: [Message.user('Hello from Claude!')]
});
```

### Streaming Responses

```javascript
const stream = await client.stream({
  model: 'gpt-4',
  messages: [Message.user('Tell me a story')],
  maxTokens: 200
});

for await (const chunk of stream) {
  if (chunk.content) {
    process.stdout.write(chunk.content);
  }

  if (chunk.isFinal()) {
    console.log('\nStream completed!');
    break;
  }
}
```

### Tool Calling

```javascript
const tools = [
  {
    name: 'get_weather',
    description: 'Get weather information for a location',
    parameters: {
      type: 'object',
      properties: {
        location: { type: 'string', description: 'City name' },
        unit: { type: 'string', enum: ['celsius', 'fahrenheit'] }
      },
      required: ['location']
    }
  }
];

const response = await client.chat({
  model: 'gpt-4',
  messages: [Message.user("What's the weather in London?")],
  tools,
  toolChoice: 'auto'
});

if (response.hasToolCalls()) {
  for (const toolCall of response.toolCalls) {
    console.log(`Tool: ${toolCall.name}`, toolCall.arguments);
    // Execute tool and continue conversation...
  }
}
```

### Structured Output

```javascript
const schema = {
  type: 'object',
  properties: {
    sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    keywords: { type: 'array', items: { type: 'string' } }
  },
  required: ['sentiment', 'confidence']
};

const response = await client.chat({
  model: 'gpt-4',
  messages: [Message.user('Analyze: "I love this new product!"')],
  responseFormat: {
    type: 'json_schema',
    schema
  }
});

const analysis = JSON.parse(response.content);
console.log(analysis); // { sentiment: "positive", confidence: 0.95, keywords: [...] }
```

### Image Processing

```javascript
// With image URL
const response = await client.chat({
  model: 'gpt-4-vision-preview',
  messages: [
    Message.userWithImage('What do you see in this image?', 'https://example.com/image.jpg')
  ]
});

// With base64 image
const response = await client.chat({
  model: 'claude-3-5-sonnet-20241022',
  messages: [
    Message.userWithImage('Describe this image', {
      base64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      mimeType: 'image/png'
    })
  ]
});
```

## Configuration

### Environment Variables

The SDK supports environment variable configuration with automatic discovery:

```bash
# Provider-specific API keys
OPENAI_API_KEY=sk-your-openai-key
ANTHROPIC_API_KEY=sk-ant-your-anthropic-key
GOOGLE_API_KEY=your-google-key

# SDK-specific overrides
LLM_SDK_OPENAI_API_KEY=sk-override-key
LLM_SDK_OPENAI_BASE_URL=https://custom.openai.com
LLM_SDK_OPENAI_TIMEOUT=30000
LLM_SDK_DEFAULT_PROVIDER=openai

# Logging
LOG_LEVEL=INFO
```

### Configuration File

```javascript
import { LLMClient, ModelConfig, ProviderConfig } from 'llm-sdk';

// Load provider configurations
const providerConfig = new ProviderConfig({
  allowEnvOverrides: true,
  envPrefix: 'LLM_SDK'
});

providerConfig.load({
  openai: {
    apiKey: '${OPENAI_API_KEY}',
    timeout: 30000,
    retries: 3
  },
  anthropic: {
    apiKey: '${ANTHROPIC_API_KEY}',
    baseURL: 'https://api.anthropic.com/v1'
  }
});

// Load model configurations
const modelConfig = new ModelConfig();
await modelConfig.load('./models.json');

const client = new LLMClient({
  providers: providerConfig.getAllConfigs(),
  models: modelConfig.getAllModels()
});
```

## API Reference

### LLMClient

The main SDK client class.

#### Constructor

```javascript
new LLMClient(config);
```

**Parameters:**

- `config.providers` - Provider configurations object
- `config.defaultProvider` - Default provider name (default: 'openai')
- `config.timeout` - Request timeout in ms (default: 30000)
- `config.retries` - Number of retry attempts (default: 3)
- `config.logger` - Custom logger instance

#### Methods

- `async ready()` - Wait for client initialization
- `async chat(request)` - Send chat completion request
- `async stream(request)` - Send streaming chat request
- `getAvailableModels(provider?)` - Get available models
- `getProviders()` - Get configured providers
- `getProvider(name)` - Get specific provider instance
- `async testProvider(name?)` - Test provider connection

### Message

Message construction utilities.

#### Static Methods

- `Message.system(content)` - Create system message
- `Message.user(content)` - Create user message
- `Message.assistant(content)` - Create assistant message
- `Message.userWithImage(text, imageData)` - Create user message with image
- `Message.toolResponse(toolCallId, result, toolName)` - Create tool response

### Providers

Individual provider classes for direct access.

#### OpenAIProvider

```javascript
import { OpenAIProvider } from 'llm-sdk';

const provider = new OpenAIProvider({
  apiKey: 'sk-your-key',
  baseURL: 'https://api.openai.com/v1' // optional
});
```

#### AnthropicProvider

```javascript
import { AnthropicProvider } from 'llm-sdk';

const provider = new AnthropicProvider({
  apiKey: 'sk-ant-your-key',
  apiVersion: '2023-06-01' // optional
});
```

#### GoogleProvider

```javascript
import { GoogleProvider } from 'llm-sdk';

const provider = new GoogleProvider({
  apiKey: 'your-google-key'
});
```

## Error Handling

The SDK provides comprehensive error handling with specific error types:

```javascript
import {
  ConfigurationError,
  ValidationError,
  ProviderError,
  NetworkError,
  RateLimitError
} from 'llm-sdk';

try {
  const response = await client.chat(request);
} catch (error) {
  if (error instanceof ConfigurationError) {
    console.log('Configuration issue:', error.message);
  } else if (error instanceof RateLimitError) {
    console.log('Rate limited, retry after:', error.retryAfter);
  } else if (error instanceof NetworkError) {
    console.log('Network error:', error.message);
  }
}
```

## Testing

The SDK includes comprehensive testing utilities:

```javascript
import { createMockProvider } from 'llm-sdk/testing';

// Create mock provider for testing
const mockProvider = createMockProvider({
  responses: [{ content: 'Mocked response 1' }, { content: 'Mocked response 2' }]
});

const client = new LLMClient({
  providers: { mock: mockProvider }
});
```

## Migration from Legacy Adapters

For existing iHub Apps or similar systems, use the `LegacyAdapter`:

```javascript
import { LegacyAdapter } from 'llm-sdk/adapters';

// Create legacy-compatible adapter
const adapter = new LegacyAdapter({
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY },
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY }
  }
});

// Use with existing code
const request = await adapter.createCompletionRequest(model, messages, apiKey, options);
const result = adapter.processResponseBuffer(provider, chunk);
```

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make your changes with tests
4. Run the test suite: `npm test`
5. Submit a pull request

### Adding New Providers

To add a new provider:

1. Extend the `Provider` base class
2. Implement required methods (`chat`, `stream`, `formatMessages`, `parseResponse`)
3. Add provider to the registry in `src/providers/index.js`
4. Create comprehensive tests
5. Update documentation

## License

MIT License - see LICENSE file for details.

## Support

- GitHub Issues: Report bugs and feature requests
- Documentation: Complete API documentation in `/docs`
- Examples: Working examples in `/examples`
