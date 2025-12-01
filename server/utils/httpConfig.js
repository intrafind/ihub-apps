/**
 * HTTP Configuration Utilities
 * Provides centralized configuration for HTTP clients including SSL and proxy settings
 */
import https from 'https';
import tls from 'tls';
import net from 'net';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import configCache from '../configCache.js';
import config from '../config.js';

/**
 * Custom HttpsProxyAgent that properly applies SSL options to destination connections
 * Fixes the issue where rejectUnauthorized and other TLS options are not applied
 * to the destination server when using a proxy.
 *
 * This implementation uses a safer approach that doesn't globally override tls.connect,
 * instead it creates the destination TLS connection directly with merged options.
 */
class CustomHttpsProxyAgent extends HttpsProxyAgent {
  constructor(proxy, opts) {
    super(proxy, opts);
    // Store TLS options that should be applied to destination connections
    this.destinationTLSOptions = {};
    if (opts) {
      // Extract TLS-related options that should apply to destination
      const tlsKeys = [
        'rejectUnauthorized',
        'ca',
        'cert',
        'key',
        'pfx',
        'passphrase',
        'ciphers',
        'secureProtocol',
        'secureOptions',
        'minVersion',
        'maxVersion'
      ];
      for (const key of tlsKeys) {
        if (key in opts) {
          this.destinationTLSOptions[key] = opts[key];
        }
      }
    }
  }

