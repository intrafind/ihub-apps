/**
 * Admin API for the outbound HTTP(S) proxy.
 *
 * This is the proxy iHub itself uses for egress — LLM providers, web search,
 * Jira, OIDC, MCP servers. It is unrelated to `proxyAuth` (inbound header-based
 * login) and `trustProxy` (inbound hop count), which live elsewhere in
 * platform.json and are not touched here.
 *
 * Endpoints mirror the SSL/SSRF admin routes and add a connectivity test so an
 * operator can find out *why* egress fails without reading server logs.
 */
import net from 'node:net';
import { adminAuth } from '../../middleware/adminAuth.js';
import logger from '../../utils/logger.js';
import {
  sendInternalError,
  sendBadRequest,
  sendErrorResponse
} from '../../utils/responseHelpers.js';
import configCache from '../../configCache.js';
import { buildServerPath } from '../../utils/basePath.js';
import configStore from '../../services/config/ConfigStore.js';
import tokenStorageService from '../../services/TokenStorageService.js';
import { proxyConfigSchema } from '../../validators/platformConfigSchema.js';
import { resolveEnvVars } from '../../utils/envVars.js';
import { isCertificateError } from '../../services/integrations/integrationDiagnostics.js';
import { assertSafeHost } from '../../services/mcp/safeFetch.js';
import {
  createAgent,
  describeProxyRouting,
  getProxyProvenance,
  getSSLConfig,
  isUnresolvedPlaceholder,
  normalizeNoProxy,
  redactUrlSecrets,
  shouldIgnoreSSLForURL
} from '../../utils/httpConfig.js';
import nodeFetch from 'node-fetch';

const PLATFORM_FILE = 'config/platform.json';

/** Placeholder the UI shows (and sends back) instead of a proxy password. */
const SECRET_MASK = '***REDACTED***';

/** Connectivity test bounds, in milliseconds. */
const DEFAULT_TEST_TIMEOUT_MS = 10000;
const MIN_TEST_TIMEOUT_MS = 1000;
const MAX_TEST_TIMEOUT_MS = 30000;

/**
 * Bound the caller-supplied test timeout to a fixed range.
 *
 * The value arrives in a request body and ends up as a timer duration and a
 * socket timeout, so it is clamped with explicit comparisons rather than left to
 * flow: anything unparseable or below the floor falls back to the default, and
 * anything above the ceiling is capped.
 *
 * @param {*} value - Raw `timeoutMs` from the request body
 * @returns {number} Milliseconds within [MIN_TEST_TIMEOUT_MS, MAX_TEST_TIMEOUT_MS]
 */
export function clampTestTimeout(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_TEST_TIMEOUT_MS) return DEFAULT_TEST_TIMEOUT_MS;
  if (parsed > MAX_TEST_TIMEOUT_MS) return MAX_TEST_TIMEOUT_MS;
  return parsed;
}

/**
 * Decrypt a stored proxy URL if it is an `ENC[...]` value. Returns the input
 * unchanged for plaintext, placeholders and undecryptable values.
 * @param {*} value
 * @returns {*}
 */
function decryptStored(value) {
  if (typeof value !== 'string' || !tokenStorageService.isEncrypted(value)) return value;
  try {
    return tokenStorageService.decryptString(value);
  } catch (error) {
    logger.error('Failed to decrypt stored proxy URL', { component: 'AdminProxy', error });
    return '';
  }
}

/**
 * Encrypt a proxy URL for storage. `${ENV_VAR}` placeholders and empty values
 * pass through untouched so an operator who points the config at the
 * environment keeps that indirection across saves.
 * @param {string} value
 * @returns {string}
 */
function encryptForStorage(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (isUnresolvedPlaceholder(trimmed)) return trimmed;
  if (tokenStorageService.isEncrypted(trimmed)) return trimmed;
  return tokenStorageService.encryptString(trimmed);
}

/**
 * Mask the password in a proxy URL, keeping scheme, user, host and port visible
 * so an operator can still recognise which proxy is configured.
 * @param {string} value - Plaintext proxy URL, or a placeholder
 * @returns {string} Same URL with the password replaced by {@link SECRET_MASK}
 */
