/**
 * Whether a request may assert an identity through the proxy-auth headers
 * (`proxyAuth.userHeader`, `groupsHeader`, `X-Forwarded-Name`,
 * `X-Forwarded-Email`).
 *
 * Those headers are only as trustworthy as whoever sent them, so they are used
 * only when the request passes the checks an admin configured:
 *
 *  - `proxyAuth.trustedProxies` (or `PROXY_AUTH_TRUSTED_PROXIES`): addresses
 *    and subnets the connection must come from, in the syntax of Express's
 *    `trust proxy` (`loopback`, `10.0.0.0/8`, `192.168.1.5`, …). The address
 *    checked is the peer that opened the connection, never a forwarded one.
 *    Unset, it is `["loopback"]`, so a proxy on the same host or in the same
 *    pod works once proxy auth is on; an admin can replace or empty it.
 *  - A shared secret the proxy adds in `proxyAuth.sharedSecretHeader`
 *    (default `X-Proxy-Secret`), from the credential store
 *    (`proxyAuth.sharedSecretRef`) or `PROXY_AUTH_SHARED_SECRET`.
 *
 * When both are configured, both must pass. When neither is, the headers are
 * never trusted. A shared secret that is configured but cannot be used (its
 * credential is missing or empty, or its header name is unusable) trusts no
 * request. Signed JWTs from `proxyAuth.jwtProviders` are verified separately
 * and do not depend on this.
 *
 * @module utils/proxyAuthTrust
 */
import crypto from 'crypto';
import proxyaddr from 'proxy-addr';
import config from '../config.js';
import credentialService from '../services/CredentialService.js';
import logger from './logger.js';

/** Header the proxy sends the shared secret in, unless configured otherwise. */
export const DEFAULT_SHARED_SECRET_HEADER = 'X-Proxy-Secret';

/** `proxyAuth.trustedProxies` when it is not set: the local host. */
export const DEFAULT_TRUSTED_PROXIES = Object.freeze(['loopback']);

/** An HTTP header name (RFC 9110 token). */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Headers the shared secret may not travel in: the secret header is removed
 * from every request, and these are needed by other sign-in methods or by
 * request handling. Every `X-Forwarded-*` header is reserved as well.
 */
const RESERVED_SECRET_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'connection',
  'content-length',
  'content-type',
  'transfer-encoding'
]);

/** Compiled `trustedProxies` lists, by their joined source. */
const compiled = new Map();

/** Warnings already logged, so a busy server does not log one per request. */
const warned = new Set();
const MAX_WARNINGS = 100;

/**
 * Log `message` once per `key`.
 *
 * @param {string} key
 * @param {string} message
 * @param {object} meta
 */
function warnOnce(key, message, meta) {
  if (warned.has(key) || warned.size >= MAX_WARNINGS) return;
  warned.add(key);
  logger.warn(message, { component: 'ProxyAuth', ...meta });
}

/**
 * The configured trusted proxy list: `PROXY_AUTH_TRUSTED_PROXIES` when set,
 * otherwise `proxyAuth.trustedProxies`, otherwise `DEFAULT_TRUSTED_PROXIES`.
 * An empty list stays empty. A string is read as a comma-separated list.
 *
 * @param {object} proxyAuthConfig - `platform.proxyAuth`
 * @returns {string[]}
 */
export function getTrustedProxies(proxyAuthConfig = {}) {
  const configured = config.PROXY_AUTH_TRUSTED_PROXIES || proxyAuthConfig.trustedProxies;
  let list;
  if (configured === undefined || configured === null) list = DEFAULT_TRUSTED_PROXIES;
  else if (typeof configured === 'string') list = configured.split(',');
  else list = Array.isArray(configured) ? configured : [];
  return list.map(entry => String(entry).trim()).filter(Boolean);
}

/**
 * The configured shared secret: `PROXY_AUTH_SHARED_SECRET` when set, otherwise
 * the credential `proxyAuth.sharedSecretRef` names. `configured` says whether
 * one is asked for at all; `secret` is null when it is asked for but the
 * credential is missing or empty.
 *
 * @param {object} proxyAuthConfig - `platform.proxyAuth`
 * @returns {{configured: boolean, secret: string|null}}
 */
export function getSharedSecret(proxyAuthConfig = {}) {
  if (config.PROXY_AUTH_SHARED_SECRET) {
    return { configured: true, secret: config.PROXY_AUTH_SHARED_SECRET };
  }
  if (!proxyAuthConfig.sharedSecretRef) return { configured: false, secret: null };
  const secret = credentialService.tryResolveSecret(proxyAuthConfig.sharedSecretRef);
  return { configured: true, secret: typeof secret === 'string' && secret ? secret : null };
}

/**
 * Why `proxyAuth.sharedSecretHeader` cannot be used, or null when it can. The
 * header is removed from every request, so it must be a valid header name
 * that nothing else reads: not a reserved header, not an `X-Forwarded-*`
 * header, and not the user, groups or a JWT provider header.
 *
 * @param {object} proxyAuthConfig - `platform.proxyAuth` (with the effective
 *   `userHeader` / `groupsHeader`)
 * @returns {string|null}
 */
