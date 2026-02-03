import logger from '../utils/logger.js';
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
    logger.debug(
      'Original messages:',
      JSON.stringify(messages.map(m => ({ role: m.role, hasImage: !!m.imageData })))
    );
    logger.debug(
      `Processed ${provider} messages:`,
      JSON.stringify(
        formattedMessages.map(m => ({
          role: m.role,
          contentType: Array.isArray(m.content) ? 'array' : typeof m.content,
          contentItems: Array.isArray(m.content) ? m.content.map(c => c.type) : null
        }))
      )
    );
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
   * Extract base64 image data without data URL prefix
   * @param {string} base64Data - Base64 encoded image data
   * @returns {string} Clean base64 data
   */
  cleanBase64Data(base64Data) {
    return base64Data.replace(/^data:image\/[a-z]+;base64,/, '');
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
}
