/**
 * Shared diagnostics helpers for the admin integration tests (iFinder, iAssistant).
 *
 * The admin "Test iFinder" / "Test iAssistant" buttons used to return a single
 * pass/fail message. When a connection did not work that told an admin almost
 * nothing: a 500 from iFinder because iFinder itself could not resolve the
 * hostname iHub advertised, and a 401 with an empty body, both look identical.
 *
 * These helpers turn a test into a sequence of named steps. Every step reports a
 * status, a human message, the raw facts it observed (URLs, resolved IPs,
 * certificate subject, decoded JWT claims) and — when it fails — concrete hints
 * about what to check. Nothing here is iFinder-specific, so the same primitives
 * back both integration tests.
 */
import dns from 'dns';
import net from 'net';
import tls from 'tls';
import jwt from 'jsonwebtoken';
import {
  getProxyConfig,
  getSSLConfig,
  matchesProxyPattern,
  shouldBypassProxy,
  shouldIgnoreSSLForURL
} from '../../utils/httpConfig.js';

export const STATUS = {
  OK: 'ok',
  WARN: 'warn',
  FAIL: 'fail',
  SKIP: 'skip'
};

/**
 * Collects the ordered steps of one integration test run.
 *
 * A step is either recorded directly with `add()` or produced by `run()`, which
 * measures the duration and converts a thrown error into a failed step so a
 * single unexpected exception cannot swallow the steps already collected.
 */
export class DiagnosticsReport {
  constructor() {
    this.steps = [];
    this.startedAt = Date.now();
  }

  /**
   * Record a finished step.
   * @param {Object} step
   * @param {string} step.id - Stable identifier, used by the UI as a key
   * @param {string} step.label - Short human label ("DNS resolution")
   * @param {string} step.status - One of STATUS
   * @param {string} [step.message] - One-line result summary
   * @param {Object} [step.details] - Raw observed facts, rendered as JSON
   * @param {string[]} [step.hints] - What the admin should check on failure.
   *   Deduplicated, since several classifiers can independently suggest the same
   *   check and a repeated line reads like a bug.
   * @param {number} [step.durationMs]
   * @returns {Object} The recorded step
   */
  add({ id, label, status, message = '', details = undefined, hints = undefined, durationMs }) {
    const step = { id, label, status, message };
    if (typeof durationMs === 'number') step.durationMs = durationMs;
    if (details && Object.keys(details).length > 0) step.details = details;
    if (hints && hints.length > 0) step.hints = [...new Set(hints)];
    this.steps.push(step);
    return step;
  }