export function sharedSecretHeaderProblem(proxyAuthConfig = {}) {
  const name = proxyAuthConfig.sharedSecretHeader || DEFAULT_SHARED_SECRET_HEADER;
  if (typeof name !== 'string' || !HEADER_NAME.test(name)) {
    return 'is not a valid HTTP header name';
  }
  const lower = name.toLowerCase();
  const providers = Array.isArray(proxyAuthConfig.jwtProviders) ? proxyAuthConfig.jwtProviders : [];
  const inUse = [
    proxyAuthConfig.userHeader,
    proxyAuthConfig.groupsHeader,
    ...providers.map(provider => provider?.header)
  ]
    .filter(header => typeof header === 'string')
    .map(header => header.toLowerCase());
  if (
    RESERVED_SECRET_HEADERS.has(lower) ||
    lower.startsWith('x-forwarded-') ||
    inUse.includes(lower)
  ) {
    return 'is a header iHub needs for sign-in or request handling';
  }
  return null;
}

/**
 * Whether `address` is in `list`. An entry `proxy-addr` cannot parse makes
 * the whole list match nothing (and is logged), rather than being skipped.
 *
 * @param {string|undefined} address - The connection's peer address
 * @param {string[]} list
 * @returns {boolean}
 */
function isTrustedAddress(address, list) {
  if (!address) return false;
  const cacheKey = list.join(',');
  if (!compiled.has(cacheKey)) {
    try {
      compiled.set(cacheKey, proxyaddr.compile(list));
    } catch (error) {
      warnOnce(`invalid:${cacheKey}`, 'proxyAuth.trustedProxies is invalid; no proxy is trusted', {
        trustedProxies: list,
        error: error.message
      });
      compiled.set(cacheKey, () => false);
    }
  }
  return compiled.get(cacheKey)(address, 0);
}

/**
 * Compare two strings in constant time. `timingSafeEqual` needs equal
 * lengths, so on a length mismatch the expected value is compared with itself
 * and the result discarded.
 *
 * @param {string} given
 * @param {string} expected
 * @returns {boolean}
 */
function secretsMatch(given, expected) {
  const a = Buffer.from(String(given), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  const sameLength = a.length === b.length;
  return crypto.timingSafeEqual(sameLength ? a : b, b) && sameLength;
}

/**
 * Check whether `req` may use the proxy identity headers. Removes the shared
 * secret header from the request either way, so it does not travel further
 * (into logs or upstream calls) — unless its name is unusable, in which case
 * the header is left alone and a configured secret trusts no request.
 *
 * @param {import('express').Request} req
 * @param {object} proxyAuthConfig - `platform.proxyAuth`, with the effective
 *   `userHeader` / `groupsHeader`
 * @returns {{trusted: boolean, reason?: string}} `reason` says which check failed
 */
export function checkProxyTrust(req, proxyAuthConfig = {}) {
  const trustedProxies = getTrustedProxies(proxyAuthConfig);
  const { configured: secretConfigured, secret: sharedSecret } = getSharedSecret(proxyAuthConfig);
  const headerName = proxyAuthConfig.sharedSecretHeader || DEFAULT_SHARED_SECRET_HEADER;
  const headerProblem = sharedSecretHeaderProblem(proxyAuthConfig);
  let givenSecret;
  if (!headerProblem && req.headers) {
    const secretHeader = headerName.toLowerCase();
    givenSecret = req.headers[secretHeader];
    delete req.headers[secretHeader];
  }

  if (trustedProxies.length === 0 && !secretConfigured) {
    return { trusted: false, reason: 'not-configured' };
  }
  if (secretConfigured && headerProblem) {
    warnOnce(
      `secret-header:${headerName}`,
      `proxyAuth.sharedSecretHeader ${headerProblem}; no proxy is trusted`,
      { sharedSecretHeader: headerName }
    );
    return { trusted: false, reason: 'invalid-secret-header' };
  }
  if (secretConfigured && !sharedSecret) {
    warnOnce(
      `secret-unavailable:${proxyAuthConfig.sharedSecretRef}`,
      'The shared secret credential in proxyAuth.sharedSecretRef is missing or empty; no proxy is trusted',
      { sharedSecretRef: proxyAuthConfig.sharedSecretRef }
    );
    return { trusted: false, reason: 'secret-unavailable' };
  }
  const peer = req.socket?.remoteAddress;
  if (trustedProxies.length > 0 && !isTrustedAddress(peer, trustedProxies)) {
    return { trusted: false, reason: 'untrusted-address' };
  }
  if (
    sharedSecret &&
    (typeof givenSecret !== 'string' || !secretsMatch(givenSecret, sharedSecret))
  ) {
    return { trusted: false, reason: 'secret-mismatch' };
  }
  return { trusted: true };
}

/**
 * Log, once per reason and peer, that identity headers were ignored.
 *
 * @param {import('express').Request} req
 * @param {string} reason - From `checkProxyTrust`
 */
export function reportIgnoredProxyHeaders(req, reason) {
  const peer = req.socket?.remoteAddress || 'unknown';
  const messages = {
    'not-configured':
      'Proxy identity headers ignored: set proxyAuth.trustedProxies or a shared secret to accept them',
    'untrusted-address':
      'Proxy identity headers ignored: the connection is not from a trusted proxy',
    'secret-mismatch':
      'Proxy identity headers ignored: the shared secret header is missing or wrong',
    'secret-unavailable':
      'Proxy identity headers ignored: the shared secret credential is missing or empty',
    'invalid-secret-header':
      'Proxy identity headers ignored: proxyAuth.sharedSecretHeader cannot be used'
  };
  warnOnce(`${reason}:${peer}`, messages[reason] || 'Proxy identity headers ignored', {
    reason,
    peer
  });
}

/** Test helper: forget compiled lists and logged warnings. */
export function resetProxyTrustForTests() {
  compiled.clear();
  warned.clear();
}
