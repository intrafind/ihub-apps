/**
 * OpenAI Responses API adapter for GPT-5 and newer models
 * Uses the new /v1/responses endpoint instead of /v1/chat/completions
 * Reference: https://platform.openai.com/docs/api-reference/responses
 */
import { convertToolsFromGeneric } from './toolCalling/index.js';
import { BaseAdapter } from './BaseAdapter.js';

class OpenAIResponsesAdapterClass extends BaseAdapter {
  /**
   * Format messages for OpenAI Responses API
   * The Responses API accepts both the old messages array format and new input/instructions format
   * @param {Array} messages - Messages to format
   * @returns {Array} Formatted messages for OpenAI Responses API
   */
  formatMessages(messages) {
    const formattedMessages = messages.map(message => {
      const content = message.content;

      // Base message with role and optional tool fields
      const base = { role: message.role };
      if (message.tool_calls) base.tool_calls = message.tool_calls;
      if (message.tool_call_id) base.tool_call_id = message.tool_call_id;
      if (message.name) base.name = message.name;

      // Handle image data in messages
      if (!this.hasImageData(message)) {
        // For tool calls without content, omit the content field entirely
        // rather than setting it to null (which can break the API)
        if (base.tool_calls && (content === undefined || content === '' || content === null)) {
          return base;
        }
        return { ...base, content };
      }

      // Handle multiple images
      if (Array.isArray(message.imageData)) {
        const imageContent = message.imageData
          .filter(img => img && img.base64)
          .map(img => ({
            type: 'image_url',
            image_url: {
              url: `data:${img.fileType || 'image/jpeg'};base64,${this.cleanBase64Data(img.base64)}`,
              detail: 'high'
            }
          }));

        return {
          ...base,
          content: [...(content ? [{ type: 'text', text: content }] : []), ...imageContent]
        };
      }

      // Handle single image (legacy behavior)
      return {
        ...base,
        content: [
          ...(content ? [{ type: 'text', text: content }] : []),
          {
            type: 'image_url',
            image_url: {
              url: `data:${message.imageData.format || message.imageData.fileType || 'image/jpeg'};base64,${this.cleanBase64Data(message.imageData.base64)}`,
              detail: 'high'
            }
          }
        ]
      };
    });

    return formattedMessages;
  }

  /**
   * Separate system instructions from user messages
   * The Responses API supports a top-level 'instructions' field for system-level guidance
   * @param {Array} messages - All messages
   * @returns {Object} Object with {instructions: string|null, input: Array}
   */
  separateInstructions(messages) {
    const systemMessages = messages.filter(m => m.role === 'system');
    const otherMessages = messages.filter(m => m.role !== 'system');

    // Combine all system messages into instructions
    const instructions =
      systemMessages.length > 0 ? systemMessages.map(m => m.content).join('\n') : null;

    return {
      instructions,
      input: otherMessages
    };
  }

  /**
   * Create a completion request for OpenAI Responses API
   */
  createCompletionRequest(model, messages, apiKey, options = {}) {
    const { stream, tools, toolChoice, responseFormat, responseSchema, maxTokens } =
      this.extractRequestOptions(options);

    const formattedMessages = this.formatMessages(messages);
    this.debugLogMessages(messages, formattedMessages, 'OpenAI Responses');

    // Separate system instructions from the rest of the messages
    const { instructions, input } = this.separateInstructions(formattedMessages);

    const body = {
      model: model.modelId,
      stream,
      store: true // Responses are stored by default for statefulness
    };

    // Only set max_output_tokens if a specific limit is requested
    // 0 or undefined = unlimited (omit parameter, let model use its default maximum)
    if (maxTokens && maxTokens > 0) {
      body.max_output_tokens = maxTokens;
    }

    // Note: temperature is NOT supported by GPT-5 models with Responses API
    // GPT-5 models use a fixed temperature of 1.0
    // Use verbosity and reasoning.effort parameters instead for control

    // Configure reasoning effort based on thinking budget
    const thinkingEnabled = options.thinkingEnabled ?? true;
    const thinkingBudget = options.thinkingBudget ?? -1;
    const thinkingThoughts = options.thinkingThoughts ?? false;

    let reasoningEffort = 'medium'; // default
    if (!thinkingEnabled || thinkingBudget === 0) {
      reasoningEffort = 'minimal';
    } else if (thinkingBudget === -1) {
      reasoningEffort = 'medium'; // dynamic budget defaults to medium
    } else if (thinkingBudget > 0 && thinkingBudget <= 100) {
      reasoningEffort = 'low';
    } else if (thinkingBudget > 100 && thinkingBudget <= 500) {
      reasoningEffort = 'medium';
    } else if (thinkingBudget > 500) {
      reasoningEffort = 'high';
    }

    // Map thoughts flag to verbosity (controls detail level)
    const verbosity = thinkingThoughts ? 'high' : 'medium';

    // Add reasoning configuration
    body.reasoning = {
      effort: reasoningEffort
    };

    // Add text verbosity configuration
    body.text = {
      verbosity: verbosity
    };

    // Add instructions if present (system messages)
    if (instructions) {
      body.instructions = instructions;
    }

    // Add input - can be a string or array of messages
    // If there's only one user message and no other messages, use string format
    if (input.length === 1 && input[0].role === 'user' && typeof input[0].content === 'string') {
      body.input = input[0].content;
    } else {
      body.input = input;
    }

    // Add tools if present - function calling API shape is different in Responses
    if (tools && tools.length > 0) {
      // Convert tools to Responses API format (internally-tagged vs externally-tagged)
      body.tools = convertToolsFromGeneric(tools, 'openai-responses');
    }
    if (toolChoice) body.tool_choice = toolChoice;

    // Structured outputs use text.format instead of response_format
    if (responseSchema) {
      // Deep clone incoming schema and enforce additionalProperties:false on all objects
      const schemaClone = JSON.parse(JSON.stringify(responseSchema));
      const enforceNoExtras = node => {
        console.log('Enforcing no extras on schema node:', node);
        if (node && node.type === 'object') {
          node.additionalProperties = false;
        }
        if (node.properties) {
          Object.values(node.properties).forEach(enforceNoExtras);
        }
        if (node.items) {
          const items = Array.isArray(node.items) ? node.items : [node.items];
          items.forEach(enforceNoExtras);
        }
      };
      enforceNoExtras(schemaClone);

      // Responses API uses text.format instead of response_format
      // Merge with existing text configuration
      body.text.format = {
        type: 'json_schema',
        name: 'response',
        strict: true,
        schema: schemaClone
      };
      console.log(
        'Using response schema for structured output:',
        JSON.stringify(body.text, null, 2)
      );
    } else if (responseFormat === 'json') {
      // For simple JSON mode - merge with existing text configuration
      body.text.format = { type: 'json_object' };
    }

    console.log('OpenAI Responses API request body:', JSON.stringify(body, null, 2));

    return {
      url: model.url,
      method: 'POST',
      headers: this.createRequestHeaders(apiKey),
      body
    };
  }

