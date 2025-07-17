/**
 * OpenAI API adapter
 */
import { formatToolsForOpenAI } from './toolFormatter.js';

const OpenAIAdapter = {
  /**
   * Format messages for OpenAI API, including handling image data
   * @param {Array} messages - Messages to format
   * @returns {Array} Formatted messages for OpenAI API
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
      if (!message.imageData) {
        const finalContent =
          base.tool_calls && (content === undefined || content === '') ? null : content;
        return { ...base, content: finalContent };
      }

      // Format messages with image content for vision models
      return {
        ...base,
        content: [
          ...(content ? [{ type: 'text', text: content }] : []),
          {
            type: 'image_url',
            image_url: {
              url: message.imageData.base64,
              detail: 'high'
            }
          }
        ]
      };
    });

    return formattedMessages;
  },

  /**
   * Create a completion request for OpenAI
   */
  createCompletionRequest(model, messages, apiKey, options = {}) {
    const {
      temperature = 0.7,
      stream = true,
      tools = null,
      toolChoice = undefined,
      responseFormat = null,
      responseSchema = null
    } = options;

    console.log(
      'Original messages:',
      JSON.stringify(messages.map(m => ({ role: m.role, hasImage: !!m.imageData })))
    );

    const body = {
      model: model.modelId,
      messages: this.formatMessages(messages),
      stream,
      temperature: parseFloat(temperature),
      max_tokens: options.maxTokens || 1024
    };

    if (tools && tools.length > 0) body.tools = formatToolsForOpenAI(tools);
    if (toolChoice) body.tool_choice = toolChoice;
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

      body.response_format = {
        type: 'json_schema',
        json_schema: {
          schema: schemaClone,
          name: 'response',
          strict: true
        }
      };
      console.log(
        'Using response schema for structured output:',
        JSON.stringify(body.response_format, null, 2)
      );
    } else if (responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    console.log('OpenAI request body:', body);

    return {
      url: model.url,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body
    };
  },

  /**
   * Process streaming response from OpenAI
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

      // Handle full response object (non-streaming)
      if (parsed.choices && parsed.choices[0]?.message) {
        if (parsed.choices[0].message.content) {
          result.content.push(parsed.choices[0].message.content);
        }
        if (parsed.choices[0].message.tool_calls) {
          result.tool_calls.push(...parsed.choices[0].message.tool_calls);
        }
        result.complete = true;
        if (parsed.choices[0].finish_reason) {
          result.finishReason = parsed.choices[0].finish_reason;
        }
      }
      // Handle streaming response chunks
      else if (parsed.choices && parsed.choices[0]?.delta) {
        const delta = parsed.choices[0].delta;
        if (delta.content) {
          result.content.push(delta.content);
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const normalized = { index: tc.index };
            if (tc.id) normalized.id = tc.id;
            if (tc.function) {
              normalized.function = { ...tc.function };
            } else if (tc.delta && tc.delta.function) {
              normalized.function = { ...tc.delta.function };
            }
            if (tc.type || (tc.delta && tc.delta.type)) {
              normalized.type = tc.type || tc.delta.type;
            } else {
              normalized.type = 'function';
            }
            result.tool_calls.push(normalized);
          }
        }
      }

      if (parsed.choices && parsed.choices[0]?.finish_reason) {
        // Possible OpenAI finish reasons include 'stop', 'length', 'tool_calls'
        // and 'content_filter'. We forward the raw value so the service layer
        // can normalize or act on it as needed.
        result.complete = true;
        result.finishReason = parsed.choices[0].finish_reason;
      }
    } catch (error) {
      console.error('Error parsing OpenAI response chunk:', error);
      result.error = true;
      result.errorMessage = `Error parsing OpenAI response: ${error.message}`;
    }

    return result;
  }
};

export default OpenAIAdapter;