  /**
   * Run `fn` as a step. `fn` returns `{ status, message, details, hints }`;
   * anything it throws becomes a failed step.
   * @param {string} id
   * @param {string} label
   * @param {() => Promise<Object>|Object} fn
   * @returns {Promise<Object>} The recorded step
   */
  async run(id, label, fn) {
    const startedAt = Date.now();
    try {
      const result = (await fn()) || {};
      return this.add({
        id,
        label,
        status: result.status || STATUS.OK,
        message: result.message,
        details: result.details,
        hints: result.hints,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      return this.add({
        id,
        label,
        status: STATUS.FAIL,
        message: error?.message || String(error),
        details: { error: error?.message || String(error), code: error?.code },
        durationMs: Date.now() - startedAt
      });
    }
  }

  /** Record a step that was not applicable for this configuration. */
  skip(id, label, message) {
    return this.add({ id, label, status: STATUS.SKIP, message });
  }

  /** @returns {boolean} True when at least one step failed */
  hasFailure() {
    return this.steps.some(step => step.status === STATUS.FAIL);
  }

  /** @returns {Object} Status counts plus the total wall time of the run */
  summary() {
    const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
    for (const step of this.steps) {
      if (counts[step.status] !== undefined) counts[step.status] += 1;
    }
    return { ...counts, total: this.steps.length, durationMs: Date.now() - this.startedAt };
  }
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]']);

/**
 * True for RFC1918 / link-local / unique-local addresses, which are reachable
 * inside a network but usually not from a peer in another network segment.
 * @param {string} host
 * @returns {boolean}
 */
export function isPrivateAddress(host) {
  if (!host) return false;
  const value = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (/^10\./.test(value)) return true;
  if (/^192\.168\./.test(value)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(value)) return true;
  if (/^169\.254\./.test(value)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(value)) return true;
  if (/^fe80:/.test(value)) return true;
  return false;
}

/**
 * Parse a configured URL and flag the shapes that break integrations.
 *
 * The `remoteCallback` mode is for URLs that a *different* machine has to call
 * (the OIDC issuer iFinder fetches JWKS from). There a short hostname or a
 * loopback address is a hard failure rather than a cosmetic warning — it is the
 * exact reason an iFinder token validation returns 500 with "could not resolve".
 *
 * @param {string} rawUrl
 * @param {Object} [options]
 * @param {boolean} [options.remoteCallback=false] - URL must be resolvable by another host
 * @returns {Object} Inspection result including `warnings` and `errors`
 */
export function inspectUrl(rawUrl, { remoteCallback = false } = {}) {
  const warnings = [];
  const errors = [];

  if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return { valid: false, raw: rawUrl || '', errors: ['URL is empty'], warnings };
  }

  if (rawUrl !== rawUrl.trim()) {
    warnings.push(
      'URL has leading or trailing whitespace. This usually comes from copy & paste and can break request routing.'
    );
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return {
      valid: false,
      raw: rawUrl,
      errors: [
        `"${rawUrl}" is not a valid absolute URL. It must include the scheme, e.g. https://ifinder.example.com`
      ],
      warnings
    };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    errors.push(`Unsupported scheme "${parsed.protocol}". Use http:// or https://.`);
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const isIpLiteral = net.isIP(hostname) !== 0;
  const isLoopback = LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
  const isPrivate = isPrivateAddress(hostname);
  // A hostname without a dot is a single-label name. It resolves only for hosts
  // whose DNS search domain happens to complete it, which is why it works from
  // the iHub shell and then fails inside iFinder.
  const isFqdn = !isIpLiteral && hostname.includes('.');

  if (parsed.protocol === 'http:' && !isLoopback) {
    warnings.push(
      'Uses http://. The JWT is sent in a header over an unencrypted connection. Use https:// outside of local testing.'
    );
  }

  if (isLoopback) {
    const text =
      'Points at localhost. Only processes on this same machine can reach it — any other host, including iFinder, cannot.';
    if (remoteCallback) errors.push(text);
    else warnings.push(text);
  } else if (!isFqdn && !isIpLiteral) {
    const text = `"${hostname}" is a short (single-label) hostname. It only resolves where a matching DNS search domain is configured. Use the fully qualified domain name, e.g. ${hostname}.example.com.`;
    if (remoteCallback) errors.push(text);
    else warnings.push(text);
  } else if (isPrivate && remoteCallback) {
    warnings.push(
      `${hostname} is a private address. Make sure it is routable from the iFinder server, not just from iHub.`
    );
  }

  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;

  return {
    valid: errors.length === 0,
    raw: rawUrl,
    url: parsed.toString(),
    origin: parsed.origin,
    protocol: parsed.protocol.replace(':', ''),
    hostname,
    port,
    defaultPort: !parsed.port,
    pathname: parsed.pathname,
    isIpLiteral,
    isFqdn,
    isLoopback,
    isPrivate,
    warnings,
    errors
  };
}

/**
 * Resolve a hostname through the OS resolver — the same path node-fetch takes.
 * @param {string} hostname
 * @returns {Promise<Object>} `{ resolved, addresses, error, code }`
 */
export async function resolveHostname(hostname) {
  if (net.isIP(hostname) !== 0) {
    return {
      resolved: true,
      literal: true,
      addresses: [{ address: hostname, family: net.isIP(hostname) }]
    };
  }
  try {
    const addresses = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    return { resolved: true, literal: false, addresses };
  } catch (error) {
    return { resolved: false, literal: false, error: error.message, code: error.code };
  }
}

/**
 * Open a TCP (and for https a TLS) connection to check reachability and collect
 * certificate facts.
 *
 * Certificate verification follows the platform SSL policy, so the probe behaves
 * exactly like a real outbound request: it never trusts more than the rest of the
 * server does. A certificate the trust store rejects therefore aborts the
 * handshake, and the probe reports that as `certificateRejected` together with
 * Node's specific reason (self-signed, expired, unknown CA, hostname mismatch).
 * That still distinguishes "unreachable" from "reachable but not trusted", which
 * are very different fixes, without ever disabling validation to find out.
 *
 * @param {Object} params
 * @param {string} params.hostname
 * @param {number} params.port
 * @param {string} params.protocol - 'http' or 'https'
 * @param {number} [params.timeout=10000]
 * @param {boolean} [params.rejectUnauthorized=true] - Pass the platform SSL policy
 *   for this URL (see `describeTransport().ignoreInvalidCertificates`). Only an
 *   explicit admin whitelist entry may relax it.
 * @returns {Promise<Object>} Probe result
 */
export function probeTcpTls({
  hostname,
  port,
  protocol,
  timeout = 10000,
  rejectUnauthorized = true
}) {
  const useTls = protocol === 'https';
  const startedAt = Date.now();

  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // socket already gone
      }
      resolve({ ...result, durationMs: Date.now() - startedAt });
    };

