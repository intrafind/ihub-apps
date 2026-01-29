import { runTool } from '../toolLoader.js';

/**
 * MCP App Bridge - Handles JSON-RPC communication between host and MCP Apps
 */

/**
 * JSON-RPC error codes
 */
export const ErrorCodes = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603
};

/**
 * Validate JSON-RPC message structure
 * @param {object} message - Message to validate
 * @returns {boolean} - True if valid
 */
export function isValidJSONRPC(message) {
  return (
    message &&
    typeof message === 'object' &&
    message.jsonrpc === '2.0' &&
    (message.method || message.result !== undefined || message.error !== undefined)
  );
}

/**
 * Create JSON-RPC request
 * @param {string} method - Method name
 * @param {object} params - Method parameters
 * @param {string|number} id - Request ID
 * @returns {object} - JSON-RPC request
 */
export function createRequest(method, params = {}, id = null) {
  const request = {
    jsonrpc: '2.0',
    method,
    params
  };

  if (id !== null) {
    request.id = id;
  }

  return request;
}

/**
 * Create JSON-RPC response
 * @param {string|number} id - Request ID
 * @param {object} result - Result data
 * @returns {object} - JSON-RPC response
 */
export function createResponse(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result
  };
}

/**
 * Create JSON-RPC error response
 * @param {string|number} id - Request ID
 * @param {number} code - Error code
 * @param {string} message - Error message
 * @param {any} data - Additional error data
 * @returns {object} - JSON-RPC error response
 */
export function createError(id, code, message, data = null) {
  const error = {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message
    }
  };

  if (data !== null) {
    error.error.data = data;
  }

  return error;
}

/**
 * Handle tools/call method
 * @param {object} params - Call parameters
 * @param {object} context - Request context (user, chatId, etc.)
 * @returns {Promise<object>} - Tool execution result
 */
async function handleToolsCall(params, context) {
  const { name, arguments: args = {} } = params;

  if (!name || typeof name !== 'string') {
    throw new Error('Tool name is required and must be a string');
  }

  try {
    // Execute the tool using the existing toolLoader
    const result = await runTool(name, args);

    // Format result for MCP App consumption
    return {
      content: Array.isArray(result.content) ? result.content : [{ type: 'text', text: String(result) }],
      isError: false
    };
  } catch (error) {
    console.error('Error executing tool:', error);
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true
    };
  }
}

/**
 * Handle ui/log method (for app debugging)
 * @param {object} params - Log parameters
 */
function handleUILog(params) {
  const { level = 'info', message, data } = params;
  console.log(`[MCP App ${level.toUpperCase()}]`, message, data || '');
  return { acknowledged: true };
}

/**
 * Process JSON-RPC message from MCP App
 * @param {object} message - JSON-RPC message
 * @param {object} context - Request context (user, chatId, etc.)
 * @returns {Promise<object>} - JSON-RPC response
 */
export async function processMessage(message, context = {}) {
  // Validate message structure
  if (!isValidJSONRPC(message)) {
    return createError(
      null,
      ErrorCodes.INVALID_REQUEST,
      'Invalid JSON-RPC 2.0 message structure'
    );
  }

  const { method, params, id } = message;

  // Handle notifications (no response expected)
  if (id === undefined) {
    if (method === 'ui/log') {
      handleUILog(params);
    }
    return null;
  }

  try {
    let result;

    switch (method) {
      case 'tools/call':
        result = await handleToolsCall(params, context);
        break;

      case 'ui/log':
        result = handleUILog(params);
        break;

      default:
        return createError(
          id,
          ErrorCodes.METHOD_NOT_FOUND,
          `Method '${method}' not found`
        );
    }

    return createResponse(id, result);
  } catch (error) {
    console.error('Error processing MCP App message:', error);
    return createError(
      id,
      ErrorCodes.INTERNAL_ERROR,
      error.message || 'Internal error',
      error.stack
    );
  }
}

/**
 * Create initialization message for MCP App
 * @param {object} toolResult - Initial tool execution result
 * @param {array} capabilities - Supported capabilities
 * @returns {object} - JSON-RPC initialization message
 */
export function createInitMessage(toolResult, capabilities = ['tools/call', 'ui/log']) {
  return createRequest('ui/initialize', {
    toolResult,
    capabilities
  });
}

/**
 * Validate message origin for security
 * @param {string} origin - Message origin
 * @param {array} allowedOrigins - List of allowed origins
 * @returns {boolean} - True if origin is allowed
 */
export function isAllowedOrigin(origin, allowedOrigins = []) {
  // In iframe context, origin will be same as parent for same-origin iframes
  // For security, we validate based on resource URI pattern
  return true; // Placeholder - actual validation happens at iframe level via CSP
}

/**
 * Rate limiter for tool calls from apps
 */
class RateLimiter {
  constructor(maxCalls = 10, windowMs = 1000) {
    this.maxCalls = maxCalls;
    this.windowMs = windowMs;
    this.calls = new Map();
  }

  isAllowed(appId) {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    if (!this.calls.has(appId)) {
      this.calls.set(appId, []);
    }

    const appCalls = this.calls.get(appId);
    
    // Remove old calls outside window
    const recentCalls = appCalls.filter(timestamp => timestamp > windowStart);
    this.calls.set(appId, recentCalls);

    if (recentCalls.length >= this.maxCalls) {
      return false;
    }

    recentCalls.push(now);
    return true;
  }
}

export const rateLimiter = new RateLimiter();
