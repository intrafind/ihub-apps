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
import { guardedLookup } from './dnsGuard.js';
import tokenStorageService from '../services/TokenStorageService.js';

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
 * Detect a `${VAR}` placeholder that was never substituted.
 *
 * `configCache` resolves `${VAR}` from the environment but deliberately leaves
 * the placeholder verbatim when the variable is undefined (see
 * `utils/envVars.js`). For a proxy URL that is worse than an empty value: the
 * literal string `"${HTTPS_PROXY}"` is truthy, so without this check it would be
 * handed to `HttpsProxyAgent` as a proxy URL and every outbound call would fail
 * with an unparseable-URL error instead of simply going direct.
 *
 * @param {*} value - Value to inspect
 * @returns {boolean} True when the value still contains a placeholder
 */
export function isUnresolvedPlaceholder(value) {
  return typeof value === 'string' && /\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}/.test(value);
}

/**
 * Proxy URLs may be stored encrypted (`ENC[...]`), and `getProxyConfig()` runs on
 * every outbound request, so memoize by ciphertext. Bounded in practice: the only
 * writer is an admin save.
 */
const decryptedProxyUrlCache = new Map();

/**
 * Normalize one proxy URL field: drop blanks and unresolved placeholders, and
 * decrypt `ENC[...]` values so credentials can be stored encrypted at rest.
 *
 * @param {*} value - Raw value from platform config or the environment
 * @returns {string|undefined} A usable proxy URL, or undefined when unset
 */
function normalizeProxyUrl(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (isUnresolvedPlaceholder(trimmed)) return undefined;
  if (!tokenStorageService.isEncrypted(trimmed)) return trimmed;

  if (decryptedProxyUrlCache.has(trimmed)) return decryptedProxyUrlCache.get(trimmed);
  let usable;
  try {
    usable = tokenStorageService.decryptString(trimmed).trim() || undefined;
  } catch (error) {
    // Rotated or missing encryption key. Going direct is the safe failure here;
    // handing ciphertext to a proxy agent only produces a confusing "Invalid URL"
    // on every outbound call.
    logger.error('Failed to decrypt proxy URL, ignoring it', {
      component: 'HttpConfig',
      error
    });
    usable = undefined;
  }
  decryptedProxyUrlCache.set(trimmed, usable);
  return usable;
}

/**
 * Normalize `noProxy` to an array of lower-cased entries.
 *
 * Admins supply either the shell-style comma-separated string
 * (`"localhost,127.0.0.1,.local"`, matching `NO_PROXY`) or an array (matching the
 * neighbouring `ssl.domainWhitelist`). Both are accepted. Anything else yields an
 * empty list rather than throwing: a malformed bypass list must never silently
 * disable every bypass, which is what happened while this was `String.split()`
 * inside a swallowed try/catch.
 *
 * @param {string|Array<string>|undefined} noProxy - Raw bypass list
 * @returns {Array<string>} Trimmed, lower-cased, non-empty entries
 */
export function normalizeNoProxy(noProxy) {
  if (!noProxy) return [];
  if (typeof noProxy !== 'string' && !Array.isArray(noProxy)) return [];
  const raw = Array.isArray(noProxy) ? noProxy : noProxy.split(',');
  const entries = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().toLowerCase();
    if (trimmed && !isUnresolvedPlaceholder(trimmed)) entries.push(trimmed);
  }
  return entries;
}

/**
 * Resolve the proxy configuration together with where each field came from.
 *
 * Used by the admin API (`GET /api/admin/proxy/config`) so an operator can tell
 * whether a value is coming from `platform.json` or from the process
 * environment — the difference decides whether editing it in the admin UI will
 * have any effect.
 *
 * Provenance values:
 * - `platform`    — set in `platform.json`
 * - `environment` — from `config.env` / process environment
 * - `default`     — not configured anywhere; the built-in default applies
 *
 * @returns {Object} `{ enabled, http, https, noProxy, urlPatterns }`, each
 *   `{ value, source, placeholderIgnored? }`
 */
