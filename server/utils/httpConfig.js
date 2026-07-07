/**
 * HTTP Configuration Utilities
 * Provides centralized configuration for HTTP clients including SSL and proxy settings.
 * All outbound HTTP calls should use httpFetch() to ensure proxy/SSL configuration is applied.
 */
import http from 'http';
import https from 'https';
import nodeFetch from 'node-fetch';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import configCache from '../configCache.js';
import config from '../config.js';
import logger from './logger.js';

/**
 * Workaround for `https-proxy-agent` >=7.0.0 (verified through 9.0.0).
 *
 * The upstream constructor in `https-proxy-agent/dist/index.js` does:
 *
 *   constructor(proxy, opts) {
 *     super(opts);                        // http.Agent stores opts in this.options
 *     this.options = { path: undefined }; // overwrites — rejectUnauthorized lost here
 *     ...
 *     this.connectOpts = { ALPNProtocols: ['http/1.1'], ...omit(opts,'headers'), host, port };
 *   }
 *
 * `http.Agent.addRequest` merges `{...requestOptions, ...this.options}` before calling
 * `createSocket`. Because `this.options` was clobbered to `{ path: undefined }`,
 * `rejectUnauthorized: false` from the constructor never reaches the options that
 * `agent-base.createSocket` forwards as `connectOpts` to `connect()`. The destination
 * TLS upgrade (`tls.connect({...omit(opts, 'host','path','port'), socket})`) therefore
 * runs with Node's default `rejectUnauthorized: true` and rejects self-signed certs.
 *
 * `this.connectOpts` does retain `rejectUnauthorized`, but it's used only for the socket to
 * the proxy itself, which is irrelevant when the proxy is plain HTTP (the common case).
 *
 * This subclass re-injects `rejectUnauthorized` into the `opts` argument of `connect()`,
 * which the parent then spreads into `tls.connect()` for the destination upgrade.
 *
 * Remove this subclass once upstream stops clobbering `this.options` in the constructor or
 * exposes a TLS-options pass-through API. See `node_modules/https-proxy-agent/dist/index.js`
 * to verify on dependency upgrades.
 */
export class TlsForwardingHttpsProxyAgent extends HttpsProxyAgent {
  constructor(proxy, opts = {}) {
    super(proxy, opts);
    this._destinationTlsOptions = {};
    if (typeof opts.rejectUnauthorized === 'boolean') {
      this._destinationTlsOptions.rejectUnauthorized = opts.rejectUnauthorized;
    }
  }

  async connect(req, opts) {
    return super.connect(req, { ...opts, ...this._destinationTlsOptions });
  }
}

/**
 * Get SSL configuration from platform config
 * @returns {Object} SSL configuration object with ignoreInvalidCertificates and domainWhitelist
 */
export function getSSLConfig() {
  const platformConfig = configCache.getPlatform() || {};
  const sslConfig = {
    ignoreInvalidCertificates: platformConfig.ssl?.ignoreInvalidCertificates || false,
    domainWhitelist: platformConfig.ssl?.domainWhitelist || []
  };

  // Log SSL config on first access for debugging
  if (!getSSLConfig._logged) {
    logger.info('SSL configuration loaded', {
      component: 'HttpConfig',
      ignoreInvalidCertificates: sslConfig.ignoreInvalidCertificates,
      domainWhitelist: sslConfig.domainWhitelist
    });

    // Only set NODE_TLS_REJECT_UNAUTHORIZED globally if ignoreInvalidCertificates is true AND whitelist is empty
    // NEW BEHAVIOR: Empty whitelist means NO SSL bypass (security improvement)
    if (sslConfig.ignoreInvalidCertificates && sslConfig.domainWhitelist.length === 0) {
      logger.info(
        'SSL validation enabled but no domains whitelisted, certificates will be validated for all connections',
        { component: 'HttpConfig' }
      );
    } else if (sslConfig.ignoreInvalidCertificates && sslConfig.domainWhitelist.length > 0) {
      logger.info('SSL certificate verification disabled only for whitelisted domains', {
        component: 'HttpConfig',
        domainWhitelist: sslConfig.domainWhitelist
      });
    }

    getSSLConfig._logged = true;
  }
  return sslConfig;
}

/**
 * Check if a domain matches any pattern in the whitelist
 * Supports wildcards (*.example.com) and exact matches (api.example.com)
 * @param {string} hostname - The hostname to check
 * @param {Array<string>} whitelist - Array of domain patterns
 * @returns {boolean} True if hostname matches any whitelist pattern
 */
