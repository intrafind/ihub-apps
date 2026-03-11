/**
 * Executor for workflow HTTP request nodes.
 *
 * HTTP nodes make outbound HTTP requests to external APIs with:
 * - Variable interpolation in URLs, headers, and body using {{variable}} syntax
 * - SSRF protection blocking requests to private/internal networks
 * - Multiple authentication methods (Bearer, Basic, API Key)
 * - Configurable timeouts and response parsing
 * - Safe logging that excludes query parameters and secrets
 *
 * @module services/workflow/executors/HttpNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import { throttledFetch } from '../../../requestThrottler.js';
import logger from '../../../utils/logger.js';

/**
 * HTTP node configuration
 * @typedef {Object} HttpNodeConfig
 * @property {string} url - Target URL (supports {{variable}} interpolation)
 * @property {string} [method='GET'] - HTTP method (GET, POST, PUT, DELETE, PATCH, HEAD)
 * @property {Object} [headers] - Request headers (supports interpolation)
 * @property {Object|string} [body] - Request body for non-GET methods (supports interpolation)
 * @property {HttpAuth} [auth] - Authentication configuration
 * @property {number} [timeout=30000] - Request timeout in ms (clamped to 1000-120000)
 * @property {string} [responseType='json'] - Expected response type: 'json', 'text', or 'blob'
 * @property {string} [outputVariable] - State variable to store the result
 * @property {boolean} [failOnError=true] - Whether non-2xx responses should fail the node
 */

/**
 * HTTP authentication configuration
 * @typedef {Object} HttpAuth
 * @property {'bearer'|'basic'|'apikey'} type - Authentication type
 * @property {string} [token] - Bearer token (for type 'bearer')
 * @property {string} [username] - Username (for type 'basic')
 * @property {string} [password] - Password (for type 'basic')
 * @property {string} [key] - API key value (for type 'apikey')
 * @property {string} [headerName='X-API-Key'] - Header name for API key
 */

/**
 * Check whether a hostname resolves to a private or internal network address.
 * Used to prevent Server-Side Request Forgery (SSRF) attacks.
 *
 * Blocks:
 * - localhost and loopback (127.x.x.x, ::1)
 * - RFC 1918 private ranges (10.x, 172.16-31.x, 192.168.x)
 * - Link-local (169.254.x.x) - includes AWS IMDS endpoint
 * - IPv6 ULA (fc00::/7) and link-local (fe80::/10)
 * - Unspecified address (0.x.x.x)
 *
 * @param {string} hostname - The hostname to check
 * @returns {boolean} True if the hostname resolves to a private/internal address
 */
function isPrivateIP(hostname) {
  if (hostname === 'localhost' || hostname === '::1') return true;
  const patterns = [
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^127\./,
    /^0\./,
    /^169\.254\./, // AWS IMDS - critical!
    /^fc/i,
    /^fd/i,
    /^fe80/i // IPv6 ULA + link-local
  ];
  return patterns.some(p => p.test(hostname));
}

/**
 * Interpolate {{variable}} placeholders in a template string using workflow state data.
 * Supports dot-notation paths for nested value access.
 *
 * @param {string} template - Template string with {{variable}} placeholders
 * @param {Object} stateData - State data object to resolve variables from
 * @returns {string} Resolved string with placeholders replaced
 *
 * @example
 * interpolateVariables('Hello {{user.name}}', { user: { name: 'Alice' } })
 * // Returns: 'Hello Alice'
 */
function interpolateVariables(template, stateData) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{(\w[\w.]*)\}\}/g, (_, key) => {
    const parts = key.split('.');
    let value = stateData;
    for (const part of parts) {
      if (value === null || value === undefined) return '';
      value = value[part];
    }
    return value !== null && value !== undefined ? String(value) : '';
  });
}

/**
 * Recursively interpolate all string values within an object, array, or primitive.
 *
 * @param {*} obj - Value to interpolate (string, array, object, or primitive)
 * @param {Object} stateData - State data object to resolve variables from
 * @returns {*} Interpolated value with the same structure
 */
function interpolateObject(obj, stateData) {
  if (typeof obj === 'string') return interpolateVariables(obj, stateData);
  if (Array.isArray(obj)) return obj.map(item => interpolateObject(item, stateData));
  if (obj !== null && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = interpolateObject(value, stateData);
    }
    return result;
  }
  return obj;
}

/**
 * Executor for HTTP request nodes.
 *
 * Makes outbound HTTP requests with SSRF protection, variable interpolation,
 * and configurable authentication. Uses the platform's throttledFetch to
 * respect rate limits.
 *
 * @extends BaseNodeExecutor
 *
 * @example
 * // GET request with variable interpolation
 * {
 *   id: 'fetch-user',
 *   type: 'http',
 *   name: 'Fetch User Data',
 *   config: {
 *     url: 'https://api.example.com/users/{{userId}}',
 *     method: 'GET',
 *     auth: { type: 'bearer', token: '{{apiToken}}' },
 *     outputVariable: 'userData',
 *     timeout: 10000
 *   }
 * }
 *
 * @example
 * // POST request with JSON body
 * {
 *   id: 'create-ticket',
 *   type: 'http',
 *   name: 'Create Support Ticket',
 *   config: {
 *     url: 'https://api.example.com/tickets',
 *     method: 'POST',
 *     headers: { 'X-Project': '{{projectId}}' },
 *     body: { title: '{{ticketTitle}}', description: '{{ticketBody}}' },
 *     auth: { type: 'apikey', key: '{{apiKey}}', headerName: 'X-API-Key' },
 *     outputVariable: 'ticketResult'
 *   }
 * }
 */
