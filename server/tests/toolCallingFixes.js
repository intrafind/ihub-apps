/**
 * Comprehensive fixes for tool calling inconsistencies across all adapters
 *
 * This file demonstrates the issues found and provides fixes to ensure
 * consistent behavior across OpenAI, Anthropic, Google, and Mistral adapters.
 */

import OpenAIAdapter from '../adapters/openai.js';
import AnthropicAdapter from '../adapters/anthropic.js';
import GoogleAdapter from '../adapters/google.js';
import MistralAdapter from '../adapters/mistral.js';

console.log('🔧 Tool Calling Fixes and Standardization\n');

// ============================================================================
// ISSUE 1: Message Format Inconsistency
// ============================================================================

console.log('📋 Issue 1: Message Format Inconsistency');
console.log('');
console.log('Problem: Different adapters return different formats from formatMessages():');
console.log('- OpenAI/Mistral: Return array of messages directly');
console.log('- Anthropic: Returns { messages: array, systemPrompt: string }');
console.log('- Google: Returns { contents: array, systemInstruction: string }');
console.log('');

// Proposed fix: Create a unified message formatter
const UnifiedMessageFormatter = {
  /**
   * Normalize message format across all adapters
   * @param {Array} messages - Input messages
   * @param {string} provider - Provider name
   * @returns {Object} Normalized format with messages and system instruction
   */
  formatMessages(messages, provider) {
    const adapters = {
      openai: OpenAIAdapter,
      anthropic: AnthropicAdapter,
      google: GoogleAdapter,
      mistral: MistralAdapter
    };

    const adapter = adapters[provider];
    if (!adapter) {
      throw new Error(`Unknown provider: ${provider}`);
    }

    const result = adapter.formatMessages(messages);

    // Normalize the response format
    if (Array.isArray(result)) {
      // OpenAI/Mistral format - convert to unified format
      return {
        messages: result,
        systemInstruction: '',
        provider
      };
    } else if (result.messages && result.systemPrompt !== undefined) {
      // Anthropic format - normalize key names
      return {
        messages: result.messages,
        systemInstruction: result.systemPrompt,
        provider
      };
    } else if (result.contents && result.systemInstruction !== undefined) {
      // Google format - normalize key names
      return {
        messages: result.contents,
        systemInstruction: result.systemInstruction,
        provider
      };
    } else {
      throw new Error(`Unexpected format from ${provider} adapter`);
    }
  }
};

// Test the unified formatter
const testMessages = [
  { role: 'system', content: 'You are a helpful assistant.' },
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Hi there!' }
];

console.log('✅ Unified Message Format Test:');
for (const provider of ['openai', 'anthropic', 'google', 'mistral']) {
  try {
    const unified = UnifiedMessageFormatter.formatMessages(testMessages, provider);
    console.log(
      `${provider}: ${unified.messages.length} messages, system: "${unified.systemInstruction}"`
    );
  } catch (error) {
    console.log(`${provider}: ERROR - ${error.message}`);
  }
}

console.log('');

// ============================================================================
// ISSUE 2: Tool Call Representation Inconsistency
// ============================================================================

console.log('📋 Issue 2: Tool Call Representation Inconsistency');
console.log('');
console.log('Problem: Different ways to represent tool calls in messages:');
console.log('- OpenAI/Mistral: tool_calls array with function objects');
console.log('- Anthropic: content blocks with tool_use type');
console.log('- Google: parts with functionCall objects');
console.log('');