export function maskProxyUrl(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed || isUnresolvedPlaceholder(trimmed)) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (!parsed.password) return trimmed;
    parsed.password = SECRET_MASK;
    // URL serialization percent-encodes the mask's asterisks; put it back so the
    // client can compare against (and send back) the literal placeholder.
    return parsed.toString().replace(encodeURIComponent(SECRET_MASK), SECRET_MASK);
  } catch {
    // Unparseable values never reach storage (the schema rejects them), but a
    // hand-edited platform.json can still hold one. Redact defensively.
    return redactUrlSecrets(trimmed);
  }
}

/**
 * Put the stored password back when the client returns the masked form.
 *
 * Only the password is restored, so an operator can change host, port or user
 * without having to retype the password.
 *
 * @param {string} incoming - Value submitted by the admin UI
 * @param {string} stored - Current plaintext value from platform.json
 * @returns {string} Value to persist
 */
export function restoreProxyUrlSecret(incoming, stored) {
  if (typeof incoming !== 'string' || !incoming.includes(SECRET_MASK)) return incoming;
  let storedPassword = '';
  try {
    storedPassword = new URL(stored || '').password;
  } catch {
    storedPassword = '';
  }
  try {
    const parsed = new URL(incoming);
    parsed.password = storedPassword;
    return parsed.toString();
  } catch {
    // Not a URL we can rewrite — fall back to keeping what is stored rather than
    // persisting a literal "***REDACTED***" as the proxy URL.
    return stored || '';
  }
}

/**
 * Build the GET/PUT response body: what is stored, what is actually in effect,
 * and where each effective field came from.
 * @param {Object} storedProxy - The `proxy` block as it sits in platform.json
 * @returns {Object}
 */
function buildConfigResponse(storedProxy = {}) {
  const provenance = getProxyProvenance();
  return {
    // What the editor round-trips: platform.json values, secrets masked,
    // `${ENV_VAR}` placeholders preserved verbatim.
    config: {
      enabled: storedProxy.enabled !== false,
      http: maskProxyUrl(decryptStored(storedProxy.http)),
      https: maskProxyUrl(decryptStored(storedProxy.https)),
      noProxy: Array.isArray(storedProxy.noProxy)
        ? storedProxy.noProxy
        : normalizeNoProxy(storedProxy.noProxy),
      urlPatterns: Array.isArray(storedProxy.urlPatterns) ? storedProxy.urlPatterns : []
    },
    // What the runtime uses right now, including values coming from the
    // environment rather than platform.json.
    effective: {
      enabled: provenance.enabled.value,
      http: maskProxyUrl(provenance.http.value),
      https: maskProxyUrl(provenance.https.value),
      noProxy: provenance.noProxy.value,
      urlPatterns: provenance.urlPatterns.value
    },
    // 'platform' | 'environment' | 'default' per field.
    provenance: {
      enabled: provenance.enabled.source,
      http: provenance.http.source,
      https: provenance.https.source,
      noProxy: provenance.noProxy.source,
      urlPatterns: provenance.urlPatterns.source
    },
    // Placeholders that never resolved, so the UI can say so instead of leaving
    // the operator wondering why a configured proxy is not used.
    unresolvedPlaceholders: {
      http: provenance.http.placeholderIgnored,
      https: provenance.https.placeholderIgnored
    }
  };
}

/**
 * Split a proxy URL into the host/port a TCP probe needs.
 * @param {string} proxyUrl
 * @returns {{host: string, port: number}|null}
 */
function proxyEndpoint(proxyUrl) {
  try {
    const parsed = new URL(proxyUrl);
    const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    return { host: parsed.hostname, port };
  } catch {
    return null;
  }
}

/**
 * Open a bare TCP connection to the proxy and close it again.
 *
 * Run before the real request so "the proxy is unreachable" can be told apart
 * from "the proxy is fine but the target is not" — the two produce very similar
 * errors on the fetch itself.
 *
 * @param {{host: string, port: number}} endpoint
 * @param {number} timeoutMs
 * @returns {Promise<{reachable: boolean, durationMs: number, code?: string, error?: string}>}
 */
function probeProxyReachable(endpoint, timeoutMs) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const socket = net.connect({ host: endpoint.host, port: endpoint.port });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ durationMs: Date.now() - startedAt, ...result });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ reachable: true }));
    socket.once('timeout', () =>
      finish({ reachable: false, code: 'ETIMEDOUT', error: 'timed out' })
    );
    socket.once('error', error =>
      finish({ reachable: false, code: error.code, error: error.message })
    );
  });
}

