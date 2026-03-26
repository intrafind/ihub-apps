/**
 * Remote API utilities for communicating with remote iHub server instances
 * Supports authentication, SSL/TLS, and connection pooling
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import https from 'https';
import http from 'http';

// Connection pool for reusing agents
const agentPool = new Map();

// Token cache for API authentication
let tokenCache = null;

/**
 * Get the config directory for storing CLI settings
 */
export function getConfigDir() {
  const configDir = path.join(homedir(), '.ihub');
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  return configDir;
}

/**
 * Get the path to the remote config file
 */
export function getRemoteConfigPath() {
  return path.join(getConfigDir(), 'remote.json');
}

/**
 * Load remote configuration from disk
 */
export function loadRemoteConfig() {
  const configPath = getRemoteConfigPath();
  if (!existsSync(configPath)) {
    return {
      instances: {},
      defaultInstance: null
    };
  }

  try {
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch (error) {
    console.warn(`Warning: Failed to load remote config: ${error.message}`);
    return {
      instances: {},
      defaultInstance: null
    };
  }
}

/**
 * Save remote configuration to disk
 */
export function saveRemoteConfig(config) {
  const configPath = getRemoteConfigPath();
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Parse remote API flags from CLI arguments
 * Returns { url, token, sslVerify, remainingArgs }
 */
export function parseRemoteArgs(args) {
  let url = null;
  let token = null;
  let sslVerify = true;
  const remainingArgs = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--url' && args[i + 1]) {
      url = args[i + 1];
      i++;
    } else if (arg.startsWith('--url=')) {
      url = arg.split('=')[1];
    } else if (arg === '--token' && args[i + 1]) {
      token = args[i + 1];
      i++;
    } else if (arg.startsWith('--token=')) {
      token = arg.split('=')[1];
    } else if (arg === '--no-ssl-verify') {
      sslVerify = false;
    } else if (arg === '--instance' && args[i + 1]) {
      // Load from saved instance
      const instanceName = args[i + 1];
      const config = loadRemoteConfig();
      const instance = config.instances[instanceName];

      if (instance) {
        url = instance.url;
        token = instance.token;
        sslVerify = instance.sslVerify !== false;
      }
      i++;
    } else if (arg.startsWith('--instance=')) {
      const instanceName = arg.split('=')[1];
      const config = loadRemoteConfig();
      const instance = config.instances[instanceName];

      if (instance) {
        url = instance.url;
        token = instance.token;
        sslVerify = instance.sslVerify !== false;
      }
    } else {
      remainingArgs.push(arg);
    }
  }

  // If no explicit remote settings, check for default instance
  if (!url) {
    const config = loadRemoteConfig();
    if (config.defaultInstance && config.instances[config.defaultInstance]) {
      const instance = config.instances[config.defaultInstance];
      url = instance.url;
      token = instance.token;
      sslVerify = instance.sslVerify !== false;
    }
  }

  return { url, token, sslVerify, remainingArgs };
}

/**
 * Get or create an HTTP(S) agent for connection pooling
 */
function getAgent(urlString, sslVerify = true) {
  const key = `${urlString}:${sslVerify}`;

  if (agentPool.has(key)) {
    return agentPool.get(key);
  }

  const url = new URL(urlString);
  const isHttps = url.protocol === 'https:';

  const agent = isHttps
    ? new https.Agent({
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: 10,
        maxFreeSockets: 5,
        timeout: 30000,
        rejectUnauthorized: sslVerify
      })
    : new http.Agent({
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: 10,
        maxFreeSockets: 5,
        timeout: 30000
      });

  agentPool.set(key, agent);
  return agent;
}

/**
 * Make an authenticated request to a remote iHub instance
 */
export async function remoteRequest(
  url,
  endpoint,
  options = {},
  { token = null, sslVerify = true, timeout = 30000 } = {}
) {
  // Normalize URL and endpoint
  const baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const fullUrl = `${baseUrl}${normalizedEndpoint}`;

  // Build headers
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'ihub-cli',
    ...options.headers
  };

  // Add authentication token if provided
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  // Use cached token if available and no explicit token provided
  if (!token && tokenCache) {
    headers.Authorization = `Bearer ${tokenCache}`;
  }

  // Get connection pooling agent
  const agent = getAgent(baseUrl, sslVerify);

  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(fullUrl, {
      ...options,
      headers,
      agent,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    // Handle non-OK responses
    if (!response.ok) {
      const errorText = await response.text();
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch {
        errorData = { error: errorText || response.statusText };
      }

      const error = new Error(errorData.error || `Request failed: ${response.status}`);
      error.status = response.status;
      error.data = errorData;
      throw error;
    }

    return response;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error.name === 'AbortError') {
      throw new Error(`Request timeout after ${timeout}ms`);
    }

    // Enhanced error messages
    if (error.code === 'ENOTFOUND') {
      throw new Error(`Cannot reach server at ${baseUrl}: host not found`);
    } else if (error.code === 'ECONNREFUSED') {
      throw new Error(`Cannot connect to server at ${baseUrl}: connection refused`);
    } else if (error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
      throw new Error(
        `SSL certificate verification failed. Use --no-ssl-verify to skip verification (not recommended for production)`
      );
    }

    throw error;
  }
}

/**
 * Check health of a remote iHub instance
 */
export async function checkRemoteHealth(url, { token = null, sslVerify = true, timeout = 5000 } = {}) {
  try {
    const response = await remoteRequest(url, '/api/health', { method: 'GET' }, { token, sslVerify, timeout });
    return await response.json();
  } catch (error) {
    return null;
  }
}

/**
 * Set the cached authentication token
 */
export function setTokenCache(token) {
  tokenCache = token;
}

/**
 * Get the cached authentication token
 */
export function getTokenCache() {
  return tokenCache;
}

/**
 * Clear the cached authentication token
 */
export function clearTokenCache() {
  tokenCache = null;
}

/**
 * Close all connection pool agents
 */
export function closeAllAgents() {
  for (const agent of agentPool.values()) {
    agent.destroy();
  }
  agentPool.clear();
}

/**
 * Determine if we're in remote mode based on parsed args
 */
export function isRemoteMode(remoteArgs) {
  return remoteArgs && remoteArgs.url !== null;
}

/**
 * Get display URL for logging (without auth tokens)
 */
export function getDisplayUrl(url) {
  try {
    const urlObj = new URL(url);
    return `${urlObj.protocol}//${urlObj.host}`;
  } catch {
    return url;
  }
}
