/**
 * HTTP Configuration Utilities
 * Provides centralized configuration for HTTP clients including SSL settings
 */
import https from 'https';
import configCache from '../configCache.js';

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
 * Create HTTPS agent with global SSL configuration
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
 * Enhance fetch options with SSL configuration
 * @param {Object} options - Existing fetch options
 * @param {string} url - Request URL
 * @param {boolean} [forceIgnoreSSL] - Force ignore SSL (overrides global setting)
 * @returns {Object} Enhanced fetch options
 */
export function enhanceFetchOptions(options = {}, url = '', forceIgnoreSSL = null) {
  const enhancedOptions = { ...options };

  // Only add agent for HTTPS URLs and if not already specified
  if (url.startsWith('https://') && !enhancedOptions.agent) {
    const agent = createHTTPSAgent(forceIgnoreSSL);
    if (agent) {
      enhancedOptions.agent = agent;
    }
  }

  return enhancedOptions;
}

/**
 * Enhance axios config with SSL configuration
 * @param {Object} config - Existing axios config
 * @param {boolean} [forceIgnoreSSL] - Force ignore SSL (overrides global setting)
 * @returns {Object} Enhanced axios config
 */
export function enhanceAxiosConfig(config = {}, forceIgnoreSSL = null) {
  const enhancedConfig = { ...config };

  // Only add httpsAgent if not already specified
  if (!enhancedConfig.httpsAgent) {
    const agent = createHTTPSAgent(forceIgnoreSSL);
    if (agent) {
      enhancedConfig.httpsAgent = agent;
    }
  }

  return enhancedConfig;
}