// Proposed fix: Create a unified tool call transformer
const UnifiedToolCallTransformer = {
  /**
   * Transform tool calls to provider-specific format
   * @param {Array} toolCalls - Standardized tool calls
   * @param {string} provider - Provider name
   * @returns {Object} Provider-specific tool call format
   */
  transformToolCalls(toolCalls, provider) {
    switch (provider) {
      case 'openai':
      case 'mistral':
        return toolCalls.map(call => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments)
          }
        }));

      case 'anthropic':
        return toolCalls.map(call => ({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.arguments
        }));

      case 'google':
        return toolCalls.map(call => ({
          functionCall: {
            name: call.name,
            args: call.arguments
          }
        }));

      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  },

  /**
   * Transform tool responses to provider-specific format
   * @param {Array} toolResults - Tool execution results
   * @param {string} provider - Provider name
   * @returns {Object} Provider-specific tool response format
   */
  transformToolResults(toolResults, provider) {
    switch (provider) {
      case 'openai':
      case 'mistral':
        return toolResults.map(result => ({
          role: 'tool',
          content: JSON.stringify(result.content),
          tool_call_id: result.id
        }));

      case 'anthropic':
        return toolResults.map(result => ({
          type: 'tool_result',
          tool_use_id: result.id,
          content: JSON.stringify(result.content)
        }));

      case 'google':
        return toolResults.map(result => ({
          functionResponse: {
            name: result.name,
            response: result.content
          }
        }));

      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }
};

// Test the unified tool call transformer
const testToolCalls = [
  {
    id: 'call_1',
    name: 'search',
    arguments: { query: 'AI news' }
  }
];

const testToolResults = [
  {
    id: 'call_1',
    name: 'search',
    content: { results: ['AI breakthrough announced'] }
  }
];

console.log('✅ Unified Tool Call Transformation Test:');
for (const provider of ['openai', 'anthropic', 'google', 'mistral']) {
  try {
    const calls = UnifiedToolCallTransformer.transformToolCalls(testToolCalls, provider);
    const results = UnifiedToolCallTransformer.transformToolResults(testToolResults, provider);
    console.log(`${provider}: ${calls.length} calls, ${results.length} results`);
  } catch (error) {
    console.log(`${provider}: ERROR - ${error.message}`);
  }
}

console.log('');

// ============================================================================
// ISSUE 3: Tool Message Handling Inconsistency
// ============================================================================

console.log('📋 Issue 3: Tool Message Handling Inconsistency');
console.log('');
console.log('Problem: Different ways to handle tool messages in conversations:');
console.log('- OpenAI/Mistral: Separate "tool" role messages');
console.log('- Anthropic: tool_result content blocks within assistant messages');
console.log('- Google: functionResponse parts within user messages');
console.log('');

// Proposed fix: Create a unified conversation manager
const UnifiedConversationManager = {
  /**
   * Convert a standard conversation to provider-specific format
   * @param {Array} conversation - Standard conversation format
   * @param {string} provider - Provider name
   * @returns {Array} Provider-specific conversation format
   */
  convertConversation(conversation, provider) {
    const result = [];

    for (const message of conversation) {
      switch (message.type) {
        case 'user':
          result.push(this.createUserMessage(message.content, provider));
          break;

        case 'assistant':
          result.push(this.createAssistantMessage(message.content, message.toolCalls, provider));
          break;

        case 'tool_result':
          result.push(this.createToolResultMessage(message.toolId, message.content, provider));
          break;

        default:
          throw new Error(`Unknown message type: ${message.type}`);
      }
    }

    return result;
  },

  createUserMessage(content, provider) {
    switch (provider) {
      case 'openai':
      case 'mistral':
      case 'anthropic':
        return { role: 'user', content };

      case 'google':
        return { role: 'user', parts: [{ text: content }] };

      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  },

  createAssistantMessage(content, toolCalls, provider) {
    switch (provider) {
      case 'openai':
      case 'mistral':
        const message = { role: 'assistant', content };
        if (toolCalls && toolCalls.length > 0) {
          message.tool_calls = UnifiedToolCallTransformer.transformToolCalls(toolCalls, provider);
        }
        return message;

      case 'anthropic':
        const contentArray = [];
        if (content) {
          contentArray.push({ type: 'text', text: content });
        }
        if (toolCalls && toolCalls.length > 0) {
          contentArray.push(...UnifiedToolCallTransformer.transformToolCalls(toolCalls, provider));
        }
        return { role: 'assistant', content: contentArray };

      case 'google':
        const parts = [];
        if (content) {
          parts.push({ text: content });
        }
        if (toolCalls && toolCalls.length > 0) {
          parts.push(...UnifiedToolCallTransformer.transformToolCalls(toolCalls, provider));
        }
        return { role: 'model', parts };

      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  },

  createToolResultMessage(toolId, content, provider) {
    switch (provider) {
      case 'openai':
      case 'mistral':
        return {
          role: 'tool',
          content: JSON.stringify(content),
          tool_call_id: toolId
        };

      case 'anthropic':
        return {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolId,
              content: JSON.stringify(content)
            }
          ]
        };

      case 'google':
        return {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'tool_name', // Would need to be tracked separately
                response: content
              }
            }
          ]
        };

      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }
};