    const socket = useTls
      ? tls.connect({
          host: hostname,
          port,
          // RFC 6066 forbids an IP address as the SNI server name, and Node warns
          // about it. Only send SNI for real hostnames.
          ...(net.isIP(hostname) === 0 ? { servername: hostname } : {}),
          rejectUnauthorized
        })
      : net.connect({ host: hostname, port });

    socket.setTimeout(timeout);

    socket.on('timeout', () =>
      finish({
        connected: false,
        error: `Connection to ${hostname}:${port} timed out after ${timeout}ms`,
        code: 'ETIMEDOUT'
      })
    );

    socket.on('error', error =>
      finish({
        connected: false,
        // A TLS-level rejection means the TCP connection and the handshake
        // succeeded far enough to receive a certificate, so the host is
        // reachable and only trust is the problem.
        certificateRejected: isCertificateError(error),
        error: error.message,
        code: error.code
      })
    );

    const onConnect = () => {
      if (!useTls) {
        finish({ connected: true, remoteAddress: socket.remoteAddress });
        return;
      }

      const cert = socket.getPeerCertificate() || {};
      const now = Date.now();
      const validTo = cert.valid_to ? Date.parse(cert.valid_to) : NaN;
      finish({
        connected: true,
        remoteAddress: socket.remoteAddress,
        tls: {
          authorized: socket.authorized,
          authorizationError: socket.authorizationError
            ? String(socket.authorizationError)
            : undefined,
          protocol: socket.getProtocol(),
          subject: cert.subject?.CN,
          subjectAltName: cert.subjectaltname,
          issuer: cert.issuer?.CN || cert.issuer?.O,
          validFrom: cert.valid_from,
          validTo: cert.valid_to,
          expired: Number.isFinite(validTo) ? validTo < now : undefined,
          selfSigned: Boolean(cert.subject?.CN && cert.subject.CN === cert.issuer?.CN)
        }
      });
    };

    socket.on(useTls ? 'secureConnect' : 'connect', onConnect);
  });
}

/**
 * OpenSSL verification failures Node surfaces as `error.code`. Matching them lets
 * the diagnostics say "reachable but the certificate was rejected" instead of
 * lumping a trust problem in with an unreachable host.
 */
const CERTIFICATE_ERROR_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_SIGNATURE_FAILURE',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
]);

/**
 * True when a connection error is a certificate verification failure rather than
 * a transport failure.
 * @param {Error} error
 * @returns {boolean}
 */
