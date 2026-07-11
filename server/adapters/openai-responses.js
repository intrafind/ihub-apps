/**
 * OpenAI Responses API adapter for GPT-5 and newer models
 * Uses the new /v1/responses endpoint instead of /v1/chat/completions
 * Reference: https://platform.openai.com/docs/api-reference/responses
 */
import { convertToolsFromGeneric } from './toolCalling/index.js';
import { BaseAdapter } from './BaseAdapter.js';
import logger from '../utils/logger.js';

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

      // Handle tool result messages - convert to function_call_output format
      // OpenAI Responses API uses a different format for tool results
      if (message.role === 'tool') {
        return {
          type: 'function_call_output',
          call_id: message.tool_call_id,
          output: content // Tool results go in 'output' field, not 'content'
        };
      }

      // Handle assistant messages with tool_calls - convert to function_call format
      // OpenAI Responses API expects function calls as direct objects, not as assistant messages
      if (message.role === 'assistant' && message.tool_calls && message.tool_calls.length > 0) {
        // Convert each tool call to a function_call object
        // If there are multiple tool calls, we need to return an array, but typically there's one
        return message.tool_calls.map(toolCall => ({
          type: 'function_call',
          call_id: toolCall.id,
          name: toolCall.function?.name || toolCall.name,
          arguments: toolCall.function?.arguments || toolCall.arguments || '{}'
        }));
      }

      // Base message with role and optional tool fields
      const base = { role: message.role };
      if (message.tool_call_id) base.tool_call_id = message.tool_call_id;
      if (message.name) base.name = message.name;

      // Handle image data in messages
      if (!this.hasImageData(message)) {
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

    // Flatten the array since assistant messages with tool_calls return arrays
    return formattedMessages.flat();
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
  async createCompletionRequest(model, messages, apiKey, options = {}) {
    const {
      stream,
      tools,
      toolChoice,
      responseFormat,
      responseSchema,
      maxTokens,
      nativeWebSearch
    } = this.extractRequestOptions(options);

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
    const responsesTools =
      tools && tools.length > 0 ? convertToolsFromGeneric(tools, 'openai-responses') : [];

    // OpenAI's server-side web search tool. Like Anthropic (and unlike Google),
    // it can be combined with client-defined function tools in the same request.
    if (nativeWebSearch?.provider === 'openai-responses') {
      responsesTools.unshift({ type: 'web_search' });
    }

    if (responsesTools.length > 0) {
      body.tools = responsesTools;
    }
    if (toolChoice) body.tool_choice = toolChoice;

    // Structured outputs use text.format instead of response_format
    if (responseSchema) {
      // Deep clone incoming schema and enforce additionalProperties:false on all objects
      const schemaClone = JSON.parse(JSON.stringify(responseSchema));
      const enforceNoExtras = node => {
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
      logger.debug('Using response schema for structured output', {
        component: 'OpenAIResponsesAdapter'
      });
    } else if (responseFormat === 'json') {
      // For simple JSON mode - merge with existing text configuration
      body.text.format = { type: 'json_object' };
    }

    logger.debug('OpenAI Responses API request prepared', {
      component: 'OpenAIResponsesAdapter',
      model: body.model,
      hasTools: Boolean(body.tools?.length),
      hasStructuredOutput: Boolean(responseSchema)
    });

    return {
      url: model.url,
      method: 'POST',
      headers: this.createRequestHeaders(apiKey),
      body
    };
  }
}

const OpenAIResponsesAdapter = new OpenAIResponsesAdapterClass();
export default OpenAIResponsesAdapter;
