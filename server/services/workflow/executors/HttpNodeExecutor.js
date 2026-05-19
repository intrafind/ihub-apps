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

import dns from 'node:dns/promises';
import net from 'node:net';
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
 * Check whether a single IP address (v4 or v6 in normalized form) belongs
 * to a private or otherwise sensitive network range.
 *
 * Blocks:
 * - IPv4 loopback (127/8) and unspecified (0/8)
 * - RFC 1918 private ranges (10/8, 172.16/12, 192.168/16)
 * - Link-local (169.254/16) -- includes AWS IMDS
 * - IPv4 multicast/reserved (224/4, 240/4)
 * - IPv4-mapped IPv6 (::ffff:0:0/96), checked via inner IPv4
 * - IPv6 loopback (::1), link-local (fe80::/10), ULA (fc00::/7), unspecified (::)
 *
 * @param {string} ip - The IP address to check
 * @returns {boolean} True if the IP is in a blocked range
 */
function isPrivateIP(ip) {
  if (!ip) return true; // be safe: unknown is blocked
  const family = net.isIP(ip);

  if (family === 4) {
    const parts = ip.split('.').map(Number);
    const [a, b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // multicast + reserved
    return false;
  }

  if (family === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fe80:') || lower.startsWith('fe80::')) return true;
    // ULA: fc00::/7 -> first byte 0xfc or 0xfd
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) -> check inner IPv4
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIP(mapped[1]);
    // IPv4-compatible IPv6 (::a.b.c.d) is deprecated but check anyway
    const compat = lower.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
    if (compat) return isPrivateIP(compat[1]);
    return false;
  }

  // Not a valid IP -- callers should resolve DNS first
  return false;
}

/**
 * SSRF guard: resolve the URL's hostname to one or more IP addresses and
 * verify every resolved IP is in a public range. Catches DNS-based
 * bypasses where an external hostname resolves to a private IP.
 *
 * @param {URL} parsedUrl - The parsed request URL
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function assertPublicTarget(parsedUrl) {
  // Strip IPv6 brackets that URL parsing leaves on the hostname.
  let host = parsedUrl.hostname;
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }

  // Block obvious magic hostnames before DNS even runs.
  const lowerHost = host.toLowerCase();
  if (lowerHost === 'localhost' || lowerHost.endsWith('.localhost')) {
    return { ok: false, reason: 'localhost is blocked' };
  }

  // If the hostname is already an IP, check it directly.
  if (net.isIP(host)) {
    return isPrivateIP(host) ? { ok: false, reason: `IP ${host} is private` } : { ok: true };
  }

  // Resolve A and AAAA. If both fail we'll reject; if either resolves to a
  // private IP we reject. Any unresolved family is ignored (not all hosts
  // have both records).
  let addrs = [];
  try {
    const [v4, v6] = await Promise.allSettled([
      dns.resolve4(host),
      dns.resolve6(host)
    ]);
    if (v4.status === 'fulfilled') addrs.push(...v4.value);
    if (v6.status === 'fulfilled') addrs.push(...v6.value);
  } catch (err) {
    return { ok: false, reason: `DNS resolution failed: ${err.message}` };
  }

  if (addrs.length === 0) {
    return { ok: false, reason: 'host did not resolve to any IP' };
  }

  for (const addr of addrs) {
    if (isPrivateIP(addr)) {
      return { ok: false, reason: `host resolves to private IP ${addr}` };
    }
  }
  return { ok: true };
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

      // Only http(s) URLs are allowed: blocks file:, gopher:, ftp:, etc.
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return this.createErrorResult(
          `Unsupported URL protocol: ${parsedUrl.protocol}. Only http(s) is allowed.`,
          { nodeId: node.id }
        );
      }

      // Resolve the hostname and verify all resolved IPs are public. This
      // catches DNS-based SSRF bypasses where a public hostname points at
      // an internal IP.
      const ssrfCheck = await assertPublicTarget(parsedUrl);
      if (!ssrfCheck.ok) {
        return this.createErrorResult(
          'Request to private/internal network is blocked (SSRF protection)',
          { nodeId: node.id, reason: ssrfCheck.reason }
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
        // `redirect: 'manual'` prevents redirect-based SSRF: a server
        // could otherwise return a 302 pointing at a private IP after the
        // initial SSRF check passed. If a redirect is returned, surface
        // it to the workflow as the response so the workflow author can
        // decide what to do.
        const response = await throttledFetch(`http-node-${node.id}`, url, {
          method,
          headers: fetchHeaders,
          body,
          signal: controller.signal,
          redirect: 'manual'
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