export function getProxyProvenance() {
  const platformConfig = configCache.getPlatform() || {};
  const proxyConfig = platformConfig.proxy || {};

  const urlField = (platformValue, envValue) => {
    const fromPlatform = normalizeProxyUrl(platformValue);
    if (fromPlatform) return { value: fromPlatform, source: 'platform' };
    const fromEnv = normalizeProxyUrl(envValue);
    if (fromEnv) return { value: fromEnv, source: 'environment' };
    return {
      value: undefined,
      source: 'default',
      // Surfaced in the admin UI: an operator who wrote "${HTTPS_PROXY}" into
      // platform.json needs to know the variable never resolved.
      placeholderIgnored: isUnresolvedPlaceholder(platformValue) ? platformValue : undefined
    };
  };

  const noProxyFromPlatform = normalizeNoProxy(proxyConfig.noProxy);
  const noProxyFromEnv = normalizeNoProxy(
    config.NO_PROXY || process.env.NO_PROXY || process.env.no_proxy
  );
  const noProxy =
    noProxyFromPlatform.length > 0
      ? { value: noProxyFromPlatform, source: 'platform' }
      : noProxyFromEnv.length > 0
        ? { value: noProxyFromEnv, source: 'environment' }
        : { value: [], source: 'default' };

  return {
    enabled: {
      // Historically absent means enabled, so an operator who only sets
      // HTTP_PROXY in the environment still gets a proxy.
      value: proxyConfig.enabled !== false,
      source: typeof proxyConfig.enabled === 'boolean' ? 'platform' : 'default'
    },
    http: urlField(
      proxyConfig.http,
      config.HTTP_PROXY || process.env.HTTP_PROXY || process.env.http_proxy
    ),
    https: urlField(
      proxyConfig.https,
      config.HTTPS_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy
    ),
    noProxy,
    urlPatterns: {
      value: Array.isArray(proxyConfig.urlPatterns)
        ? proxyConfig.urlPatterns.filter(p => typeof p === 'string' && p.trim())
        : [],
      source:
        Array.isArray(proxyConfig.urlPatterns) && proxyConfig.urlPatterns.length > 0
          ? 'platform'
          : 'default'
    }
  };
}

/**
 * Get proxy configuration from platform config and environment
 * @returns {Object} Proxy configuration object. `noProxy` is always an array —
 *   normalization happens here so no caller has to repeat it.
 */