/**
 * Turn a failed (or merely unhappy) proxy test into a classification an operator
 * can act on. Every branch pairs a cause with the next thing to check.
 *
 * @param {Object} params
 * @param {Error} [params.error] - Transport error, if the request threw
 * @param {number} [params.status] - HTTP status, if a response came back
 * @param {Object} [params.proxyProbe] - Result of {@link probeProxyReachable}
 * @param {boolean} params.viaProxy - Whether the request was routed through a proxy
 * @returns {{classification: string, message: string, nextStep: string}}
 */
export function classifyProxyTestResult({ error, status, proxyProbe, viaProxy }) {
  if (!error && typeof status === 'number') {
    if (status === 407) {
      return {
        classification: 'proxy_auth_required',
        message: `The proxy answered 407 Proxy Authentication Required.`,
        nextStep:
          'Add credentials to the proxy URL (http://user:password@proxy.example.com:8080) or allow this host unauthenticated on the proxy.'
      };
    }
    if (status >= 400) {
      return {
        classification: 'http_error',
        message: `The target answered HTTP ${status}.`,
        nextStep: viaProxy
          ? 'The proxy hop works — this status comes from the target (or from the proxy acting for it). Check the URL and any credentials the target needs.'
          : 'The connection works — this status comes from the target. Check the URL and any credentials the target needs.'
      };
    }
    return {
      classification: 'ok',
      message: `The target answered HTTP ${status}.`,
      nextStep: viaProxy
        ? 'Egress through the proxy works for this URL.'
        : 'Egress works for this URL without a proxy.'
    };
  }

  // Proxy could not even be reached at TCP level — say so before blaming the target.
  if (viaProxy && proxyProbe && proxyProbe.reachable === false) {
    if (proxyProbe.code === 'ENOTFOUND' || proxyProbe.code === 'EAI_AGAIN') {
      return {
        classification: 'proxy_dns_failure',
        message: `The proxy host could not be resolved (${proxyProbe.code}).`,
        nextStep:
          'Check the hostname in the proxy URL, or use its IP address if this host has no DNS for it.'
      };
    }
    return {
      classification: 'proxy_unreachable',
      message: `No TCP connection to the proxy (${proxyProbe.code || 'connection failed'}).`,
      nextStep:
        'Check the proxy host and port, that the proxy is running, and that this host is allowed to reach it.'
    };
  }

  const code = error?.code || error?.cause?.code;
  const message = error?.message || 'request failed';

  if (error?.name === 'AbortError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return {
      classification: 'timeout',
      message: 'The request timed out.',
      nextStep: viaProxy
        ? 'The proxy accepted the connection but produced no response in time. Check whether the proxy is allowed to reach this target.'
        : 'The target produced no response in time. Check the URL and whether this host needs a proxy to reach it.'
    };
  }

  if (/407/.test(message)) {
    return {
      classification: 'proxy_auth_required',
      message: 'The proxy refused the tunnel with 407 Proxy Authentication Required.',
      nextStep:
        'Add credentials to the proxy URL (http://user:password@proxy.example.com:8080) or allow this host unauthenticated on the proxy.'
    };
  }

  if (isCertificateError(error)) {
    return {
      classification: 'tls_failure',
      message: `TLS verification failed: ${message}`,
      nextStep:
        'If the proxy terminates TLS with its own CA, add the target host to ssl.domainWhitelist and enable ssl.ignoreInvalidCertificates, or install the proxy CA on this host.'
    };
  }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return {
      classification: 'dns_failure',
      message: `The target host could not be resolved (${code}).`,
      nextStep: viaProxy
        ? 'The proxy normally resolves the target itself — check the URL, and whether this host is expected to resolve it too.'
        : 'Check the URL, this host’s DNS, or configure a proxy if direct egress is not allowed here.'
    };
  }

  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return {
      classification: viaProxy ? 'proxy_unreachable' : 'target_unreachable',
      message: `Connection failed (${code}).`,
      nextStep: viaProxy
        ? 'Check the proxy host and port and that the proxy is running.'
        : 'Check the target host and port, or configure a proxy if direct egress is blocked here.'
    };
  }

  return {
    classification: 'request_failed',
    message,
    nextStep: 'Check the server log (component HttpConfig) for the full error.'
  };
}