// Test the unified conversation manager
const testConversation = [
  { type: 'user', content: 'Search for AI news' },
  {
    type: 'assistant',
    content: "I'll search for AI news.",
    toolCalls: [{ id: 'call_1', name: 'search', arguments: { query: 'AI news' } }]
  },
  {
    type: 'tool_result',
    toolId: 'call_1',
    content: { results: ['AI breakthrough announced'] }
  }
];

console.log('✅ Unified Conversation Management Test:');
for (const provider of ['openai', 'anthropic', 'google', 'mistral']) {
  try {
    const converted = UnifiedConversationManager.convertConversation(testConversation, provider);
    console.log(`${provider}: ${converted.length} messages in conversation`);
  } catch (error) {
    console.log(`${provider}: ERROR - ${error.message}`);
  }
}

console.log('');

// ============================================================================
// ISSUE 4: Response Stream Processing Inconsistency
// ============================================================================

console.log('📋 Issue 4: Response Stream Processing Inconsistency');
console.log('');
console.log('Problem: Different stream processing and tool call extraction:');
console.log('- Each adapter handles streaming differently');
console.log('- Tool call extraction varies between providers');
console.log('- Error handling is inconsistent');
console.log('');

// Proposed fix: Create a unified response processor
const UnifiedResponseProcessor = {
  /**
   * Process streaming response and extract tool calls
   * @param {string} chunk - Raw response chunk
   * @param {string} provider - Provider name
   * @returns {Object} Processed response with tool calls
   */
  processStreamChunk(chunk, provider) {
    // Remove the "data: " prefix that all providers use
    const cleanChunk = chunk.replace(/^data: /, '').trim();

    if (cleanChunk === '[DONE]') {
      return { type: 'done' };
    }

    try {
      const parsed = JSON.parse(cleanChunk);

      switch (provider) {
        case 'openai':
        case 'mistral':
          return this.processOpenAIChunk(parsed);

        case 'anthropic':
          return this.processAnthropicChunk(parsed);

        case 'google':
          return this.processGoogleChunk(parsed);

        default:
          throw new Error(`Unknown provider: ${provider}`);
      }
    } catch (error) {
      return { type: 'error', error: error.message };
    }
  },

  processOpenAIChunk(parsed) {
    const choice = parsed.choices?.[0];
    if (!choice) return { type: 'empty' };

    const delta = choice.delta;
    const result = { type: 'content' };

    if (delta.content) {
      result.content = delta.content;
    }

    if (delta.tool_calls) {
      result.toolCalls = delta.tool_calls.map(call => ({
        id: call.id,
        name: call.function?.name,
        arguments: call.function?.arguments
      }));
    }

    return result;
  },

  processAnthropicChunk(parsed) {
    const result = { type: 'content' };

    if (parsed.type === 'content_block_delta') {
      if (parsed.delta.text) {
        result.content = parsed.delta.text;
      }

      if (parsed.delta.type === 'tool_use') {
        result.toolCalls = [
          {
            id: parsed.delta.id,
            name: parsed.delta.name,
            arguments: parsed.delta.input
          }
        ];
      }
    }

    return result;
  },

  processGoogleChunk(parsed) {
    const candidate = parsed.candidates?.[0];
    if (!candidate) return { type: 'empty' };

    const result = { type: 'content' };

    candidate.content?.parts?.forEach(part => {
      if (part.text) {
        result.content = (result.content || '') + part.text;
      }

      if (part.functionCall) {
        result.toolCalls = result.toolCalls || [];
        result.toolCalls.push({
          id: 'google_' + Date.now(), // Google doesn't provide IDs
          name: part.functionCall.name,
          arguments: part.functionCall.args
        });
      }
    });

    return result;
  }
};