export function isCertificateError(error) {
  if (!error) return false;
  if (CERTIFICATE_ERROR_CODES.has(error.code)) return true;
  return /certificate|self.signed|unable to verify|altnames/i.test(error.message || '');
}

/**
 * Report how an outbound request to `url` is actually transported.
 *
 * Mirrors the decisions `createAgent()` makes. It matters for diagnostics
 * because the TCP/TLS probe always connects directly: when a proxy is in play a
 * direct probe can fail while the real request succeeds, and vice versa.
 *
 * @param {string} url
 * @returns {Object} `{ viaProxy, proxyUrl, ignoreInvalidCertificates }`
 */
export function describeTransport(url) {
  const proxyConfig = getProxyConfig();
  const isHttps = url.startsWith('https://');
  const candidateProxy = isHttps ? proxyConfig.https : proxyConfig.http;

  let viaProxy = Boolean(proxyConfig.enabled && candidateProxy);
  if (viaProxy && proxyConfig.noProxy && shouldBypassProxy(url, proxyConfig.noProxy)) {
    viaProxy = false;
  }
  if (
    viaProxy &&
    proxyConfig.urlPatterns?.length > 0 &&
    !matchesProxyPattern(url, proxyConfig.urlPatterns)
  ) {
    viaProxy = false;
  }

  return {
    viaProxy,
    proxyUrl: viaProxy ? candidateProxy : undefined,
    ignoreInvalidCertificates: shouldIgnoreSSLForURL(url, getSSLConfig())
  };
}

/**
 * Decode a JWT without verifying it, and surface the claims an admin needs to
 * compare against the iFinder side of the trust configuration.
 * @param {string} token
 * @returns {Object} `{ header, payload, subject, issuer, audience, ... }`
 */
export function decodeJwt(token) {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded) {
    return { decoded: false, error: 'Token could not be decoded — it is not a well-formed JWT.' };
  }

  const { header, payload } = decoded;
  const toIso = value =>
    typeof value === 'number' ? new Date(value * 1000).toISOString() : undefined;

  return {
    decoded: true,
    header,
    payload,
    subject: payload.sub,
    issuer: payload.iss,
    audience: payload.aud,
    scope: payload.scope,
    algorithm: header.alg,
    keyId: header.kid,
    issuedAt: toIso(payload.iat),
    expiresAt: toIso(payload.exp),
    lifetimeSeconds:
      typeof payload.exp === 'number' && typeof payload.iat === 'number'
        ? payload.exp - payload.iat
        : undefined
  };
}

/**
 * Shorten a token for display so it can be recognised in logs without being
 * usable if the screenshot leaks.
 * @param {string} token
 * @returns {string}
 */
export function previewToken(token) {
  if (!token || typeof token !== 'string') return '';
  if (token.length <= 24) return token;
  return `${token.slice(0, 12)}…${token.slice(-8)} (${token.length} chars)`;
}

/**
 * Replace the credential in an Authorization header with a placeholder.
 * @param {Object} headers
 * @returns {Object} Copy with Authorization redacted
 */
export function redactHeaders(headers = {}) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/^authorization$/i.test(key) && typeof value === 'string') {
      const [scheme] = value.split(' ');
      result[key] = `${scheme} <jwt>`;
    } else {
      result[key] = value;
    }
  }
  return result;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a copy-pasteable curl command that reproduces a request.
 *
 * When `token` is omitted the command references `$TOKEN`, so it is safe to
 * paste into a ticket and the admin can export the variable themselves.
 *
 * @param {Object} params
 * @param {string} params.url
 * @param {string} [params.method='GET']
 * @param {Object} [params.headers] - Authorization is replaced by the token handling
 * @param {string} [params.token] - Raw JWT to inline
 * @param {string} [params.body]
 * @returns {string} curl command
 */