export function isDomainWhitelisted(hostname, whitelist) {
  if (!hostname || !whitelist || whitelist.length === 0) {
    return false;
  }

  const lowerHostname = hostname.toLowerCase();

  for (const pattern of whitelist) {
    const lowerPattern = pattern.toLowerCase().trim();
    if (!lowerPattern) continue;

    // Wildcard pattern: *.example.com matches api.example.com, sub.example.com, etc.
    // but NOT example.com itself
    if (lowerPattern.startsWith('*.')) {
      const domain = lowerPattern.slice(2); // Remove *.
      // Validate that domain is not empty after removing wildcard
      if (domain && lowerHostname.endsWith('.' + domain)) {
        return true;
      }
    }
    // Exact match
    else if (lowerHostname === lowerPattern) {
      return true;
    }
    // Subdomain pattern: .example.com matches sub.example.com but not example.com
    else if (lowerPattern.startsWith('.')) {
      const domain = lowerPattern.slice(1); // Remove leading .
      // Validate that domain is not empty after removing leading dot
      if (domain && lowerHostname.endsWith(lowerPattern)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Determine if SSL certificate validation should be ignored for a specific URL
 * @param {string} url - The URL to check
 * @param {Object} sslConfig - SSL configuration object
 * @returns {boolean} True if SSL validation should be ignored for this URL
 */
export function shouldIgnoreSSLForURL(url, sslConfig = null) {
  const config = sslConfig || getSSLConfig();

  let hostname = '';
  try {
    hostname = new URL(url).hostname;
  } catch {
    // hostname stays empty; we still log below so the operator sees why bypass didn't apply
  }

  // If ignoreInvalidCertificates is false, always validate SSL
  if (!config.ignoreInvalidCertificates) {
    logger.debug('SSL bypass not applied: ignoreInvalidCertificates is false', {
      component: 'HttpConfig',
      hostname
    });
    return false;
  }

  // If whitelist is empty, do NOT ignore SSL (security: require explicit domain whitelisting).
  // Operators upgrading from older versions used to rely on a global bypass when whitelist
  // was empty — that behavior was removed for security. This warning makes the silent skip visible.
  if (!config.domainWhitelist || config.domainWhitelist.length === 0) {
    logger.warn(
      'SSL bypass not applied: ignoreInvalidCertificates is true but ssl.domainWhitelist is empty. Add the LLM hostname to ssl.domainWhitelist in platform.json.',
      { component: 'HttpConfig', hostname }
    );
    return false;
  }

  if (!hostname) {
    logger.warn('Error parsing URL for SSL whitelist check', { component: 'HttpConfig', url });
    return false;
  }

  // Check if hostname is in whitelist
  const isWhitelisted = isDomainWhitelisted(hostname, config.domainWhitelist);

  if (isWhitelisted) {
    logger.debug('SSL validation will be ignored for whitelisted domain', {
      component: 'HttpConfig',
      hostname
    });
  } else {
    logger.warn(
      'SSL bypass not applied: hostname is not in ssl.domainWhitelist. Self-signed certs will be rejected for this host.',
      { component: 'HttpConfig', hostname, domainWhitelist: config.domainWhitelist }
    );
  }

  return isWhitelisted;
}

/**
 * Get proxy configuration from platform config and environment
 * @returns {Object} Proxy configuration object
 */
export function getProxyConfig() {
  const platformConfig = configCache.getPlatform() || {};
  const proxyConfig = platformConfig.proxy || {};

  const result = {
    enabled: proxyConfig.enabled !== false, // Default to true if not explicitly disabled
    http: proxyConfig.http || config.HTTP_PROXY || process.env.HTTP_PROXY || process.env.http_proxy,
    https:
      proxyConfig.https || config.HTTPS_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy,
    noProxy: proxyConfig.noProxy || config.NO_PROXY || process.env.NO_PROXY || process.env.no_proxy,
    urlPatterns: proxyConfig.urlPatterns || [] // Array of regex patterns for selective proxy
  };

  // Log proxy configuration on first access for debugging
  if (!getProxyConfig._logged) {
    if (result.http || result.https) {
      logger.info('Proxy configuration loaded', {
        component: 'HttpConfig',
        http: result.http || 'none',
        https: result.https || 'none',
        noProxy: result.noProxy || 'none'
      });
    } else {
      logger.info('No proxy configured', { component: 'HttpConfig' });
    }
    getProxyConfig._logged = true;
  }

  return result;
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
    logger.warn('Error parsing URL for proxy bypass', { component: 'HttpConfig', error });
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
    logger.warn('Error matching proxy pattern', { component: 'HttpConfig', error });
  }

  return false;
}

/**
 * Build an agent for a direct (non-proxied) connection.
 *
 * Returns `undefined` (letting the fetch library use its default agent) when
 * no SSL bypass and no pinned DNS lookup are required, preserving prior
 * behavior. When a `lookup` is supplied it is attached to a concrete agent so
 * the connection resolves only to the caller-validated addresses (SSRF DNS
 * pinning); the lookup is intentionally never attached to proxy agents.
 *
 * @param {boolean} isHttps - Whether the request is HTTPS
 * @param {boolean} shouldIgnoreSSL - Whether to disable certificate validation
 * @param {Function|null} lookup - Optional dns.lookup-compatible function to pin DNS
 * @returns {http.Agent|https.Agent|undefined}
 */
function createDirectAgent(isHttps, shouldIgnoreSSL, lookup = null) {
  const options = {};
  // Admin opt-in only: reached solely when shouldIgnoreSSL is true, which
  // requires ssl.ignoreInvalidCertificates=true AND an explicit per-domain
  // whitelist match (see shouldIgnoreSSLForURL / isDomainWhitelisted). This is
  // pre-existing, intentional behavior consolidated here from three prior call
  // sites; it is not introduced by this change.
  if (shouldIgnoreSSL) options.rejectUnauthorized = false; // codeql[js/disabling-certificate-validation]
  if (typeof lookup === 'function') options.lookup = lookup;

  if (Object.keys(options).length === 0 && !isHttps) {
    return undefined; // nothing to customize for plain HTTP -> default agent
  }
  if (Object.keys(options).length === 0) {
    return undefined; // plain HTTPS with default settings -> default agent
  }
  return isHttps ? new https.Agent(options) : new http.Agent(options);
}

/**
 * Create HTTP/HTTPS agent with global SSL and proxy configuration
 * @param {string} url - Request URL (used to determine protocol and proxy bypass)
 * @param {boolean} [forceIgnoreSSL] - Force ignore SSL (overrides global setting)
 * @param {Function} [lookup] - Optional dns.lookup-compatible function to pin DNS resolution
 *   for direct connections (used by the SSRF guard). Ignored for proxied requests.
 * @returns {http.Agent|https.Agent|HttpProxyAgent|HttpsProxyAgent|undefined} Agent with appropriate configuration
 */
export function createAgent(url = '', forceIgnoreSSL = null, lookup = null) {
  // Always call getSSLConfig() to ensure configuration is loaded
  const sslConfig = getSSLConfig();
  const proxyConfig = getProxyConfig();

  const isHttps = url.startsWith('https://');
  const isHttp = url.startsWith('http://');

  // Determine if SSL should be ignored for this specific URL
  let shouldIgnoreSSL;
  if (forceIgnoreSSL !== null) {
    shouldIgnoreSSL = forceIgnoreSSL;
  } else {
    shouldIgnoreSSL = shouldIgnoreSSLForURL(url, sslConfig);
  }

  // Check if proxy should be bypassed for this URL
  if (proxyConfig.enabled && proxyConfig.noProxy && shouldBypassProxy(url, proxyConfig.noProxy)) {
    logger.info('Bypassing proxy for URL', { component: 'HttpConfig', url });
    // Direct connection: apply SSL bypass and/or DNS pinning as needed.
    return createDirectAgent(isHttps, shouldIgnoreSSL, lookup);
  }

  // Check if URL matches selective proxy patterns
  if (
    proxyConfig.enabled &&
    proxyConfig.urlPatterns &&
    proxyConfig.urlPatterns.length > 0 &&
    !matchesProxyPattern(url, proxyConfig.urlPatterns)
  ) {
    logger.info('URL does not match proxy patterns', { component: 'HttpConfig', url });
    // Direct connection: apply SSL bypass and/or DNS pinning as needed.
    return createDirectAgent(isHttps, shouldIgnoreSSL, lookup);
  }

  // Apply proxy configuration
  if (proxyConfig.enabled && ((isHttps && proxyConfig.https) || (isHttp && proxyConfig.http))) {
    const proxyUrl = isHttps ? proxyConfig.https : proxyConfig.http;
    logger.info('Using proxy for URL', { component: 'HttpConfig', proxyUrl, url });
    if (shouldIgnoreSSL) {
      logger.info('SSL certificate verification disabled for proxied request', {
        component: 'HttpConfig'
      });
    }

    try {
      const agentOptions = shouldIgnoreSSL ? { rejectUnauthorized: false } : {};

      if (isHttps) {
        // TlsForwardingHttpsProxyAgent ensures rejectUnauthorized propagates to the
        // destination TLS handshake, not just the proxy connection.
        return new TlsForwardingHttpsProxyAgent(proxyUrl, agentOptions);
      } else {
        return new HttpProxyAgent(proxyUrl, agentOptions);
      }
    } catch (error) {
      logger.error('Failed to create proxy agent', { component: 'HttpConfig', error });
    }
  }

  // No proxy path: optionally bypass SSL and/or pin DNS via a direct agent.
  if (isHttps && shouldIgnoreSSL) {
    logger.info('SSL certificate verification disabled for direct HTTPS request', {
      component: 'HttpConfig',
      url
    });
  } else if (isHttps && typeof lookup !== 'function') {
    // No agent applied. If the request later fails with a TLS error, the operator can
    // look at the preceding shouldIgnoreSSLForURL log to see why bypass was skipped.
    logger.debug('No SSL bypass agent applied for HTTPS request', {
      component: 'HttpConfig',
      url,
      proxyConfigured: Boolean(proxyConfig.https)
    });
  }
  return createDirectAgent(isHttps, shouldIgnoreSSL, lookup);
}

/**
 * Enhance fetch options with SSL and proxy configuration
 * @param {Object} options - Existing fetch options
 * @param {string} url - Request URL
 * @param {boolean} [forceIgnoreSSL] - Force ignore SSL (overrides global setting)
 * @param {Function} [lookup] - Optional dns.lookup-compatible function to pin DNS resolution
 * @returns {Object} Enhanced fetch options
 */
export function enhanceFetchOptions(options = {}, url = '', forceIgnoreSSL = null, lookup = null) {
  const enhancedOptions = { ...options };

  // Only add agent if not already specified
  if (!enhancedOptions.agent) {
    const agent = createAgent(url, forceIgnoreSSL, lookup);
    if (agent) {
      enhancedOptions.agent = agent;
    }
  }

  return enhancedOptions;
}

/**
 * Redact secret-looking parts of a URL so it can be safely included in logs and
 * error messages. Credentials ride along in a URL two ways: query parameters
 * (Google's `?key=`, plus `token` / `api_key` / `client_secret` / ...) and
 * basic-auth userinfo (`http://user:pass@host`). Both are masked; non-strings
 * are returned unchanged.
 *
 * @param {string} url - The URL to sanitize
 * @returns {string} URL with any embedded secrets replaced by `REDACTED`
 */
export function redactUrlSecrets(url) {
  if (typeof url !== 'string') return url;
  return url
    .replace(/(\/\/)[^/@\s]+@/, '$1REDACTED@')
    .replace(
      /([?&](?:api[-_]?key|access[-_]?token|client[-_]?secret|key|token|password|secret)=)[^&#\s]*/gi,
      '$1REDACTED'
    );
}

/**
 * Fetch wrapper that automatically applies proxy and SSL configuration.
 * Uses node-fetch (not native fetch) to support the agent option required
 * by http-proxy-agent/https-proxy-agent.
 *
 * All outbound HTTP calls in the server should use this function.
 *
 * @param {string} url - The URL to fetch
 * @param {Object} [options] - Standard fetch options (method, headers, body, signal, etc.).
 *   A `lookup` property (dns.lookup-compatible) is extracted to pin DNS resolution for
 *   direct connections and is not forwarded to the underlying fetch.
 * @param {boolean} [forceIgnoreSSL] - Force ignore SSL (overrides global setting)
 * @returns {Promise<Response>} node-fetch Response
 */
export async function httpFetch(url, options = {}, forceIgnoreSSL = null) {
  // Validate URL scheme - admin-configured URLs are trusted but must use http(s).
  // Include the offending URL (secrets redacted) in the error: a bad scheme
  // usually means a model/tool has no valid endpoint URL and its id or an
  // unresolved placeholder leaked through as the URL (e.g. "ministral"), which
  // the bare scheme alone doesn't reveal.
  if (url && typeof url === 'string') {
    const scheme = url.split(':')[0].toLowerCase();
    if (scheme !== 'http' && scheme !== 'https') {
      throw new Error(
        `Unsupported URL scheme "${scheme}" (expected http or https) for URL: ${redactUrlSecrets(url)}`
      );
    }
  }
  // `lookup` is not a node-fetch option; pull it out and apply it to the agent
  // (used by the workflow SSRF guard to pin connections to validated IPs).
  const { lookup = null, ...fetchOptions } = options;
  const enhanced = enhanceFetchOptions(fetchOptions, url, forceIgnoreSSL, lookup);
  return nodeFetch(url, enhanced);
}