// Test the unified response processor
const mockStreamChunks = {
  openai:
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"search","arguments":"{\\"query\\":\\"AI news\\"}"}}]}}]}',
  anthropic:
    'data: {"type":"content_block_delta","delta":{"type":"tool_use","id":"call_1","name":"search","input":{"query":"AI news"}}}',
  google:
    'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"search","args":{"query":"AI news"}}}]}}]}',
  mistral:
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_1","function":{"name":"search","arguments":"{\\"query\\":\\"AI news\\"}"}}]}}]}'
};

console.log('✅ Unified Response Processing Test:');
for (const [provider, chunk] of Object.entries(mockStreamChunks)) {
  try {
    const processed = UnifiedResponseProcessor.processStreamChunk(chunk, provider);
    console.log(
      `${provider}: ${processed.type} ${processed.toolCalls ? `(${processed.toolCalls.length} tool calls)` : ''}`
    );
  } catch (error) {
    console.log(`${provider}: ERROR - ${error.message}`);
  }
}

console.log('');

// ============================================================================
// PROPOSED UNIFIED ADAPTER INTERFACE
// ============================================================================

console.log('📋 Proposed Unified Adapter Interface');
console.log('');
console.log('To solve all these issues, we recommend creating a unified adapter interface:');
console.log('');

const UnifiedAdapterInterface = {
  /**
   * Create a completion request with unified options
   * @param {Object} model - Model configuration
   * @param {Array} messages - Standard message format
   * @param {string} apiKey - API key
   * @param {Object} options - Unified options
   * @returns {Object} HTTP request object
   */
  createCompletionRequest(model, messages, apiKey, options = {}) {
    const provider = model.provider;
    const { tools = [], temperature = 0.7, maxTokens = 1024, stream = true } = options;

    // Format messages using unified formatter
    const formattedMessages = UnifiedMessageFormatter.formatMessages(messages, provider);

    // Get the appropriate adapter
    const adapters = {
      openai: OpenAIAdapter,
      anthropic: AnthropicAdapter,
      google: GoogleAdapter,
      mistral: MistralAdapter
    };

    const adapter = adapters[provider];
    if (!adapter) {
      throw new Error(`Unknown provider: ${provider}`);
    }

    // Create request using the provider-specific adapter
    return adapter.createCompletionRequest(model, formattedMessages.messages, apiKey, {
      tools,
      temperature,
      maxTokens,
      stream,
      systemPrompt: formattedMessages.systemInstruction
    });
  },

  /**
   * Process streaming response with unified format
   * @param {string} chunk - Raw response chunk
   * @param {string} provider - Provider name
   * @returns {Object} Processed response
   */
  processStreamingResponse(chunk, provider) {
    return UnifiedResponseProcessor.processStreamChunk(chunk, provider);
  },

  /**
   * Convert conversation to provider-specific format
   * @param {Array} conversation - Standard conversation
   * @param {string} provider - Provider name
   * @returns {Array} Provider-specific conversation
   */
  convertConversation(conversation, provider) {
    return UnifiedConversationManager.convertConversation(conversation, provider);
  }
};

console.log('✅ Unified Adapter Interface created');
console.log('');
console.log('🎯 Key Benefits:');
console.log('1. Consistent API across all providers');
console.log('2. Unified message format handling');
console.log('3. Standardized tool call representation');
console.log('4. Consistent error handling');
console.log('5. Simplified testing and maintenance');
console.log('');
console.log('🔧 Implementation Steps:');
console.log('1. Create the unified interfaces above');
console.log('2. Update existing adapters to use unified formats internally');
console.log('3. Add comprehensive tests for all scenarios');
console.log('4. Update application code to use unified interface');
console.log('5. Add backward compatibility layer if needed');
console.log('');
console.log('🎉 Tool calling standardization analysis completed!');
