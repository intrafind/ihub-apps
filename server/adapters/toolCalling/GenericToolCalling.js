/**
 * Generic Tool Calling System
 *
 * This module provides a generic interface for tool/function calling across different
 * LLM providers (OpenAI, Anthropic, Google, Mistral). It handles bidirectional
 * conversion between provider-specific formats and a normalized generic format.
 */

/**
 * Generic tool definition format
 * This is our normalized internal format that can represent tools for any provider
 *
 * @typedef {Object} GenericTool
 * @property {string} id - Unique identifier for the tool
 * @property {string} name - Function name (must be valid identifier)
 * @property {string} description - Human-readable description
 * @property {Object} parameters - JSON Schema for parameters
 * @property {Object} [metadata] - Provider-specific metadata
 */

/**
 * Generic tool call format
 * This represents a tool call in a normalized way across providers
 *
 * @typedef {Object} GenericToolCall
 * @property {string} id - Unique identifier for this tool call
 * @property {string} name - Name of the function being called
 * @property {Object} arguments - Arguments for the function call
 * @property {number} [index] - Index for streaming/chunked responses
 * @property {Object} [metadata] - Provider-specific metadata
 */

/**
 * Generic tool result format
 * This represents the result of a tool execution
 *
 * @typedef {Object} GenericToolResult
 * @property {string} tool_call_id - ID of the tool call this responds to
 * @property {string} name - Name of the tool that was called
 * @property {*} content - The result content (any type)
 * @property {boolean} [is_error] - Whether this is an error result
 * @property {Object} [metadata] - Provider-specific metadata
 */

/**
 * Generic streaming response format
 * This normalizes streaming responses across providers
 *
 * @typedef {Object} GenericStreamingResponse
 * @property {string[]} content - Array of text content chunks
 * @property {GenericToolCall[]} tool_calls - Array of tool calls
 * @property {boolean} complete - Whether the response is complete
 * @property {boolean} error - Whether there was an error
 * @property {string|null} errorMessage - Error message if error occurred
 * @property {string|null} finishReason - Normalized finish reason ('stop', 'length', 'tool_calls', 'content_filter')
 */

/**
 * Normalize a tool name to be compatible with all providers
 * @param {string} name - Original tool name
 * @returns {string} Normalized name
 */
export function normalizeToolName(name) {
  const normalized = (name || '').replace(/[^A-Za-z0-9_.-]/g, '_');

  // Ensure name starts with letter or underscore (Google requirement)
  if (normalized && !/^[A-Za-z_]/.test(normalized)) {
    return `tool_${normalized}`;
  }

  // Ensure name is not empty
  return normalized || 'unnamed_tool';
}

/**
 * Create a generic tool definition
 * @param {string} id - Tool identifier
 * @param {string} name - Tool name
 * @param {string} description - Tool description
 * @param {Object} parameters - JSON Schema for parameters
 * @param {Object} [metadata] - Provider-specific metadata
 * @returns {GenericTool} Generic tool definition
 */
export function createGenericTool(id, name, description, parameters = {}, metadata = {}) {
  return {
    id,
    name: normalizeToolName(name),
    description: description || '',
    parameters: parameters || { type: 'object', properties: {} },
    metadata
  };
}

/**
 * Create a generic tool call
 * @param {string} id - Tool call identifier
 * @param {string} name - Function name
 * @param {Object} arguments_ - Function arguments
 * @param {number} [index] - Index for streaming
 * @param {Object} [metadata] - Provider-specific metadata
 * @returns {GenericToolCall} Generic tool call
 */
export function createGenericToolCall(id, name, arguments_, index = 0, metadata = {}) {
  return {
    id,
    name: normalizeToolName(name),
    arguments: arguments_ || {},
    index,
    metadata,
    // Add OpenAI-compatible format for ToolExecutor compatibility
    function: {
      name: normalizeToolName(name),
      arguments: typeof arguments_ === 'string' ? arguments_ : JSON.stringify(arguments_ || {})
    }
  };
}