  /**
   * Process streaming response from OpenAI Responses API
   * The Responses API returns output as an array of Items instead of choices
   */
  processResponseBuffer(data) {
    const result = {
      content: [],
      tool_calls: [],
      complete: false,
      error: false,
      errorMessage: null,
      finishReason: null
    };

    if (!data) return result;
    if (data === '[DONE]') {
      result.complete = true;
      return result;
    }

    try {
      const parsed = JSON.parse(data);

      // Add debugging to see what we're receiving
      console.log('[RESPONSES API DEBUG] Received chunk:', JSON.stringify(parsed, null, 2));

      // Handle full response object (non-streaming)
      if (parsed.output && Array.isArray(parsed.output)) {
        // Process output items
        for (const item of parsed.output) {
          if (item.type === 'message' && item.content) {
            // Extract text from message items
            for (const contentItem of item.content) {
              if (contentItem.type === 'output_text' && contentItem.text) {
                result.content.push(contentItem.text);
              }
            }
          } else if (item.type === 'function_call' && item.function) {
            // Handle function calls
            result.tool_calls.push({
              id: item.id,
              type: 'function',
              function: {
                name: item.function.name,
                arguments: item.function.arguments
              }
            });
          }
          // Reasoning items are ignored for now (summary only available, not full reasoning)
        }
        result.complete = true;
      }
      // Handle streaming delta chunks - Responses API streaming format
      else if (parsed.type === 'response.output_chunk.delta' || parsed.delta) {
        // Extract delta from either parsed.delta or parsed itself
        const delta = parsed.delta || parsed;

        if (delta.type === 'message' && delta.content) {
          for (const contentItem of delta.content) {
            if (contentItem.type === 'output_text' && contentItem.text) {
              result.content.push(contentItem.text);
            }
          }
        } else if (delta.type === 'function_call' && delta.function) {
          const normalized = { index: delta.index || 0 };
          if (delta.id) normalized.id = delta.id;
          if (delta.function) {
            normalized.function = { ...delta.function };
          }
          normalized.type = 'function';
          result.tool_calls.push(normalized);
        }
      }
      // Legacy format check for output_chunk
      else if (parsed.output_chunk) {
        const chunk = parsed.output_chunk;
        if (chunk.type === 'message' && chunk.delta) {
          if (chunk.delta.content) {
            for (const contentItem of chunk.delta.content) {
              if (contentItem.type === 'output_text' && contentItem.text) {
                result.content.push(contentItem.text);
              }
            }
          }
        } else if (chunk.type === 'function_call' && chunk.delta) {
          // Handle streaming function calls
          const normalized = { index: chunk.index || 0 };
          if (chunk.id) normalized.id = chunk.id;
          if (chunk.delta.function) {
            normalized.function = { ...chunk.delta.function };
          }
          normalized.type = 'function';
          result.tool_calls.push(normalized);
        }
      }

      // Check for completion
      if (
        parsed.type === 'response.completed' ||
        parsed.status === 'completed' ||
        parsed.output_status === 'completed'
      ) {
        result.complete = true;
        // The Responses API doesn't have finish_reason field
        // Determine finish reason based on whether tool calls are present
        result.finishReason = result.tool_calls.length > 0 ? 'tool_calls' : 'stop';
      } else if (parsed.status === 'failed' || parsed.type === 'response.failed') {
        result.error = true;
        result.errorMessage = parsed.error?.message || 'Response generation failed';
      }
    } catch (error) {
      console.error('Error parsing OpenAI Responses API response chunk:', error);
      console.error('Data that caused error:', data);
      result.error = true;
      result.errorMessage = `Error parsing OpenAI Responses API response: ${error.message}`;
    }

    return result;
  }
}

const OpenAIResponsesAdapter = new OpenAIResponsesAdapterClass();
export default OpenAIResponsesAdapter;