export default function registerAdminProxyRoutes(app) {
  /**
   * @swagger
   * /api/admin/proxy/config:
   *   get:
   *     summary: Get the outbound HTTP(S) proxy configuration
   *     description: |
   *       Returns the `proxy` block as stored in platform.json, the configuration
   *       actually in effect (which may come from HTTP_PROXY/HTTPS_PROXY/NO_PROXY
   *       in the environment), and the provenance of each effective field.
   *       Proxy passwords are masked as `***REDACTED***`; `${ENV_VAR}`
   *       placeholders are returned verbatim.
   *
   *       This is iHub's own egress proxy, not `proxyAuth` (inbound
   *       header-based login) and not `trustProxy` (inbound hop count).
   *     tags: [Admin - Proxy]
   *     security:
   *       - AdminSecret: []
   *     responses:
   *       200:
   *         description: Stored and effective proxy configuration
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 config:
   *                   type: object
   *                   description: The proxy block as stored in platform.json
   *                 effective:
   *                   type: object
   *                   description: The configuration the runtime uses right now
   *                 provenance:
   *                   type: object
   *                   description: Per-field origin (platform, environment, default)
   *                 unresolvedPlaceholders:
   *                   type: object
   *                   description: Placeholders that no environment variable resolved
   */
  app.get(buildServerPath('/api/admin/proxy/config'), adminAuth, async (req, res) => {
    try {
      // Read the file, not the cache: configCache substitutes `${ENV_VAR}` on
      // load, so the cached block holds the resolved URL. Handing that to the
      // editor would overwrite the placeholder with its current value on the
      // next save — exactly the indirection the operator asked for, gone.
      const onDisk = await configStore.readJson(PLATFORM_FILE);
      const storedProxy = onDisk?.proxy || configCache.getPlatform()?.proxy || {};
      res.json(buildConfigResponse(storedProxy));
    } catch (error) {
      return sendInternalError(res, error, 'get proxy configuration');
    }
  });

  /**
   * @swagger
   * /api/admin/proxy/config:
   *   put:
   *     summary: Update the outbound HTTP(S) proxy configuration
   *     description: |
   *       Validates and stores the `proxy` block, then refreshes the config cache
   *       so the change takes effect without a restart. Proxy URLs are encrypted
   *       at rest; `${ENV_VAR}` placeholders are stored verbatim. A URL whose
   *       password is sent back as `***REDACTED***` keeps the stored password.
   *     tags: [Admin - Proxy]
   *     security:
   *       - AdminSecret: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               enabled:
   *                 type: boolean
   *               http:
   *                 type: string
   *               https:
   *                 type: string
   *               noProxy:
   *                 oneOf:
   *                   - type: string
   *                   - type: array
   *                     items:
   *                       type: string
   *               urlPatterns:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       200:
   *         description: Proxy configuration updated successfully
   *       400:
   *         description: Invalid proxy configuration
   */
  app.put(buildServerPath('/api/admin/proxy/config'), adminAuth, async (req, res) => {
    try {
      const parsed = proxyConfigSchema.safeParse(req.body || {});
      if (!parsed.success) {
        const details = parsed.error.issues.map(issue => ({
          field: ['proxy', ...issue.path].join('.'),
          message: issue.message
        }));
        return sendBadRequest(
          res,
          `Invalid proxy configuration: ${details.map(d => `${d.field} ${d.message}`).join('; ')}`,
          details
        );
      }

      // readJsonStrict, not readJson: a read that fails must not be mistaken for
      // "there was nothing here" and turn this save into a full file replacement.
      const platformConfig = await configStore.readJsonStrict(PLATFORM_FILE);
      if (!platformConfig) throw new Error(`${PLATFORM_FILE} is missing`);
      const existing = platformConfig.proxy || {};

      // Masked passwords come back from the UI unchanged; put the stored one back
      // before anything is written or encrypted.
      const http = restoreProxyUrlSecret(parsed.data.http.trim(), decryptStored(existing.http));
      const https = restoreProxyUrlSecret(parsed.data.https.trim(), decryptStored(existing.https));

      const nextProxy = {
        ...existing,
        enabled: parsed.data.enabled,
        http: encryptForStorage(http),
        https: encryptForStorage(https),
        // Stored as sent: a comma-separated string and an array are both valid,
        // and getProxyConfig() normalizes either one to an array.
        noProxy: parsed.data.noProxy,
        urlPatterns: parsed.data.urlPatterns
      };

      platformConfig.proxy = nextProxy;
      await configStore.writeJson(PLATFORM_FILE, platformConfig);
      await configCache.refreshCacheEntry(PLATFORM_FILE);

      const response = buildConfigResponse(nextProxy);
      // Log what is actually in effect after the save, not what was submitted:
      // an environment variable can still win over an empty platform field.
      logger.info('Proxy configuration updated', {
        component: 'AdminProxy',
        effective: response.effective,
        provenance: response.provenance
      });

      res.json({ message: 'Proxy configuration updated successfully', ...response });
    } catch (error) {
      return sendInternalError(res, error, 'update proxy configuration');
    }
  });

  /**
   * @swagger
   * /api/admin/proxy/test:
   *   post:
   *     summary: Test outbound connectivity for a URL
   *     description: |
   *       Reports how the URL would be routed (proxied, bypassed, excluded by
   *       urlPatterns, or direct), whether the proxy itself is reachable, and what
   *       the target answered — with the failure classified and a suggested next
   *       step. Redirects are not followed and no response body is returned.
   *
   *       Pass `config` to try a draft configuration without saving it. The target
   *       must pass the SSRF guard; add internal hosts to `ssrf.allowedHosts` to
   *       test against them.
   *     tags: [Admin - Proxy]
   *     security:
   *       - AdminSecret: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [url]
   *             properties:
   *               url:
   *                 type: string
   *                 description: Absolute http(s) URL to probe
   *               timeoutMs:
   *                 type: integer
   *               config:
   *                 type: object
   *                 description: Draft proxy config to test instead of the saved one
   *     responses:
   *       200:
   *         description: Test result (also for a failed connection)
   *       400:
   *         description: Invalid request
   *       403:
   *         description: Target blocked by the SSRF guard
   */
  app.post(buildServerPath('/api/admin/proxy/test'), adminAuth, async (req, res) => {
    try {
      const { url, timeoutMs, config: draft } = req.body || {};

      if (!url || typeof url !== 'string') {
        return sendBadRequest(res, 'Invalid proxy test: url is required');
      }
      let targetUrl;
      try {
        targetUrl = new URL(url.trim());
      } catch {
        return sendBadRequest(res, `Invalid proxy test: "${url}" is not a valid URL`);
      }
      if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
        return sendBadRequest(
          res,
          `Invalid proxy test: unsupported scheme "${targetUrl.protocol.replace(':', '')}" (expected http or https)`
        );
      }

      let proxyConfig;
      if (draft && typeof draft === 'object') {
        const parsed = proxyConfigSchema.safeParse(draft);
        if (!parsed.success) {
          const details = parsed.error.issues.map(issue => ({
            field: ['proxy', ...issue.path].join('.'),
            message: issue.message
          }));
          return sendBadRequest(
            res,
            `Invalid proxy configuration: ${details.map(d => `${d.field} ${d.message}`).join('; ')}`,
            details
          );
        }
        // A draft is evaluated as sent, except that a masked password falls back
        // to the stored one so "test before save" works without retyping it.
        // Read from disk for the same reason the GET does: the cache holds
        // substituted values, not what the editor round-trips.
        const platformProxy = (await configStore.readJson(PLATFORM_FILE))?.proxy || {};
        proxyConfig = {
          enabled: parsed.data.enabled,
          // resolveEnvVars is what configCache applies on load, so a draft holding
          // `${HTTPS_PROXY}` is tested against the proxy it would actually use once
          // saved, instead of being reported as "no proxy configured for this URL".
          http: resolveEnvVars(
            restoreProxyUrlSecret(parsed.data.http.trim(), decryptStored(platformProxy.http))
          ),
          https: resolveEnvVars(
            restoreProxyUrlSecret(parsed.data.https.trim(), decryptStored(platformProxy.https))
          ),
          noProxy: normalizeNoProxy(resolveEnvVars(parsed.data.noProxy)),
          urlPatterns: parsed.data.urlPatterns
        };
        // Whatever no environment variable resolved is not a proxy URL.
        if (isUnresolvedPlaceholder(proxyConfig.http)) proxyConfig.http = '';
        if (isUnresolvedPlaceholder(proxyConfig.https)) proxyConfig.https = '';
      }

      const routing = describeProxyRouting(targetUrl.toString(), proxyConfig || null);
      const viaProxy = routing.decision === 'proxied';

      // Honor the SSRF guard: a target that resolves into a private range is
      // refused unless an admin listed it in ssrf.allowedHosts. A DNS failure is
      // not refused here — it is reported as a classified test result below,
      // which is more useful (and is the expected state on a proxy-only host,
      // where the proxy does egress DNS).
      try {
        await assertSafeHost(targetUrl.hostname, [], true);
      } catch (guardError) {
        if (guardError.code === 'SSRF_BLOCKED') {
          return sendErrorResponse(
            res,
            403,
            `${guardError.message}. Add the host to ssrf.allowedHosts (Security → SSRF Allowlist) to test against it.`
          );
        }
        // DNS_RESOLUTION_FAILED and anything else: continue and let the request
        // itself produce the classified error.
      }

      const timeout = clampTestTimeout(timeoutMs);

      let proxyProbe;
      if (viaProxy) {
        const endpoint = proxyEndpoint(routing.proxyUrl);
        proxyProbe = endpoint
          ? {
              attempted: true,
              host: endpoint.host,
              port: endpoint.port,
              ...(await probeProxyReachable(endpoint, timeout))
            }
          : {
              attempted: true,
              reachable: false,
              durationMs: 0,
              error: 'proxy URL is not parseable'
            };
      }

      // The agent comes from createAgent() — the same call every outbound request
      // makes — with the draft config passed as an override so an unsaved draft can
      // be probed without a second copy of the agent rules drifting from the real
      // one. It also means the test applies the SSL decision live traffic would, so
      // a host covered by ssl.domainWhitelist is not reported as a TLS failure that
      // never actually happens.
      const ignoreInvalidCertificates = shouldIgnoreSSLForURL(targetUrl.toString(), getSSLConfig());
      const agent = createAgent(targetUrl.toString(), null, null, proxyConfig || undefined);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      const requestStartedAt = Date.now();
      let status;
      let statusText;
      let redirectLocation;
      let requestError;
      try {
        // The target URL is admin-supplied by design — probing one is what this
        // endpoint is for. It is constrained before it gets here: the scheme must be
        // http(s), assertSafeHost() refuses anything resolving into a private range
        // unless an admin listed it in ssrf.allowedHosts, redirects are not followed
        // and the response body is never read or returned.
        // codeql[js/request-forgery]
        const response = await nodeFetch(targetUrl.toString(), {
          method: 'GET',
          // No redirect following: the point is what *this* URL does, and a
          // redirect could otherwise walk the probe to a host the guard cleared.
          redirect: 'manual',
          agent,
          signal: controller.signal,
          headers: { 'user-agent': 'iHub-Apps proxy connectivity test' }
        });
        status = response.status;
        statusText = response.statusText;
        redirectLocation = response.headers.get('location') || undefined;
        // Response bodies are never read or returned — close the stream instead.
        response.body?.destroy?.();
      } catch (error) {
        requestError = error;
      } finally {
        clearTimeout(timer);
      }
      const requestMs = Date.now() - requestStartedAt;

      const verdict = classifyProxyTestResult({
        error: requestError,
        status,
        proxyProbe,
        viaProxy
      });

      const result = {
        target: targetUrl.toString(),
        ok: verdict.classification === 'ok',
        classification: verdict.classification,
        message: verdict.message,
        nextStep: verdict.nextStep,
        routing: {
          decision: routing.decision,
          reason: routing.reason,
          proxyUrl: routing.proxyUrl ? maskProxyUrl(routing.proxyUrl) : undefined
        },
        ssl: { ignoreInvalidCertificates },
        proxy: proxyProbe
          ? {
              host: proxyProbe.host,
              port: proxyProbe.port,
              reachable: proxyProbe.reachable,
              error: proxyProbe.error
            }
          : undefined,
        response: status === undefined ? undefined : { status, statusText, redirectLocation },
        timings: {
          proxyConnectMs: proxyProbe?.durationMs,
          requestMs,
          totalMs: (proxyProbe?.durationMs || 0) + requestMs
        }
      };

      logger.info('Proxy connectivity test finished', {
        component: 'AdminProxy',
        target: redactUrlSecrets(result.target),
        decision: routing.decision,
        classification: result.classification,
        status,
        totalMs: result.timings.totalMs
      });

      res.json(result);
    } catch (error) {
      return sendInternalError(res, error, 'test proxy connectivity');
    }
  });
}