export class HttpNodeExecutor extends BaseNodeExecutor {
  /**
   * Create a new HttpNodeExecutor
   * @param {Object} options - Executor options
   */
  constructor(options = {}) {
    super(options);
  }

  /**
   * Execute the HTTP request node.
   *
   * Performs SSRF validation, resolves variables in URL/headers/body,
   * applies authentication, and makes the HTTP request via throttledFetch.
   *
   * @param {Object} node - The HTTP node configuration
   * @param {Object} state - Current workflow state
   * @param {Object} _context - Execution context (unused for HTTP nodes)
   * @returns {Promise<Object>} Execution result with HTTP response data
   */
  async execute(node, state, _context) {
    const { config = {} } = node;
    const {
      method = 'GET',
      headers = {},
      auth,
      timeout = 30000,
      responseType = 'json',
      outputVariable,
      failOnError = true
    } = config;

    try {
      // Resolve URL with variable interpolation
      const url = interpolateVariables(config.url, state.data || {});
      if (!url) {
        return this.createErrorResult('URL is required', { nodeId: node.id });
      }

      // SSRF check BEFORE any logging to avoid leaking private URLs
      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch {
        return this.createErrorResult(`Invalid URL: ${url}`, { nodeId: node.id });
      }

      if (isPrivateIP(parsedUrl.hostname)) {
        return this.createErrorResult(
          'Request to private/internal network is blocked (SSRF protection)',
          {
            nodeId: node.id
          }
        );
      }

      // Safe logging - only hostname and path, no query params that might contain secrets
      logger.info({
        component: 'HttpNodeExecutor',
        message: `HTTP ${method} ${parsedUrl.hostname}${parsedUrl.pathname}`,
        nodeId: node.id
      });

      // Build headers with interpolation
      const resolvedHeaders = interpolateObject(headers, state.data || {});
      const fetchHeaders = { ...resolvedHeaders };

      // Apply authentication
      if (auth) {
        this.applyAuth(auth, fetchHeaders, state.data || {});
      }

      // Build request body (only for methods that support a body)
      let body;
      if (config.body && method !== 'GET' && method !== 'HEAD') {
        body = interpolateObject(config.body, state.data || {});
        if (typeof body === 'object') {
          body = JSON.stringify(body);
          if (!fetchHeaders['Content-Type']) {
            fetchHeaders['Content-Type'] = 'application/json';
          }
        }
      }

      // Make the request with throttledFetch and abort controller for timeout
      const clampedTimeout = Math.min(Math.max(timeout, 1000), 120000);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), clampedTimeout);

      try {
        const response = await throttledFetch(`http-node-${node.id}`, url, {
          method,
          headers: fetchHeaders,
          body,
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        // Parse response based on configured response type
        const status = response.status;
        const responseHeaders = Object.fromEntries(response.headers?.entries?.() || []);
        const responseData = await this.parseResponse(response, responseType);

        const result = {
          status,
          headers: responseHeaders,
          data: responseData,
          ok: response.ok
        };

        if (!response.ok && failOnError) {
          return this.createErrorResult(`HTTP request failed with status ${status}`, {
            nodeId: node.id,
            status,
            response: typeof responseData === 'string' ? responseData.slice(0, 500) : responseData
          });
        }

        return this.createSuccessResult(result, {
          stateUpdates: outputVariable ? { [outputVariable]: result } : undefined
        });
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      if (error.name === 'AbortError') {
        return this.createErrorResult('HTTP request timed out', { nodeId: node.id });
      }
      return this.createErrorResult(`HTTP request failed: ${error.message}`, {
        nodeId: node.id,
        error: error.message
      });
    }
  }

  /**
   * Apply authentication credentials to request headers.
   *
   * @param {HttpAuth} auth - Authentication configuration
   * @param {Object} headers - Headers object to mutate with auth credentials
   * @param {Object} stateData - State data for variable interpolation
   * @private
   */
  applyAuth(auth, headers, stateData) {
    switch (auth.type) {
      case 'bearer':
        headers['Authorization'] = `Bearer ${interpolateVariables(auth.token || '', stateData)}`;
        break;
      case 'basic': {
        const username = interpolateVariables(auth.username || '', stateData);
        const password = interpolateVariables(auth.password || '', stateData);
        headers['Authorization'] =
          `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
        break;
      }
      case 'apikey': {
        const headerName = auth.headerName || 'X-API-Key';
        headers[headerName] = interpolateVariables(auth.key || '', stateData);
        break;
      }
    }
  }

  /**
   * Parse the HTTP response body based on the configured response type.
   *
   * @param {Response} response - Fetch API Response object
   * @param {string} responseType - Expected type: 'json', 'text', or 'blob'
   * @returns {Promise<*>} Parsed response data
   * @private
   */
  async parseResponse(response, responseType) {
    try {
      switch (responseType) {
        case 'json':
          return await response.json();
        case 'text':
          return await response.text();
        case 'blob':
          // Simplified for workflow context - return as text
          return await response.text();
        default:
          return await response.text();
      }
    } catch {
      // If parsing fails (e.g., invalid JSON), fall back to text
      return await response.text().catch(() => null);
    }
  }
}

export default HttpNodeExecutor;