export function buildCurlCommand({ url, method = 'GET', headers = {}, token, body }) {
  const parts = ['curl', '-i', '-X', method, shellQuote(url)];

  for (const [key, value] of Object.entries(headers)) {
    if (/^authorization$/i.test(key)) continue;
    parts.push('-H', shellQuote(`${key}: ${value}`));
  }

  parts.push(
    '-H',
    token ? shellQuote(`Authorization: Bearer ${token}`) : `"Authorization: Bearer $TOKEN"`
  );

  if (body) parts.push('--data-raw', shellQuote(body));

  return parts.join(' ');
}

/** Response headers worth keeping — the rest is noise for this purpose. */
const INTERESTING_RESPONSE_HEADERS = [
  'www-authenticate',
  'content-type',
  'x-request-id',
  'x-correlation-id',
  'retry-after',
  'server',
  'location',
  'date'
];

/**
 * Pick the response headers that help explain a failure.
 * `www-authenticate` in particular usually carries the real reason a 401 happened.
 * @param {Object} headers - node-fetch Headers instance
 * @returns {Object}
 */
export function pickResponseHeaders(headers) {
  const result = {};
  if (!headers || typeof headers.get !== 'function') return result;
  for (const name of INTERESTING_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value) result[name] = value;
  }
  return result;
}

/**
 * Truncate a response body so a large HTML error page does not flood the UI.
 * @param {string} body
 * @param {number} [max=2000]
 * @returns {string}
 */
export function truncateBody(body, max = 2000) {
  if (!body) return '';
  if (body.length <= max) return body;
  return `${body.slice(0, max)}\n… (truncated, ${body.length} chars total)`;
}

/**
 * Turn a transport-level error into an explanation plus next steps.
 * @param {Error} error
 * @param {Object} context
 * @param {string} [context.hostname]
 * @param {number} [context.port]
 * @param {number} [context.timeout]
 * @returns {string[]} Hints
 */
export function describeNetworkError(error, { hostname, port, timeout } = {}) {
  const code = error?.code || '';
  const message = error?.message || String(error);
  const hints = [];

  if (code === 'ENOTFOUND' || /getaddrinfo/i.test(message)) {
    hints.push(
      `DNS lookup for "${hostname}" failed on the iHub server. Verify the hostname, use the fully qualified domain name, and check /etc/hosts or the DNS resolver of the iHub container.`
    );
  } else if (code === 'ECONNREFUSED') {
    hints.push(
      `Nothing is listening on ${hostname}:${port}. Check the port, and whether iFinder is exposed on a different one (443 vs 8443).`
    );
  } else if (
    code === 'ETIMEDOUT' ||
    code === 'ERR_SOCKET_CONNECTION_TIMEOUT' ||
    /timeout/i.test(message)
  ) {
    hints.push(
      `The connection to ${hostname}:${port} timed out${timeout ? ` after ${timeout}ms` : ''}. A firewall dropping the packets is the usual cause; also confirm whether the traffic needs to go through an HTTP proxy.`
    );
  } else if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    hints.push(
      `No network route from the iHub server to ${hostname}. Check routing and network policies.`
    );
  } else if (
    /self.signed|unable to verify|CERT_|DEPTH_ZERO/i.test(message) ||
    code?.startsWith?.('CERT')
  ) {
    hints.push(
      'The TLS certificate of the target was rejected. Add the issuing CA to the trust store of the iHub server, or whitelist the domain under Admin > Platform > SSL.'
    );
  } else if (code === 'EPROTO' || /wrong version number/i.test(message)) {
    hints.push(
      'TLS handshake failed. The scheme is probably wrong — an https:// URL against a plain HTTP port, or the other way round.'
    );
  }

  hints.push('Check the iHub server log (component "IntegrationTest") for the full stack trace.');
  return hints;
}