  async connect(req, opts) {
    const { proxy } = this;
    if (!opts.host) {
      throw new TypeError('No "host" provided');
    }

    // Create socket connection to proxy (reuse parent's logic)
    let socket;
    if (proxy.protocol === 'https:') {
      socket = tls.connect({
        ...this.connectOpts,
        servername:
          this.connectOpts.host && !net.isIP(this.connectOpts.host)
            ? this.connectOpts.host
            : undefined
      });
    } else {
      socket = net.connect(this.connectOpts);
    }

    // Build CONNECT request
    const headers =
      typeof this.proxyHeaders === 'function' ? this.proxyHeaders() : { ...this.proxyHeaders };
    const host = net.isIPv6(opts.host) ? `[${opts.host}]` : opts.host;
    let payload = `CONNECT ${host}:${opts.port} HTTP/1.1\r\n`;

    // Add proxy authentication if needed
    if (proxy.username || proxy.password) {
      const auth = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(auth).toString('base64')}`;
    }

    headers.Host = `${host}:${opts.port}`;
    if (!headers['Proxy-Connection']) {
      headers['Proxy-Connection'] = this.keepAlive ? 'Keep-Alive' : 'close';
    }

    for (const name of Object.keys(headers)) {
      payload += `${name}: ${headers[name]}\r\n`;
    }

    // Parse proxy CONNECT response
    // We inline this instead of importing from internal library paths
    const proxyResponsePromise = new Promise((resolve, reject) => {
      let buffersLength = 0;
      const buffers = [];

      function read() {
        const b = socket.read();
        if (b) ondata(b);
        else socket.once('readable', read);
      }

      function cleanup() {
        socket.removeListener('end', onend);
        socket.removeListener('error', onerror);
        socket.removeListener('readable', read);
      }

      function onend() {
        cleanup();
        reject(new Error('Proxy connection ended before receiving CONNECT response'));
      }

      function onerror(err) {
        cleanup();
        reject(err);
      }

      function ondata(b) {
        buffers.push(b);
        buffersLength += b.length;
        const buffered = Buffer.concat(buffers, buffersLength);
        const endOfHeaders = buffered.indexOf('\r\n\r\n');

        if (endOfHeaders === -1) {
          read();
          return;
        }

        const headerParts = buffered.slice(0, endOfHeaders).toString('ascii').split('\r\n');
        const firstLine = headerParts.shift();

        if (!firstLine) {
          socket.destroy();
          return reject(new Error('No header received from proxy CONNECT response'));
        }

        const firstLineParts = firstLine.split(' ');
        const statusCode = +firstLineParts[1];
        const statusText = firstLineParts.slice(2).join(' ');
        const headers = {};

        for (const header of headerParts) {
          if (!header) continue;
          const firstColon = header.indexOf(':');
          if (firstColon === -1) {
            socket.destroy();
            return reject(new Error(`Invalid header from proxy CONNECT response: "${header}"`));
          }
          const key = header.slice(0, firstColon).toLowerCase();
          const value = header.slice(firstColon + 1).trimStart();
          const current = headers[key];

          if (typeof current === 'string') {
            headers[key] = [current, value];
          } else if (Array.isArray(current)) {
            current.push(value);
          } else {
            headers[key] = value;
          }
        }

        cleanup();
        resolve({
          connect: { statusCode, statusText, headers },
          buffered
        });
      }

      socket.on('error', onerror);
      socket.on('end', onend);
      read();
    });

    socket.write(`${payload}\r\n`);

    const { connect, buffered } = await proxyResponsePromise;
    req.emit('proxyConnect', connect);
    this.emit('proxyConnect', connect, req);

    if (connect.statusCode === 200) {
      req.once('socket', s => s.resume());

      if (opts.secureEndpoint) {
        // Create TLS connection to destination with merged options
        const tlsOptions = {
          socket,
          servername:
            opts.servername || (opts.host && !net.isIP(opts.host) ? opts.host : undefined),
          ...this.destinationTLSOptions, // Apply our stored TLS options
          // Allow per-request options to override
          ...(opts.ca && { ca: opts.ca }),
          ...(opts.cert && { cert: opts.cert }),
          ...(opts.key && { key: opts.key })
        };

        try {
          return tls.connect(tlsOptions);
        } catch (error) {
          // Clean up socket on TLS connection error
          socket.destroy();
          throw error;
        }
      }

      return socket;
    }

    // Handle non-200 status codes (same as parent)
    socket.destroy();
    const fakeSocket = new net.Socket({ writable: false });
    fakeSocket.readable = true;
    req.once('socket', s => {
      s.push(buffered);
      s.push(null);
    });
    return fakeSocket;
  }
}

/**
 * Get SSL configuration from platform config
 * @returns {Object} SSL configuration object
 */
export function getSSLConfig() {
  const platformConfig = configCache.getPlatform() || {};
  return {
    ignoreInvalidCertificates: platformConfig.ssl?.ignoreInvalidCertificates || false
  };
}

/**
 * Get proxy configuration from platform config and environment
 * @returns {Object} Proxy configuration object
 */
export function getProxyConfig() {
  const platformConfig = configCache.getPlatform() || {};
  const proxyConfig = platformConfig.proxy || {};

  return {
    enabled: proxyConfig.enabled !== false, // Default to true if not explicitly disabled
    http: proxyConfig.http || config.HTTP_PROXY || process.env.HTTP_PROXY,
    https: proxyConfig.https || config.HTTPS_PROXY || process.env.HTTPS_PROXY,
    noProxy: proxyConfig.noProxy || config.NO_PROXY || process.env.NO_PROXY,
    urlPatterns: proxyConfig.urlPatterns || [] // Array of regex patterns for selective proxy
  };
}

/**
 * Check if a URL should bypass proxy based on NO_PROXY configuration
 * @param {string} url - The URL to check
 * @param {string} noProxy - NO_PROXY configuration string
 * @returns {boolean} True if proxy should be bypassed
 */
export function shouldBypassProxy(url, noProxy) {
  if (!noProxy || !url) return false;

  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;

    // Split NO_PROXY by comma and check each entry
    const noProxyList = noProxy.split(',').map(item => item.trim().toLowerCase());

    for (const entry of noProxyList) {
      if (!entry) continue;

      // Match wildcard domains (e.g., *.example.com)
      if (entry.startsWith('*.')) {
        const domain = entry.slice(2);
        if (hostname.toLowerCase().endsWith(domain)) {
          return true;
        }
      }
      // Match subdomains (e.g., .example.com matches sub.example.com)
      else if (entry.startsWith('.')) {
        if (hostname.toLowerCase().endsWith(entry)) {
          return true;
        }
      }
      // Exact hostname match
      else if (hostname.toLowerCase() === entry) {
        return true;
      }
      // CIDR notation and IP ranges are not fully supported here for simplicity
    }
  } catch (error) {
    console.warn(`Error parsing URL for proxy bypass: ${error.message}`);
  }

  return false;
}

/**
 * Check if URL matches any of the configured URL patterns for selective proxy
 * @param {string} url - The URL to check
 * @param {Array<string>} patterns - Array of regex pattern strings
 * @returns {boolean} True if URL matches any pattern
 */
export function matchesProxyPattern(url, patterns) {
  if (!patterns || patterns.length === 0) return true; // If no patterns, apply proxy to all

  try {
    for (const pattern of patterns) {
      const regex = new RegExp(pattern);
      if (regex.test(url)) {
        return true;
      }
    }
  } catch (error) {
    console.warn(`Error matching proxy pattern: ${error.message}`);
  }

  return false;
}

/**
 * Create HTTP/HTTPS agent with global SSL and proxy configuration
 * @param {string} url - Request URL (used to determine protocol and proxy bypass)
 * @param {boolean} [forceIgnoreSSL] - Force ignore SSL (overrides global setting)
 * @returns {http.Agent|https.Agent|HttpProxyAgent|HttpsProxyAgent|undefined} Agent with appropriate configuration
 */
export function createAgent(url = '', forceIgnoreSSL = null) {
  const shouldIgnoreSSL =
    forceIgnoreSSL !== null ? forceIgnoreSSL : getSSLConfig().ignoreInvalidCertificates;
  const proxyConfig = getProxyConfig();

  const isHttps = url.startsWith('https://');
  const isHttp = url.startsWith('http://');

  // Check if proxy should be bypassed for this URL
  if (proxyConfig.enabled && proxyConfig.noProxy && shouldBypassProxy(url, proxyConfig.noProxy)) {
    console.log(`Bypassing proxy for URL: ${url}`);
    // Return standard agent with SSL configuration if needed
    if (isHttps && shouldIgnoreSSL) {
      return new https.Agent({ rejectUnauthorized: false });
    }
    return undefined;
  }

  // Check if URL matches selective proxy patterns
  if (
    proxyConfig.enabled &&
    proxyConfig.urlPatterns &&
    proxyConfig.urlPatterns.length > 0 &&
    !matchesProxyPattern(url, proxyConfig.urlPatterns)
  ) {
    console.log(`URL does not match proxy patterns: ${url}`);
    // Return standard agent with SSL configuration if needed
    if (isHttps && shouldIgnoreSSL) {
      return new https.Agent({ rejectUnauthorized: false });
    }
    return undefined;
  }

  // Apply proxy configuration
  if (proxyConfig.enabled && ((isHttps && proxyConfig.https) || (isHttp && proxyConfig.http))) {
    const proxyUrl = isHttps ? proxyConfig.https : proxyConfig.http;
    console.log(`Using proxy ${proxyUrl} for URL: ${url}`);

    try {
      const agentOptions = shouldIgnoreSSL ? { rejectUnauthorized: false } : {};

      if (isHttps) {
        // Use custom agent that properly applies SSL options to destination connections
        return new CustomHttpsProxyAgent(proxyUrl, agentOptions);
      } else {
        return new HttpProxyAgent(proxyUrl, agentOptions);
      }
    } catch (error) {
      console.error(`Failed to create proxy agent: ${error.message}`);
    }
  }

  // Fallback to SSL-only configuration if needed
  if (isHttps && shouldIgnoreSSL) {
    return new https.Agent({ rejectUnauthorized: false });
  }

  return undefined;
}

/**
 * Create HTTPS agent with global SSL configuration (legacy function, kept for compatibility)
 * @deprecated Use createAgent() instead for proxy support
 * @param {boolean} [forceIgnoreSSL] - Force ignore SSL (overrides global setting)
 * @returns {https.Agent|undefined} HTTPS agent if SSL ignore is enabled, undefined otherwise
 */
export function createHTTPSAgent(forceIgnoreSSL = null) {
  const shouldIgnoreSSL =
    forceIgnoreSSL !== null ? forceIgnoreSSL : getSSLConfig().ignoreInvalidCertificates;

  if (shouldIgnoreSSL) {
    return new https.Agent({ rejectUnauthorized: false });
  }

  return undefined;
}

/**
 * Enhance fetch options with SSL and proxy configuration
 * @param {Object} options - Existing fetch options
 * @param {string} url - Request URL
 * @param {boolean} [forceIgnoreSSL] - Force ignore SSL (overrides global setting)
 * @returns {Object} Enhanced fetch options
 */
export function enhanceFetchOptions(options = {}, url = '', forceIgnoreSSL = null) {
  const enhancedOptions = { ...options };

  // Only add agent if not already specified
  if (!enhancedOptions.agent) {
    const agent = createAgent(url, forceIgnoreSSL);
    if (agent) {
      enhancedOptions.agent = agent;
    }
  }

  return enhancedOptions;
}

/**
 * Enhance axios config with SSL and proxy configuration
 * @param {Object} config - Existing axios config
 * @param {string} url - Request URL (optional, used for selective proxy)
 * @param {boolean} [forceIgnoreSSL] - Force ignore SSL (overrides global setting)
 * @returns {Object} Enhanced axios config
 */
export function enhanceAxiosConfig(config = {}, url = '', forceIgnoreSSL = null) {
  const enhancedConfig = { ...config };

  // Determine URL from config if not provided
  const targetUrl = url || config.url || '';

  // Only add agents if not already specified
  if (!enhancedConfig.httpAgent && !enhancedConfig.httpsAgent) {
    const agent = createAgent(targetUrl, forceIgnoreSSL);
    if (agent) {
      // Axios uses both httpAgent and httpsAgent
      if (targetUrl.startsWith('https://')) {
        enhancedConfig.httpsAgent = agent;
      } else if (targetUrl.startsWith('http://')) {
        enhancedConfig.httpAgent = agent;
      } else {
        // If URL protocol is unknown, set both
        enhancedConfig.httpAgent = agent;
        enhancedConfig.httpsAgent = agent;
      }
    }
  }

  return enhancedConfig;
}
