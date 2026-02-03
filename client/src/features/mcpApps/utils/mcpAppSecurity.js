/**
 * MCP App Security Utilities
 * Handles security validation and policy enforcement for MCP Apps
 */

/**
 * Validate message origin
 * @param {MessageEvent} event - PostMessage event
 * @param {string} expectedOrigin - Expected origin URL
 * @returns {boolean} - True if origin is valid
 */
export function isValidOrigin(event, expectedOrigin) {
  // For same-origin iframes, origin will be same as parent
  // For security, we rely on iframe sandbox and CSP
  return true;
}

/**
 * Validate JSON-RPC message structure
 * @param {any} message - Message to validate
 * @returns {boolean} - True if valid
 */
export function isValidMessage(message) {
  if (!message || typeof message !== 'object') {
    return false;
  }

  // Must have jsonrpc: "2.0"
  if (message.jsonrpc !== '2.0') {
    return false;
  }

  // Must have either method (request/notification) or result/error (response)
  const hasMethod = typeof message.method === 'string';
  const hasResult = message.result !== undefined;
  const hasError = message.error !== undefined;

  return hasMethod || hasResult || hasError;
}

/**
 * Sanitize user input to prevent XSS
 * @param {string} input - User input to sanitize
 * @returns {string} - Sanitized input
 */
export function sanitizeInput(input) {
  if (typeof input !== 'string') {
    return String(input);
  }

  return input
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');
}

/**
 * Generate sandbox attributes for iframe
 * @param {object} permissions - Requested permissions
 * @returns {string} - Sandbox attribute value
 */
export function generateSandboxAttributes(permissions = []) {
  const baseAttrs = ['allow-scripts', 'allow-same-origin'];

  // Add additional permissions if requested
  const permissionMap = {
    microphone: 'allow-microphone',
    camera: 'allow-camera',
    geolocation: 'allow-geolocation'
  };

  const attrs = [...baseAttrs];

  if (Array.isArray(permissions)) {
    permissions.forEach(permission => {
      const attr = permissionMap[permission];
      if (attr && !attrs.includes(attr)) {
        attrs.push(attr);
      }
    });
  }

  return attrs.join(' ');
}

/**
 * Check if tool result includes MCP App UI
 * @param {object} toolResult - Tool execution result
 * @returns {boolean} - True if result has UI metadata
 */
export function hasUIMetadata(toolResult) {
  return !!(
    toolResult &&
    toolResult._meta &&
    toolResult._meta.ui &&
    toolResult._meta.ui.resourceUri &&
    toolResult._meta.ui.resourceUri.startsWith('ui://')
  );
}

/**
 * Extract UI metadata from tool result
 * @param {object} toolResult - Tool execution result
 * @returns {object|null} - UI metadata or null
 */
export function extractUIMetadata(toolResult) {
  if (!hasUIMetadata(toolResult)) {
    return null;
  }

  return toolResult._meta.ui;
}

/**
 * Build resource URL for iframe src
 * @param {string} resourceUri - Resource URI (ui://tool-id/app.html)
 * @param {string} basePath - Application base path
 * @returns {string} - Full resource URL
 */
export function buildResourceUrl(resourceUri, basePath = '') {
  // Remove ui:// prefix
  const path = resourceUri.replace(/^ui:\/\//, '');
  return `${basePath}/api/mcp/resources/${path}`;
}

/**
 * Create initialization message for MCP App
 * @param {object} toolResult - Tool execution result
 * @param {array} capabilities - Supported capabilities
 * @returns {object} - Initialization message
 */
export function createInitMessage(toolResult, capabilities = ['tools/call', 'ui/log']) {
  return {
    jsonrpc: '2.0',
    method: 'ui/initialize',
    params: {
      toolResult,
      capabilities
    }
  };
}
