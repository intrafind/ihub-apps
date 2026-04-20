/**
 * OpenAI API adapter
 */
import { convertToolsFromGeneric } from './toolCalling/index.js';
import { BaseAdapter } from './BaseAdapter.js';
import logger from '../utils/logger.js';
import { parseJsonAsync } from '../utils/asyncJson.js';

class OpenAIAdapterClass extends BaseAdapter {
  /**
   * Map audio MIME type to OpenAI format string
   * @param {string} mimeType - MIME type (e.g., 'audio/wav', 'audio/mpeg')
   * @returns {string} OpenAI format string (e.g., 'wav', 'mp3')
   */
  getAudioFormat(mimeType) {
    const formatMap = {
      'audio/wav': 'wav',
      'audio/mpeg': 'mp3',
      'audio/mp3': 'mp3',
      'audio/flac': 'flac',
      'audio/ogg': 'ogg',
      'audio/mp4': 'mp4',
      'audio/webm': 'webm'
    };
    return formatMap[mimeType] || 'mp3';
  }

  /**
   * Format messages for OpenAI API, including handling image and audio data
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

      const hasImages = this.hasImageData(message);
      const hasAudio = this.hasAudioData(message);

      // No media attachments — return plain content
      if (!hasImages && !hasAudio) {
        const finalContent =
          base.tool_calls && (content === undefined || content === '') ? null : content;
        return { ...base, content: finalContent };
      }

      // Build multipart content array for messages with media
      const contentParts = content ? [{ type: 'text', text: content }] : [];

      // Add image parts
      if (hasImages) {
        if (Array.isArray(message.imageData)) {
          message.imageData
            .filter(img => img && img.base64)
            .forEach(img => {
              contentParts.push({
                type: 'image_url',
                image_url: {
                  url: `data:${img.fileType || 'image/jpeg'};base64,${this.cleanBase64Data(img.base64)}`,
                  detail: 'high'
                }
              });
            });
        } else {
          contentParts.push({
            type: 'image_url',
            image_url: {
              url: `data:${message.imageData.format || message.imageData.fileType || 'image/jpeg'};base64,${this.cleanBase64Data(message.imageData.base64)}`,
              detail: 'high'
            }
          });
        }
      }

      // Add audio parts
      if (hasAudio) {
        if (Array.isArray(message.audioData)) {
          message.audioData
            .filter(audio => audio && audio.base64)
            .forEach(audio => {
              contentParts.push({
                type: 'input_audio',
                input_audio: {
                  data: this.cleanBase64Data(audio.base64),
                  format: this.getAudioFormat(audio.fileType)
                }
              });
            });
        } else {
          contentParts.push({
            type: 'input_audio',
            input_audio: {
              data: this.cleanBase64Data(message.audioData.base64),
              format: this.getAudioFormat(message.audioData.fileType)
            }
          });
        }
      }

      return { ...base, content: contentParts };
    });

    return formattedMessages;
  }

  /**
   * Create a completion request for OpenAI
   */
  createCompletionRequest(model, messages, apiKey, options = {}) {
    const { temperature, stream, tools, toolChoice, responseFormat, responseSchema, maxTokens } =
      this.extractRequestOptions(options);

    const formattedMessages = this.formatMessages(messages);
    this.debugLogMessages(messages, formattedMessages, 'OpenAI');

    const body = {
      model: model.modelId,
      messages: formattedMessages,
      stream,
      temperature: parseFloat(temperature),
      max_tokens: maxTokens
    };

    // Request usage data in streaming responses when model supports it
    if (stream && model.supportsUsageTracking !== false) {
      body.stream_options = { include_usage: true };
    }

    if (tools && tools.length > 0) body.tools = convertToolsFromGeneric(tools, 'openai');
    if (toolChoice) body.tool_choice = toolChoice;
    if (responseSchema) {
      // Deep clone incoming schema and enforce additionalProperties:false on all objects
      const schemaClone = JSON.parse(JSON.stringify(responseSchema));
      const enforceNoExtras = node => {
        logger.info('Enforcing no extras on schema node', {
          component: 'OpenAIAdapter',
          nodeType: node?.type
        });
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
      logger.info('Using response schema for structured output', {
        component: 'OpenAIAdapter',
        responseFormat: body.response_format
      });
    } else if (responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    // Note: Request body logging disabled to prevent exposing sensitive data in logs
    // logger.info('OpenAI request body:', JSON.stringify(body, null, 2));

    return {
      url: model.url,
      method: 'POST',
      headers: this.createRequestHeaders(apiKey),
      body
    };
  }

  /**
   * Process streaming response from OpenAI
   */
  async processResponseBuffer(data) {
    const result = {
      content: [],
      tool_calls: [],
      complete: false,
      error: false,
      errorMessage: null,
      finishReason: null,
      usage: null
    };

    if (!data) return result;
    if (data === '[DONE]') {
      result.complete = true;
      return result;
    }

    try {
      const parsed = await parseJsonAsync(data);

      // Extract usage data from any chunk that contains it
      if (parsed.usage) {
        result.usage = {
          promptTokens: parsed.usage.prompt_tokens || 0,
          completionTokens: parsed.usage.completion_tokens || 0,
          totalTokens: parsed.usage.total_tokens || 0
        };
      }

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
            }
            if (tc.type) {
              normalized.type = tc.type;
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
      logger.error('Error parsing OpenAI response chunk', {
        component: 'OpenAIAdapter',
        error
      });
      result.error = true;
      result.errorMessage = `Error parsing OpenAI response: ${error.message}`;
    }

    return result;
  }
}

const OpenAIAdapter = new OpenAIAdapterClass();
export default OpenAIAdapter;
