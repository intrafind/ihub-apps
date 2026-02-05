/**
 * HTTP Configuration Utilities
 * Provides centralized configuration for HTTP clients including SSL and proxy settings
 */
import https from 'https';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import configCache from '../configCache.js';
import config from '../config.js';
import logger from './logger.js';

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
    logger.info(
      `🔒 SSL Configuration: ignoreInvalidCertificates = ${sslConfig.ignoreInvalidCertificates}, domainWhitelist = [${sslConfig.domainWhitelist.join(', ')}]`
    );

    // Only set NODE_TLS_REJECT_UNAUTHORIZED globally if ignoreInvalidCertificates is true AND whitelist is empty
    // When whitelist is used, we handle SSL validation per-request instead of globally
    if (sslConfig.ignoreInvalidCertificates && sslConfig.domainWhitelist.length === 0) {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
      logger.info(
        '⚠️  NODE_TLS_REJECT_UNAUTHORIZED=0 set globally (SSL certificate verification disabled for ALL domains)'
      );
    } else if (sslConfig.ignoreInvalidCertificates && sslConfig.domainWhitelist.length > 0) {
      logger.info(
        `⚠️  SSL certificate verification will be disabled ONLY for whitelisted domains: [${sslConfig.domainWhitelist.join(', ')}]`
      );
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
      if (lowerHostname.endsWith('.' + domain)) {
        return true;
      }
    }
    // Exact match
    else if (lowerHostname === lowerPattern) {
      return true;
    }
    // Subdomain pattern: .example.com matches sub.example.com but not example.com
    else if (lowerPattern.startsWith('.')) {
      if (lowerHostname.endsWith(lowerPattern)) {
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

  // If ignoreInvalidCertificates is false, always validate SSL
  if (!config.ignoreInvalidCertificates) {
    return false;
  }

  // If whitelist is empty, ignore SSL for all domains (legacy behavior)
  if (!config.domainWhitelist || config.domainWhitelist.length === 0) {
    return true;
  }

  // Extract hostname from URL
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;

    // Check if hostname is in whitelist
    const isWhitelisted = isDomainWhitelisted(hostname, config.domainWhitelist);

    if (isWhitelisted) {
      logger.debug(`SSL validation will be ignored for whitelisted domain: ${hostname}`);
    }

    return isWhitelisted;
  } catch (error) {
    logger.warn(`Error parsing URL for SSL whitelist check: ${error.message}`);
    return false;
  }
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
    logger.warn(`Error parsing URL for proxy bypass: ${error.message}`);
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
    logger.warn(`Error matching proxy pattern: ${error.message}`);
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
    logger.info(`Bypassing proxy for URL: ${url}`);
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
    logger.info(`URL does not match proxy patterns: ${url}`);
    // Return standard agent with SSL configuration if needed
    if (isHttps && shouldIgnoreSSL) {
      return new https.Agent({ rejectUnauthorized: false });
    }
    return undefined;
  }

  // Apply proxy configuration
  if (proxyConfig.enabled && ((isHttps && proxyConfig.https) || (isHttp && proxyConfig.http))) {
    const proxyUrl = isHttps ? proxyConfig.https : proxyConfig.http;
    logger.info(`Using proxy ${proxyUrl} for URL: ${url}`);
    if (shouldIgnoreSSL) {
      logger.info(`SSL certificate verification disabled (rejectUnauthorized: false)`);
    }

    try {
      // For HttpsProxyAgent v7+, rejectUnauthorized is passed as a top-level option
      const agentOptions = shouldIgnoreSSL ? { rejectUnauthorized: false } : {};

      if (isHttps) {
        return new HttpsProxyAgent(proxyUrl, agentOptions);
      } else {
        return new HttpProxyAgent(proxyUrl, agentOptions);
      }
    } catch (error) {
      logger.error(`Failed to create proxy agent: ${error.message}`);
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