/**
 * Create a generic tool result
 * @param {string} tool_call_id - ID of the tool call
 * @param {string} name - Tool name
 * @param {*} content - Result content
 * @param {boolean} [is_error] - Whether this is an error
 * @param {Object} [metadata] - Provider-specific metadata
 * @returns {GenericToolResult} Generic tool result
 */
export function createGenericToolResult(
  tool_call_id,
  name,
  content,
  is_error = false,
  metadata = {}
) {
  return {
    tool_call_id,
    name: normalizeToolName(name),
    content,
    is_error,
    metadata
  };
}

/**
 * Create a generic streaming response
 * @param {string[]} content - Content chunks
 * @param {GenericToolCall[]} tool_calls - Tool calls
 * @param {boolean} complete - Whether complete
 * @param {boolean} error - Whether error occurred
 * @param {string|null} errorMessage - Error message
 * @param {string|null} finishReason - Finish reason
 * @returns {GenericStreamingResponse} Generic streaming response
 */
export function createGenericStreamingResponse(
  content = [],
  tool_calls = [],
  complete = false,
  error = false,
  errorMessage = null,
  finishReason = null
) {
  return {
    content,
    tool_calls,
    complete,
    error,
    errorMessage,
    finishReason
  };
}

/**
 * Normalize finish reasons across providers
 * @param {string} providerFinishReason - Provider-specific finish reason
 * @param {string} provider - Provider name
 * @returns {string} Normalized finish reason
 */
export function normalizeFinishReason(providerFinishReason, provider) {
  if (!providerFinishReason) return null;

  const reason = providerFinishReason.toLowerCase();

  // Common mappings
  if (reason === 'stop' || reason === 'end_turn') return 'stop';
  if (reason === 'length' || reason === 'max_tokens') return 'length';
  if (reason === 'tool_calls' || reason === 'tool_use') return 'tool_calls';
  if (reason === 'content_filter' || reason === 'safety' || reason === 'recitation')
    return 'content_filter';

  // Provider-specific mappings
  switch (provider) {
    case 'google':
      if (reason === 'stop') return 'stop';
      if (reason === 'max_tokens') return 'length';
      if (reason === 'safety' || reason === 'recitation') return 'content_filter';
      break;
    case 'anthropic':
      if (reason === 'end_turn') return 'stop';
      if (reason === 'tool_use') return 'tool_calls';
      if (reason === 'max_tokens') return 'length';
      break;
  }

  // Return original if no mapping found
  return providerFinishReason;
}

/**
 * Sanitize JSON Schema for provider compatibility
 * @param {Object} schema - JSON Schema
 * @param {string} provider - Target provider
 * @returns {Object} Sanitized schema
 */
export function sanitizeSchemaForProvider(schema, provider) {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }

  const sanitized = JSON.parse(JSON.stringify(schema)); // Deep clone

  function cleanObject(obj) {
    if (!obj || typeof obj !== 'object') return obj;

    // Remove provider-specific incompatible fields
    if (provider === 'google') {
      delete obj.exclusiveMaximum;
      delete obj.exclusiveMinimum;
      delete obj.title;
      delete obj.format; // Google has limited format support
      delete obj.minLength; // Use 'minimum' instead for strings
      delete obj.maxLength; // Use 'maximum' instead for strings
    }

    if (provider === 'anthropic') {
      // Anthropic is generally more flexible, but we might need to add restrictions here
    }

    // Recursively clean nested objects
    for (const key in obj) {
      if (obj[key] && typeof obj[key] === 'object') {
        if (Array.isArray(obj[key])) {
          obj[key] = obj[key].map(item => cleanObject(item));
        } else {
          obj[key] = cleanObject(obj[key]);
        }
      }
    }

    return obj;
  }

  return cleanObject(sanitized);
}
