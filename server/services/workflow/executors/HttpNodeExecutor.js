/**
 * Executor for workflow HTTP request nodes.
 *
 * HTTP nodes make external API calls and store responses in workflow state.
 * They support variable interpolation, authentication helpers, and SSRF protection.
 *
 * @module services/workflow/executors/HttpNodeExecutor
 */

import { BaseNodeExecutor } from './BaseNodeExecutor.js';
import { throttledFetch } from '../../../requestThrottler.js';

const DEFAULT_TIMEOUT = 30000;
const MAX_TIMEOUT = 120000;

/**
 * Check whether a URL targets a private or localhost address (SSRF protection).
 *
 * @param {string} urlStr - URL to check
 * @returns {boolean} True if the URL should be blocked
 */
function isPrivateOrLocalhost(urlStr) {
  try {
    const { hostname } = new URL(urlStr);
    if (hostname === 'localhost' || hostname === '::1') return true;
    // IPv4 private ranges
    const ipv4 = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4) {
      const [, a, b] = ipv4.map(Number);
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 127) return true;
      if (a === 0) return true;
    }
    return false;
  } catch {
    return true; // invalid URL = block
  }
}

/**
 * Replace {{variable}} placeholders with values from data.
 *
 * @param {string} str - Template string
 * @param {Object} data - Data map for interpolation
 * @returns {string} Interpolated string
 */
function interpolateString(str, data) {
  if (typeof str !== 'string') return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => (data[key] !== undefined ? data[key] : ''));
}

/**
 * Recursively interpolate all string values in an object.
 *
 * @param {*} value - Value to interpolate
 * @param {Object} data - Data map for interpolation
 * @returns {*} Value with interpolated strings
 */
function interpolateValue(value, data) {
  if (typeof value === 'string') return interpolateString(value, data);
  if (Array.isArray(value)) return value.map(v => interpolateValue(v, data));
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = interpolateValue(v, data);
    }
    return result;
  }
  return value;
}

/**
 * Build Authorization or custom headers for the request based on auth config.
 *
 * @param {Object} auth - Auth configuration
 * @param {Object} headers - Headers object to mutate
 */
function applyAuth(auth, headers) {
  if (!auth || !auth.type) return;

  switch (auth.type) {
    case 'bearer':
      if (auth.token) headers['Authorization'] = `Bearer ${auth.token}`;
      break;
    case 'basic':
      if (auth.username && auth.password) {
        const encoded = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
        headers['Authorization'] = `Basic ${encoded}`;
      }
      break;
    case 'apikey':
      if (auth.key) {
        const headerName = auth.header || 'X-API-Key';
        headers[headerName] = auth.key;
      }
      break;
    default:
      break;
  }
}

/**
 * Executor for HTTP request nodes.
 *
 * @extends BaseNodeExecutor
 *
 * @example
 * {
 *   id: 'fetch-data',
 *   type: 'http',
 *   name: 'Fetch External Data',
 *   config: {
 *     url: 'https://api.example.com/data/{{userId}}',
 *     method: 'GET',
 *     headers: { 'Accept': 'application/json' },
 *     auth: { type: 'bearer', token: 'my-token' },
 *     timeout: 10000,
 *     responseType: 'json',
 *     outputVariable: 'apiResponse'
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
   * @param {Object} node - The node configuration
   * @param {Object} state - Current workflow state
   * @param {Object} _context - Execution context
   * @returns {Promise<Object>} Execution result with response stored in outputVariable
   */
  async execute(node, state, _context) {
    const { config = {} } = node;

    this.validateConfig(node, ['url']);

    const data = state.data || {};

    // Interpolate URL and headers with state data
    const url = interpolateString(config.url, data);
    const method = (config.method || 'GET').toUpperCase();
    const timeout = Math.min(config.timeout || DEFAULT_TIMEOUT, MAX_TIMEOUT);
    const responseType = config.responseType || 'json';
    const outputVariable = config.outputVariable || 'httpResponse';

    this.logger.info({
      component: 'HttpNodeExecutor',
      message: `Executing HTTP node '${node.id}'`,
      nodeId: node.id,
      method,
      url
    });

    // SSRF protection
    if (isPrivateOrLocalhost(url)) {
      return this.createErrorResult(
        `HTTP node '${node.id}' blocked: URL targets a private or localhost address`,
        { nodeId: node.id, url }
      );
    }

    // Build headers
    const headers = {
      'Content-Type': 'application/json',
      ...interpolateValue(config.headers || {}, data)
    };

    // Apply authentication
    const auth = config.auth ? interpolateValue(config.auth, data) : null;
    applyAuth(auth, headers);

    // Build request body
    let body;
    if (config.body !== undefined && config.body !== null && method !== 'GET') {
      const interpolatedBody = interpolateValue(config.body, data);
      body =
        typeof interpolatedBody === 'string' ? interpolatedBody : JSON.stringify(interpolatedBody);
    }

    const fetchOptions = {
      method,
      headers,
      signal: AbortSignal.timeout(timeout)
    };

    if (body !== undefined) {
      fetchOptions.body = body;
    }

    try {
      const response = await throttledFetch('http-node', url, fetchOptions);

      const responseHeaders = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      let responseBody;
      if (responseType === 'json') {
        try {
          responseBody = await response.json();
        } catch {
          // Fall back to text if JSON parsing fails
          responseBody = await response.text();
        }
      } else {
        responseBody = await response.text();
      }

      const responseData = {
        status: response.status,
        headers: responseHeaders,
        body: responseBody
      };

      this.logger.info({
        component: 'HttpNodeExecutor',
        message: `HTTP node '${node.id}' completed`,
        nodeId: node.id,
        statusCode: response.status,
        outputVariable
      });

      return this.createSuccessResult(responseData, {
        stateUpdates: { [outputVariable]: responseData }
      });
    } catch (error) {
      this.logger.error({
        component: 'HttpNodeExecutor',
        message: `HTTP node '${node.id}' failed`,
        nodeId: node.id,
        error: error.message,
        stack: error.stack
      });

      return this.createErrorResult(`HTTP request failed: ${error.message}`, {
        nodeId: node.id,
        url,
        originalError: error.message
      });
    }
  }
}

export default HttpNodeExecutor;
