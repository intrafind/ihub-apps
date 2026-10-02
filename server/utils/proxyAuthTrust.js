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
 * never trusted. Signed JWTs from `proxyAuth.jwtProviders` are verified
 * separately and do not depend on this.
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
 * the credential `proxyAuth.sharedSecretRef` names.
 *
 * @param {object} proxyAuthConfig - `platform.proxyAuth`
 * @returns {string|null}
 */
export function getSharedSecret(proxyAuthConfig = {}) {
  if (config.PROXY_AUTH_SHARED_SECRET) return config.PROXY_AUTH_SHARED_SECRET;
  const secret = proxyAuthConfig.sharedSecretRef
    ? credentialService.tryResolveSecret(proxyAuthConfig.sharedSecretRef)
    : undefined;
  return typeof secret === 'string' && secret ? secret : null;
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
 * Compare two strings in constant time.
 *
 * @param {string} given
 * @param {string} expected
 * @returns {boolean}
 */
function secretsMatch(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Check whether `req` may use the proxy identity headers. Removes the shared
 * secret header from the request either way, so it does not travel further
 * (into logs or upstream calls).
 *
 * @param {import('express').Request} req
 * @param {object} proxyAuthConfig - `platform.proxyAuth`
 * @returns {{trusted: boolean, reason?: string}} `reason` says which check failed
 */
export function checkProxyTrust(req, proxyAuthConfig = {}) {
  const trustedProxies = getTrustedProxies(proxyAuthConfig);
  const sharedSecret = getSharedSecret(proxyAuthConfig);
  const secretHeader = (
    proxyAuthConfig.sharedSecretHeader || DEFAULT_SHARED_SECRET_HEADER
  ).toLowerCase();
  const givenSecret = req.headers?.[secretHeader];
  if (req.headers) delete req.headers[secretHeader];

  if (trustedProxies.length === 0 && !sharedSecret) {
    return { trusted: false, reason: 'not-configured' };
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
      'Proxy identity headers ignored: the shared secret header is missing or wrong'
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