export function getProxyConfig() {
  const provenance = getProxyProvenance();
  const result = {
    enabled: provenance.enabled.value,
    http: provenance.http.value,
    https: provenance.https.value,
    noProxy: provenance.noProxy.value,
    urlPatterns: provenance.urlPatterns.value
  };

  // Log proxy configuration on first access for debugging
  if (!getProxyConfig._logged) {
    if (result.http || result.https) {
      logger.info('Proxy configuration loaded', {
        component: 'HttpConfig',
        http: result.http ? redactUrlSecrets(result.http) : 'none',
        https: result.https ? redactUrlSecrets(result.https) : 'none',
        noProxy: result.noProxy.length > 0 ? result.noProxy.join(',') : 'none'
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
 *
 * Entry semantics (matching `isDomainWhitelisted` in this module):
 * - `example.com`   — exact hostname match
 * - `.example.com`  — subdomains only, not the bare domain
 * - `*.example.com` — same as `.example.com`
 *
 * CIDR ranges, `host:port` entries and the catch-all `*` are **not** supported;
 * see `docs/proxy-configuration.md`.
 *
 * @param {string} url - The URL to check
 * @param {string|Array<string>} noProxy - NO_PROXY configuration (comma-separated string or array)
 * @returns {boolean} True if proxy should be bypassed
 */
export function shouldBypassProxy(url, noProxy) {
  const noProxyList = normalizeNoProxy(noProxy);
  if (noProxyList.length === 0 || !url) return false;

  let hostname;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch (error) {
    logger.warn('Error parsing URL for proxy bypass', { component: 'HttpConfig', url, error });
    return false;
  }

  for (const entry of noProxyList) {
    // Wildcard domain (*.example.com) — subdomains only, like ssl.domainWhitelist
    if (entry.startsWith('*.')) {
      const domain = entry.slice(2);
      if (domain && hostname.endsWith('.' + domain)) return true;
    }
    // Subdomain form (.example.com) — subdomains only
    else if (entry.startsWith('.')) {
      const domain = entry.slice(1);
      if (domain && hostname.endsWith(entry)) return true;
    }
    // Exact hostname match
    else if (hostname === entry) {
      return true;
    }
  }

  return false;
}

/**
 * Compiled `urlPatterns` regexes, keyed by pattern source. `null` marks a pattern
 * that does not compile, so it is reported once instead of on every request.
 */
const proxyPatternCache = new Map();

function compileProxyPattern(pattern) {
  if (proxyPatternCache.has(pattern)) return proxyPatternCache.get(pattern);
  let regex = null;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    logger.warn('Ignoring proxy URL pattern that is not a valid regular expression', {
      component: 'HttpConfig',
      pattern,
      error: error.message
    });
  }
  proxyPatternCache.set(pattern, regex);
  return regex;
}

/**
 * Check if URL matches any of the configured URL patterns for selective proxy.
 *
 * Each pattern is compiled independently: one uncompilable entry is skipped with
 * a warning naming it, and the remaining patterns are still evaluated. Wrapping
 * the whole loop in a single try/catch (as this used to) meant a single bad entry
 * aborted evaluation, silently sending every URL direct.
 *
 * @param {string} url - The URL to check
 * @param {Array<string>} patterns - Array of regex pattern strings
 * @returns {boolean} True if URL matches any pattern
 */
export function matchesProxyPattern(url, patterns) {
  if (!patterns || patterns.length === 0) return true; // If no patterns, apply proxy to all

  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue;
    const regex = compileProxyPattern(pattern);
    if (regex && regex.test(url)) return true;
  }

  return false;
}

/**
 * Decide how an outbound request to `url` is transported, without performing it.
 *
 * Single source of truth for the routing rules, so `createAgent()`, the
 * integration diagnostics and the admin proxy test all report the same decision.
 *
 * @param {string} url - Request URL
 * @param {Object} [proxyConfig] - Config to evaluate against; defaults to the live one
 * @returns {{decision: string, proxyUrl: string|undefined, reason: string}}
 *   `decision` is one of `proxied`, `disabled`, `bypassed`, `excluded`, `direct`.
 */
export function describeProxyRouting(url = '', proxyConfig = null) {
  const cfg = proxyConfig || getProxyConfig();
  const isHttps = url.startsWith('https://');
  const isHttp = url.startsWith('http://');
  const candidateProxy = isHttps ? cfg.https : isHttp ? cfg.http : undefined;

  if (!cfg.enabled) {
    return { decision: 'disabled', proxyUrl: undefined, reason: 'proxy.enabled is false' };
  }
  if (shouldBypassProxy(url, cfg.noProxy)) {
    return { decision: 'bypassed', proxyUrl: undefined, reason: 'host matches proxy.noProxy' };
  }
  if (cfg.urlPatterns?.length > 0 && !matchesProxyPattern(url, cfg.urlPatterns)) {
    return {
      decision: 'excluded',
      proxyUrl: undefined,
      reason: 'URL matches none of proxy.urlPatterns'
    };
  }
  if (candidateProxy) {
    return {
      decision: 'proxied',
      proxyUrl: candidateProxy,
      reason: isHttps ? 'proxy.https applies to this URL' : 'proxy.http applies to this URL'
    };
  }
  return {
    decision: 'direct',
    proxyUrl: undefined,
    reason: isHttps ? 'no proxy.https configured' : 'no proxy.http configured'
  };
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
 * Direct agent for a URL, resolving hostnames through the DNS guard.
 *
 * Without a caller-supplied lookup the agent is shared per (protocol, SSL
 * bypass) so every outbound connection goes through `guardedLookup` (see
 * dnsGuard.js): one getaddrinfo per hostname at a time, a bounded wait and a
 * short negative cache, so an unreachable model endpoint cannot stall other
 * requests by occupying the threadpool's DNS slots. A caller-supplied lookup
 * (the SSRF guard's DNS pinning) is request-specific and gets its own agent.
 */
const sharedDirectAgents = new Map();
function guardedDirectAgent(isHttps, shouldIgnoreSSL, lookup = null) {
  if (typeof lookup === 'function') {
    return createDirectAgent(isHttps, shouldIgnoreSSL, lookup);
  }
  const key = `${isHttps ? 'https' : 'http'}:${shouldIgnoreSSL ? 'insecure' : 'strict'}`;
  let agent = sharedDirectAgents.get(key);
  if (!agent) {
    agent = createDirectAgent(isHttps, shouldIgnoreSSL, guardedLookup);
    sharedDirectAgents.set(key, agent);
  }
  return agent;
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

  // Determine if SSL should be ignored for this specific URL
  let shouldIgnoreSSL;
  if (forceIgnoreSSL !== null) {
    shouldIgnoreSSL = forceIgnoreSSL;
  } else {
    shouldIgnoreSSL = shouldIgnoreSSLForURL(url, sslConfig);
  }

  // One routing decision, shared with the diagnostics and the admin proxy test
  // so all three can never disagree about how a URL is transported.
  const routing = describeProxyRouting(url, proxyConfig);

  if (routing.decision === 'bypassed') {
    logger.info('Bypassing proxy for URL', { component: 'HttpConfig', url });
    // Direct connection: apply SSL bypass and/or DNS pinning as needed.
    return guardedDirectAgent(isHttps, shouldIgnoreSSL, lookup);
  }

  if (routing.decision === 'excluded') {
    logger.info('URL does not match proxy patterns', { component: 'HttpConfig', url });
    // Direct connection: apply SSL bypass and/or DNS pinning as needed.
    return guardedDirectAgent(isHttps, shouldIgnoreSSL, lookup);
  }

  // Apply proxy configuration
  if (routing.decision === 'proxied') {
    const proxyUrl = routing.proxyUrl;
    logger.info('Using proxy for URL', {
      component: 'HttpConfig',
      proxyUrl: redactUrlSecrets(proxyUrl),
      url
    });
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
  return guardedDirectAgent(isHttps, shouldIgnoreSSL, lookup);
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
