import logger from '../utils/logger.js';
import { createParser } from 'eventsource-parser';
import { getReadableStream } from '../utils/streamUtils.js';
import { convertResponseToGeneric } from './toolCalling/index.js';

/**
 * Base adapter class for LLM providers to reduce duplication
 */
export class BaseAdapter {
  /**
   * Common debug logging for messages
   * @param {Array} messages - Original messages
   * @param {Array} formattedMessages - Formatted messages
   * @param {string} provider - Provider name
   */
  debugLogMessages(messages, formattedMessages, provider) {
    logger.debug('Original messages', {
      component: `${provider}Adapter`,
      messages: messages.map(m => ({ role: m.role, hasImage: !!m.imageData }))
    });
    logger.debug('Processed messages', {
      component: `${provider}Adapter`,
      provider,
      formattedMessages: formattedMessages.map(m => ({
        role: m.role,
        contentType: Array.isArray(m.content) ? 'array' : typeof m.content,
        contentItems: Array.isArray(m.content) ? m.content.map(c => c.type) : null
      }))
    });
  }

  /**
   * Extract common request options
   * @param {Object} options - Request options
   * @returns {Object} Extracted options with defaults
   */
  extractRequestOptions(options = {}) {
    return {
      temperature: options.temperature || 0.7,
      stream: options.stream !== undefined ? options.stream : true,
      maxTokens: options.maxTokens || 1024,
      tools: options.tools || null,
      toolChoice: options.toolChoice,
      responseFormat: options.responseFormat || null,
      responseSchema: options.responseSchema || null
    };
  }

  /**
   * Create base request headers
   * @param {string} apiKey - API key
   * @param {Object} additionalHeaders - Additional headers
   * @returns {Object} Headers object
   */
  createRequestHeaders(apiKey, additionalHeaders = {}) {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...additionalHeaders
    };
  }

  /**
   * Handle image data in messages
   * @param {Object} message - Message object
   * @returns {boolean} Whether message contains image data
   */
  hasImageData(message) {
    // Check if imageData is an array (multiple images)
    if (Array.isArray(message.imageData)) {
      return message.imageData.length > 0 && message.imageData.some(img => img && img.base64);
    }
    // Check for single image (legacy)
    return !!(message.imageData && message.imageData.base64);
  }

  /**
   * Handle audio data in messages
   * @param {Object} message - Message object
   * @returns {boolean} Whether message contains audio data
   */
  hasAudioData(message) {
    // Check if audioData is an array (multiple audio files)
    if (Array.isArray(message.audioData)) {
      return message.audioData.length > 0 && message.audioData.some(audio => audio && audio.base64);
    }
    // Check for single audio file
    return !!(message.audioData && message.audioData.base64);
  }

  /**
   * Extract base64 data without data URL prefix
   * @param {string} base64Data - Base64 encoded data (image or audio)
   * @returns {string} Clean base64 data
   */
  cleanBase64Data(base64Data) {
    // Remove data URL prefix for images
    const withoutImagePrefix = base64Data.replace(/^data:image\/[a-z]+;base64,/, '');
    // Remove data URL prefix for audio
    const withoutAudioPrefix = withoutImagePrefix.replace(/^data:audio\/[a-z0-9]+;base64,/, '');
    return withoutAudioPrefix;
  }

  /**
   * Parse JSON safely with fallback
   * @param {string|Object} data - Data to parse
   * @param {*} fallback - Fallback value if parsing fails
   * @returns {*} Parsed data or fallback
   */
  safeJsonParse(data, fallback = {}) {
    if (typeof data === 'object') return data;
    try {
      return JSON.parse(data);
    } catch {
      return fallback;
    }
  }

  /**
   * Format tool response for provider
   * @param {Object} message - Tool message
   * @returns {Object} Formatted tool response
   */
  formatToolResponse(message) {
    const content = this.safeJsonParse(message.content, message.content);
    return {
      content,
      tool_call_id: message.tool_call_id,
      name: message.name,
      is_error: message.is_error || false
    };
  }

  /**
   * Default streaming-response parser. Subclasses may override to handle
   * non-SSE wire formats (e.g. AWS Bedrock binary EventStream).
   *
   * @param {Response} response
   * @param {{ model: object, chatId?: string, request?: object }} ctx
   * @yields {object} Normalized result chunks consumed by StreamingHandler
   */
  async *parseResponseStream(response, ctx) {
    yield* this.parseSseStream(response, ctx.model.provider);
  }

  /**
   * Generic SSE parser used by OpenAI-compatible providers. Reads the
   * response body, feeds chunks through eventsource-parser, and yields the
   * normalized result of convertResponseToGeneric for each event.
   *
   * @param {Response} response
   * @param {string} provider - Provider name passed to the converter registry
   * @yields {object} Normalized result chunks
   */
  async *parseSseStream(response, provider) {
    const readable = getReadableStream(response);
    const reader = readable.getReader();
    const decoder = new TextDecoder();
    const queue = [];
    const parser = createParser({
      onEvent: event => {
        if (event.type === 'event' || !event.type) {
          queue.push(event);
        }
      }
    });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.feed(decoder.decode(value, { stream: true }));
        while (queue.length > 0) {
          const evt = queue.shift();
          const result = await convertResponseToGeneric(evt.data, provider);
          if (!result) continue;
          yield result;
          if (result.error || result.complete) return;
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Custom SSE parser for providers that emit multi-event blocks separated
   * by `\n\n` and expect the adapter to interpret entire blocks at once
   * (currently iAssistant Conversation).
   *
   * The adapter must implement `processResponseBuffer(buffer)` which returns
   * a normalized result object.
   *
   * @param {Response} response
   * @yields {object} Normalized result chunks
   */
  async *parseLineDelimitedSseStream(response) {
    const readable = getReadableStream(response);
    const reader = readable.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        if (buffer.includes('\n\n')) {
          const parts = buffer.split('\n\n');
          const completeEvents = parts.slice(0, -1).join('\n\n');
          buffer = parts[parts.length - 1];
          if (!completeEvents) continue;

          let result;
          try {
            result = await this.processResponseBuffer(completeEvents + '\n\n');
          } catch (err) {
            yield {
              content: [],
              complete: false,
              finishReason: 'error',
              error: true,
              errorMessage: `Processing error: ${err.message}`
            };
            return;
          }
          if (!result) continue;
          yield result;
          if (result.error || result.complete) return;
        }
      }

      if (buffer.trim()) {
        const result = await this.processResponseBuffer(buffer);
        if (result) yield result;
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  }
}