/**
 * Explain an HTTP error status in terms of the iFinder/iAssistant trust setup.
 *
 * @param {Object} params
 * @param {number} params.status
 * @param {string} [params.body] - Response body (already truncated)
 * @param {Object} [params.headers] - Picked response headers
 * @param {Object} [params.jwt] - Result of decodeJwt for the token that was sent
 * @param {Object} [params.context]
 * @param {boolean} [params.context.useOidcKeyPair]
 * @param {string} [params.context.jwksUrl]
 * @param {string} [params.context.searchProfile]
 * @param {string} [params.context.profileId]
 * @returns {string[]} Hints
 */
export function describeHttpFailure({
  status,
  body = '',
  headers = {},
  jwt: jwtInfo = {},
  context = {}
}) {
  const hints = [];
  const wwwAuthenticate = headers['www-authenticate'];

  if (status === 401) {
    if (wwwAuthenticate) {
      hints.push(
        `The server answered with WWW-Authenticate: ${wwwAuthenticate} — it usually names the exact reason.`
      );
    }
    hints.push(
      `iFinder rejected the token. Compare the claims iHub sent with what iFinder expects: sub="${jwtInfo.subject ?? '?'}", iss="${jwtInfo.issuer ?? '?'}", aud=${JSON.stringify(jwtInfo.audience ?? null)}, alg="${jwtInfo.algorithm ?? '?'}"${jwtInfo.keyId ? `, kid="${jwtInfo.keyId}"` : ''}.`
    );
    if (context.useOidcKeyPair) {
      hints.push(
        `In OIDC key pair mode iFinder validates the signature by fetching ${context.jwksUrl || 'the JWKS endpoint of the issuer'}. iFinder must be able to resolve and reach that URL, and the "kid" above must appear in it.`
      );
      hints.push(
        'Make sure the trusted issuer configured in iFinder is exactly the "iss" value above — a trailing slash or an http/https mismatch is enough to fail.'
      );
    } else {
      hints.push(
        'In private key mode iFinder verifies with the matching public key. Confirm the public key deployed in iFinder belongs to the private key configured here, and that the algorithm matches.'
      );
    }
    hints.push(
      'Check the JWT Subject Field: iFinder has to know the subject as a user. An email where iFinder expects DOMAIN\\username (or vice versa) also produces a 401.'
    );
    hints.push(
      'Verify the clock of the iHub server — a skew larger than the leeway of iFinder invalidates iat/exp.'
    );
  } else if (status === 403) {
    hints.push(
      `The token was accepted but access was denied. Check the scope ("${jwtInfo.scope ?? '?'}") and whether the user "${jwtInfo.subject ?? '?'}" is permitted on the search profile.`
    );
  } else if (status === 404) {
    hints.push(
      'The endpoint or the profile does not exist. Verify the base URL does not already contain /public-api (iHub appends the API path itself) and that the profile id is spelled exactly as in iFinder.'
    );
    if (context.searchProfile) hints.push(`Search profile used: "${context.searchProfile}".`);
    if (context.profileId) hints.push(`iAssistant profile id used: "${context.profileId}".`);
  } else if (status === 405) {
    hints.push(
      'The endpoint exists but rejects this method. The configured endpoint path is most likely wrong.'
    );
  } else if (status === 500 || status === 502 || status === 503 || status === 504) {
    hints.push(
      'The target answered with a server error, so the request reached it. Its own log holds the cause — the classic one is that iFinder cannot resolve or reach the JWKS/issuer URL of iHub while validating the token.'
    );
    if (context.jwksUrl) {
      hints.push(
        `Verify from the iFinder host that ${context.jwksUrl} resolves and responds, for example: curl -sv ${context.jwksUrl}`
      );
    }
    hints.push(
      'A short hostname is the usual culprit: it resolves on the iHub host but not inside iFinder. Always configure fully qualified domain names.'
    );
  } else if (status === 415) {
    hints.push('The target rejected the content type. This points at a mismatched API version.');
  }

  if (/^\s*<(!doctype|html)/i.test(body)) {
    hints.push(
      'The response body is HTML, not JSON. A reverse proxy, load balancer or SSO login page is answering instead of the API.'
    );
  }

  return hints;
}
