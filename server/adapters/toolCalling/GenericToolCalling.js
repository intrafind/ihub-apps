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
 * @property {string[]} thinking - Array of thinking content chunks (for models with reasoning support)
 * @property {GenericToolCall[]} tool_calls - Array of tool calls
 * @property {boolean} complete - Whether the response is complete
 * @property {boolean} error - Whether there was an error
 * @property {string|null} errorMessage - Error message if error occurred
 * @property {string|null} finishReason - Normalized finish reason ('stop', 'length', 'tool_calls', 'content_filter')
 * @property {Object} [metadata] - Provider-specific metadata for handling streaming state
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
  // Handle __raw_arguments pattern for streaming
  let functionArguments;
  if (arguments_ && arguments_.__raw_arguments) {
    functionArguments = arguments_.__raw_arguments;
  } else {
    functionArguments =
      typeof arguments_ === 'string' ? arguments_ : JSON.stringify(arguments_ || {});
  }

  return {
    id,
    name: normalizeToolName(name),
    arguments: arguments_ || {},
    index,
    metadata,
    // Add OpenAI-compatible format for ToolExecutor compatibility
    function: {
      name: normalizeToolName(name),
      arguments: functionArguments
    }
  };
}

/**
 * Create a generic streaming response
 * @param {string[]} content - Content chunks
 * @param {string[]} thinking - Thinking chunks
 * @param {GenericToolCall[]} tool_calls - Tool calls
 * @param {boolean} complete - Whether complete
 * @param {boolean} error - Whether error occurred
 * @param {string|null} errorMessage - Error message
 * @param {string|null} finishReason - Finish reason
 * @returns {GenericStreamingResponse} Generic streaming response
 */
export function createGenericStreamingResponse(
  content = [],
  thinking = [],
  tool_calls = [],
  complete = false,
  error = false,
  errorMessage = null,
  finishReason = null,
  metadata = {}
) {
  return {
    content,
    thinking,
    tool_calls,
    complete,
    error,
    errorMessage,
    finishReason,
    metadata
  };
}

/**
 * Raw provider finish reasons that mean the model FAILED to produce a usable
 * answer (as opposed to a normal `stop`/`length`/`content_filter`/`tool_calls`).
 *
 * These have no clean cross-provider mapping, so `normalizeFinishReason` passes
 * them through unchanged. A stream can therefore complete carrying one of these
 * with empty content — most notably Gemini's `MALFORMED_FUNCTION_CALL`, which
 * fires intermittently (often on a resend) when the model tries to emit a
 * function call it cannot form. Handlers use this set to surface a clear error
 * instead of a silent empty answer.
 *
 * Kept uppercase to match the raw provider strings. `SAFETY`/`RECITATION` are
 * intentionally excluded — they normalize to `content_filter` and are handled
 * separately.
 */
export const FAILURE_FINISH_REASONS = new Set([
  'MALFORMED_FUNCTION_CALL',
  'UNEXPECTED_TOOL_CALL',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
  'OTHER'
]);

/**
 * Whether a (possibly normalized) finish reason indicates the model failed to
 * produce a usable answer. Accepts any case.
 * @param {string|null|undefined} finishReason
 * @returns {boolean}
 */
export function isFailureFinishReason(finishReason) {
  if (!finishReason || typeof finishReason !== 'string') return false;
  return FAILURE_FINISH_REASONS.has(finishReason.toUpperCase());
}

/**
 * Normalize finish reasons across providers
 * @param {string} providerFinishReason - Provider-specific finish reason
 * @param {string} provider - Provider name
 * @returns {string} Normalized finish reason
 */
//FIXME: This function is used to normalize finish reasons from different providers. the specific handling should be done in the provider-specific adapters.
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
//FIXME: This function is used to normalize finish reasons from different providers. the specific handling should be done in the provider-specific adapters.
export function sanitizeSchemaForProvider(schema, provider) {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {} };
  }

  const sanitized = JSON.parse(JSON.stringify(schema)); // Deep clone

  // A node is a "schema" (where keywords like `title`/`format`/`minLength`
  // are JSON Schema annotations we want to strip) only if it declares a
  // `type`. A `properties` container — whose keys ARE property names — has
  // no `type` of its own, so we must NOT apply the keyword strip there.
  // Otherwise a property literally named `title`/`format`/`minLength` gets
  // deleted from its parent's `properties`, then any `required: ['title']`
  // pointing at it fails the provider's strict schema check.
  function isSchemaNode(obj) {
    return obj && typeof obj === 'object' && typeof obj.type === 'string';
  }

  function cleanObject(obj, parentKey) {
    if (!obj || typeof obj !== 'object') return obj;

    // Inside a `properties` container, each key is a user-defined property
    // name (e.g. `title`, `body`). Recurse into the children but do NOT
    // treat keys of this container as schema keywords.
    const isPropertiesContainer = parentKey === 'properties' && !isSchemaNode(obj);

    if (!isPropertiesContainer) {
      // Remove provider-specific incompatible fields
      if (provider === 'google') {
        // Normalize non-standard type values to valid JSON Schema types
        if (
          obj.type &&
          !['string', 'number', 'integer', 'boolean', 'array', 'object'].includes(obj.type)
        ) {
          obj.type = 'string';
        }
        // Ensure description is a plain string (not a multilingual object)
        if (obj.description && typeof obj.description === 'object') {
          obj.description = obj.description.en || Object.values(obj.description)[0] || '';
        }
        delete obj.exclusiveMaximum;
        delete obj.exclusiveMinimum;
        delete obj.title;
        delete obj.format; // Google has limited format support
        delete obj.minLength; // Use 'minimum' instead for strings
        delete obj.maxLength; // Use 'maximum' instead for strings
        // JSON Schema meta keywords that Google's restricted OpenAPI subset
        // rejects with HTTP 400 ("Unknown name ..."). MCP tools routinely emit
        // these ($schema + additionalProperties: false from their JSON Schema
        // draft), so strip them or every MCP tool call to Gemini fails.
        delete obj.$schema;
        delete obj.$id;
        delete obj.additionalProperties;
        delete obj.patternProperties;
      }

      if (provider === 'anthropic') {
        // Anthropic is generally more flexible, but we might need to add restrictions here
      }
    }

    // Recursively clean nested objects
    for (const key in obj) {
      if (obj[key] && typeof obj[key] === 'object') {
        if (Array.isArray(obj[key])) {
          obj[key] = obj[key].map(item => cleanObject(item, key));
        } else {
          obj[key] = cleanObject(obj[key], key);
        }
      }
    }

    return obj;
  }

  return cleanObject(sanitized);
}
