/**
 * OpenAI API adapter
 */
import { convertToolsFromGeneric } from './toolCalling/index.js';
import { BaseAdapter } from './BaseAdapter.js';
import logger from '../utils/logger.js';
import modelDiscoveryService from '../services/ModelDiscoveryService.js';

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
  async createCompletionRequest(model, messages, apiKey, options = {}) {
    const { temperature, stream, tools, toolChoice, responseFormat, responseSchema, maxTokens } =
      this.extractRequestOptions(options);

    const formattedMessages = this.formatMessages(messages);
    this.debugLogMessages(messages, formattedMessages, 'OpenAI');

    // Use model discovery to get the effective model ID if enabled
    const effectiveModelId = await modelDiscoveryService.getEffectiveModelId(model, apiKey);

    const body = {
      model: effectiveModelId,
      messages: formattedMessages,
      stream,
      temperature: parseFloat(temperature),
      max_tokens: maxTokens
    };

    // Request usage data in streaming responses when model supports it
    if (stream && model.supportsUsageTracking !== false) {
      body.stream_options = { include_usage: true };
    }

    // Reasoning/thinking support. Gated on model.thinking.enabled so plain chat
    // models are unaffected. OpenAI reasoning models — and OpenAI-compatible
    // endpoints reached via this adapter (vLLM/DeepSeek/OpenRouter) — accept the
    // `reasoning_effort` parameter on /chat/completions. We deliberately keep
    // this conservative: max_tokens and temperature are left untouched so the
    // many OpenAI-compatible endpoints that don't impose reasoning-model
    // constraints keep working.
    if (model.thinking?.enabled && (options.thinkingEnabled ?? true)) {
      body.reasoning_effort = this.resolveReasoningEffort(options, model);
    }

    if (tools && tools.length > 0) body.tools = convertToolsFromGeneric(tools, 'openai');
    if (toolChoice) body.tool_choice = toolChoice;
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

      body.response_format = {
        type: 'json_schema',
        json_schema: {
          schema: schemaClone,
          name: 'response',
          strict: true
        }
      };
      logger.debug('Using response schema for structured output', {
        component: 'OpenAIAdapter'
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
}

const OpenAIAdapter = new OpenAIAdapterClass();
export default OpenAIAdapter;
