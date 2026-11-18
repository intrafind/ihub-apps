// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import expressNtlm from 'express-ntlm';
import configCache from '../configCache.js';
import { enhanceUserGroups, mapExternalGroups } from '../utils/authorization.js';
import { generateJwt } from '../utils/tokenService.js';
import { validateAndPersistExternalUser } from '../utils/userManager.js';
import { getLdapProviderByName, lookupLdapGroupsForUser } from './ldapAuth.js';
import logger from '../utils/logger.js';
import authDebugService from '../utils/authDebugService.js';
import { getAuthCookieOptions, getClearAuthCookieOptions } from '../utils/cookieSettings.js';
import { buildServerPath } from '../utils/basePath.js';
import { ServiceError } from '../utils/ServiceError.js';
import {
  parseNtlmType3Identity,
  recordNtlmRejection,
  ntlmCooldownRemaining
} from '../utils/ntlmRejectionCooldown.js';

/**
 * NTLM/Windows Authentication middleware and utilities
 */

// Cache for the express-ntlm middleware instance
let ntlmMiddlewareInstance = null;
let ntlmMiddlewareConfig = null;

/** One express-ntlm debug argument as log text. */
function formatNtlmDebugArg(arg) {
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === 'object') {
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

/**
 * The `debug` function handed to express-ntlm. express-ntlm calls it for every
 * internal step (negotiate, bind, parse). When NTLM debug is on, each line goes
 * to our logger so admins can see exactly where the handshake is failing —
 * particularly important for diagnosing 403 responses from the AD SASL bind step.
 * @param {boolean} enabled - Whether NTLM debug logging is on.
 * @returns {Function}
 */
function createNtlmDebugFn(enabled) {
  if (!enabled) return () => {};
  return (...args) => {
    // First arg is the prefix ("[express-ntlm]"); strip it so we don't double-tag.
    const [, ...rest] = args;
    const msg = rest.map(formatNtlmDebugArg).join(' ');
    logger.info('[express-ntlm] ' + msg, { component: 'NtlmAuth' });
  };
}

const SUMMARISED_TLS_KEYS = new Set([
  'rejectUnauthorized',
  'ca',
  'cert',
  'key',
  'pfx',
  'servername',
  'minVersion',
  'maxVersion'
]);

/**
 * Summarise tlsOptions so the log makes the *effective* TLS behaviour visible.
 * Logging only the keys hides whether `rejectUnauthorized` is true or false —
 * exactly the diagnostic we need for self-signed AD certs. Sensitive material
 * (ca/cert/key/pfx) is reported as a presence flag only.
 * @param {Object|undefined} tls - The configured tlsOptions.
 * @returns {Object|string}
 */
function summarizeTlsOptions(tls) {
  if (!tls) return 'none';
  return {
    rejectUnauthorized:
      typeof tls.rejectUnauthorized === 'boolean' ? tls.rejectUnauthorized : 'default(true)',
    hasCa: !!tls.ca,
    hasCert: !!tls.cert,
    hasKey: !!tls.key,
    hasPfx: !!tls.pfx,
    ...(tls.servername && { servername: tls.servername }),
    ...(tls.minVersion && { minVersion: tls.minVersion }),
    ...(tls.maxVersion && { maxVersion: tls.maxVersion }),
    otherKeys: Object.keys(tls).filter(k => !SUMMARISED_TLS_KEYS.has(k))
  };
}

/**
 * Create NTLM middleware with configuration
 * @param {Object} ntlmConfig - NTLM configuration
 * @returns {Function} Express middleware
 */
export function createNtlmMiddleware(ntlmConfig = {}) {
  // NTLM tracing is driven either by the provider-local `ntlmAuth.debug` flag or
  // by the central authentication-debug toggle (auth.debug), so admins can turn
  // it on from the single Logging page without a second, NTLM-only switch.
  const ntlmDebug = ntlmConfig.debug === true || authDebugService.isDebugEnabled('ntlm');

  // express-ntlm only checks the sign-in: it relays the NTLM messages to
  // `domaincontroller` and returns the user, domain and workstation. It never
  // reads user details or groups; those come from `ldapGroupLookupProvider`.
  const options = {
    domain: ntlmConfig.domain,
    domaincontroller: ntlmConfig.domainController,
    // TLS options for ldaps:// connections with self-signed/internal CA certs
    ...(ntlmConfig.tlsOptions && { tlsOptions: ntlmConfig.tlsOptions }),
    // Pipe express-ntlm's internal debug output through our logger
    debug: createNtlmDebugFn(ntlmDebug),
    // The failure handlers do not answer themselves: they log what happened and
    // leave a ServiceError on `request.ntlmFailure` for the login route, which
    // turns it into a redirect (browser) or a problem response (API). The 403 path is
    // the most useful: it means the AD SASL bind with the user's NTLM Type 3
    // token returned a non-success LDAP result code (commonly: channel binding
    // enforced, NTLM restricted at the DC, or invalid credentials).
    forbidden: (request, response, next) => {
      const auth = request.headers.authorization || '';
      logger.warn('NTLM Auth: 403 Forbidden from express-ntlm', {
        component: 'NtlmAuth',
        url: request.originalUrl,
        ntlm: request.ntlm || null,
        authHeaderType: auth.split(' ')[0] || 'none',
        authHeaderLength: auth.length,
        hint: 'AD rejected the SASL bind carrying the NTLM Type 3 token. Likely causes: channel binding enforced (LdapEnforceChannelBinding=2), NTLM restricted at DC, or the browser sent invalid/empty credentials.'
      });
      // Hold this account's next answers back for a while (see ntlmRejectionCooldown.js).
      recordNtlmRejection(request.ntlm?.DomainName, request.ntlm?.UserName);
      request.ntlmFailure = new ServiceError(
        'FORBIDDEN',
        'Windows sign-in was rejected by the domain controller.'
      );
      next();
    },
    internalservererror: (request, response, next) => {
      logger.error('NTLM Auth: 500 from express-ntlm', {
        component: 'NtlmAuth',
        url: request.originalUrl,
        ntlm: request.ntlm || null,
        hint: 'Usually means the connection cache lost the proxy between Type 1 and Type 3 (HTTP keep-alive broken by an intermediary), or the AD socket errored.'
      });
      request.ntlmFailure = new ServiceError(
        'SERVICE_UNAVAILABLE',
        'Windows sign-in could not reach the domain controller. Try again shortly.'
      );
      next();
    },
    badrequest: (request, response, next) => {
      logger.warn('NTLM Auth: 400 Bad Request from express-ntlm', {
        component: 'NtlmAuth',
        url: request.originalUrl,
        authHeader: request.headers.authorization ? 'present' : 'missing'
      });
      request.ntlmFailure = new ServiceError(
        'BAD_REQUEST',
        'The browser sent a Windows sign-in this server cannot read (only NTLM is supported).'
      );
      next();
    },
    unauthorized: (request, response /* , next */) => {
      // Always challenge with NTLM, never Negotiate. express-ntlm only parses
      // `Authorization: NTLM …` and answers anything else with 400, and it
      // cannot verify a Kerberos ticket: it relays the NTLM messages to the
      // domain controller's LDAP port. Advertising Negotiate makes a browser
      // send Kerberos (or SPNEGO-wrapped NTLM), which then fails on every
      // request. Logged at debug to avoid noise — this fires on every initial
      // request before the handshake completes.
      logger.debug('NTLM Auth: sending 401 challenge', {
        component: 'NtlmAuth',
        url: request.originalUrl,
        hadAuthHeader: !!request.headers.authorization
      });
      response.statusCode = 401;
      response.setHeader('WWW-Authenticate', 'NTLM');
      response.end();
    },
    ...ntlmConfig.options
  };

  logger.info('NTLM Auth: configuring NTLM middleware', {
    component: 'NtlmAuth',
    domain: options.domain || 'default',
    domainController: options.domaincontroller || 'NOT CONFIGURED',
    ldapGroupLookupProvider: ntlmConfig.ldapGroupLookupProvider || 'none',
    debugMode: ntlmDebug,
    tlsOptions: summarizeTlsOptions(ntlmConfig.tlsOptions)
  });

  if (!options.domaincontroller) {
    logger.warn(
      'NTLM Auth: no domain controller configured — every NTLM sign-in is accepted without checking the password',
      { component: 'NtlmAuth' }
    );
  }
  if (!ntlmConfig.ldapGroupLookupProvider) {
    logger.info(
      'NTLM Auth: no ldapGroupLookupProvider set — NTLM users get only ntlmAuth.defaultGroups',
      { component: 'NtlmAuth' }
    );
  }

  return expressNtlm(options);
}

/**
 * Get or create the NTLM middleware instance
 * @param {Object} ntlmConfig - NTLM configuration
 * @returns {Function} Express middleware instance
 */
function getNtlmMiddleware(ntlmConfig) {
  // Check if config changed, if so, recreate middleware. The central auth-debug
  // toggle also feeds NTLM tracing, so fold it into the hash — otherwise
  // flipping auth.debug wouldn't take effect until the NTLM config itself
  // changed or the server restarted.
  const configHash = JSON.stringify({
    ...ntlmConfig,
    __authDebug: authDebugService.isDebugEnabled('ntlm')
  });
  if (!ntlmMiddlewareInstance || ntlmMiddlewareConfig !== configHash) {
    ntlmMiddlewareInstance = createNtlmMiddleware(ntlmConfig);
    ntlmMiddlewareConfig = configHash;
  }
  return ntlmMiddlewareInstance;
}

/**
 * Process NTLM authentication result
 * @param {Object} req - Express request object
 * @param {Object} ntlmConfig - NTLM configuration
 * @returns {Object|null} Processed user object or null
 */
export function processNtlmUser(req, ntlmConfig) {
  if (!req.ntlm) {
    logger.debug('NTLM Auth: no NTLM data in request', { component: 'NtlmAuth' });
    return null;
  }

  const ntlmUser = req.ntlm;

  logger.debug('NTLM Auth: raw NTLM data', {
    component: 'NtlmAuth',
    ntlmUser: JSON.stringify(ntlmUser, null, 2)
  });

  // Check if user is authenticated
  if (!ntlmUser.Authenticated) {
    logger.warn('NTLM Auth: user not authenticated', {
      component: 'NtlmAuth',
      username: ntlmUser.UserName || ntlmUser.username || 'unknown'
    });
    return null;
  }

  logger.info('NTLM Auth: processing authenticated user', {
    component: 'NtlmAuth',
    username: ntlmUser.UserName || ntlmUser.username
  });

  // Extract user information.
  // express-ntlm exposes the authenticated identity as `UserName` and the
  // domain as `DomainName` (capitalized). `.domain` / `.Domain` are checked
  // first only to stay compatible with custom middleware that may set
  // them. Without the `DomainName` fallback `user.domain` was always
  // undefined, which made the standard `domain\\username` JWT subject
  // template fall back to bare username.
  const userId = ntlmUser.username || ntlmUser.UserName;
  const domain = ntlmUser.domain || ntlmUser.Domain || ntlmUser.DomainName;

  // Extract groups - check all possible field names
  let groups = [];
  if (ntlmUser.groups && Array.isArray(ntlmUser.groups)) {
    groups = ntlmUser.groups;
    logger.debug('NTLM Auth: found groups in ntlmUser.groups', { component: 'NtlmAuth', groups });
  } else if (ntlmUser.Groups && Array.isArray(ntlmUser.Groups)) {
    groups = ntlmUser.Groups;
    logger.debug('NTLM Auth: found groups in ntlmUser.Groups', { component: 'NtlmAuth', groups });
  } else {
    // The usual case: express-ntlm returns no groups. They are added from
    // `ldapGroupLookupProvider`, when one is set, after this.
    logger.debug('NTLM Auth: no groups in NTLM data', {
      component: 'NtlmAuth',
      availableFields: Object.keys(ntlmUser)
    });
  }

  logger.debug('NTLM Auth: extracted groups before mapping', { component: 'NtlmAuth', groups });

  // Apply group mapping using centralized function
  const mappedGroups = mapExternalGroups(groups);

  logger.debug('NTLM Auth: groups after mapping', { component: 'NtlmAuth', mappedGroups });

  // Add default groups if configured
  if (ntlmConfig.defaultGroups && Array.isArray(ntlmConfig.defaultGroups)) {
    logger.debug('NTLM Auth: adding default groups', {
      component: 'NtlmAuth',
      defaultGroups: ntlmConfig.defaultGroups
    });
    ntlmConfig.defaultGroups.forEach(g => {
      if (!mappedGroups.includes(g)) {
        mappedGroups.push(g);
      }
    });
  }

  logger.debug('NTLM Auth: final groups for user', { component: 'NtlmAuth', mappedGroups });

  // Create normalized user object.
  // `id` is the bare userId (not `domain\\userId`). Before the `DomainName`
  // fix above, `domain` was always undefined and `id` therefore always equal
  // to `userId`, so existing users.json entries were keyed by username
  // alone. Keeping `id` as `userId` preserves that lookup key — switching
  // to `domain\\userId` here would orphan every existing NTLM user record.
  // The domain is exposed separately on `user.domain` for use by the
  // `domain\\username` standard subject value and `${user.domain}`
  // placeholder.
  const user = {
    id: userId,
    username: userId,
    name: ntlmUser.DisplayName || ntlmUser.displayName || userId,
    email: ntlmUser.email || ntlmUser.Email || null,
    groups: mappedGroups,
    externalGroups: groups, // Store original external groups for debugging
    authenticated: true,
    authMethod: 'ntlm',
    provider: ntlmConfig.name || 'ntlm',
    domain: domain,
    workstation: ntlmUser.workstation || ntlmUser.Workstation,
    raw: ntlmUser // Keep raw NTLM data for debugging
  };

  logger.debug('NTLM Auth: created user object', {
    component: 'NtlmAuth',
    id: user.id,
    name: user.name,
    groups: user.groups,
    externalGroups: user.externalGroups
  });

  return user;
}

/**
 * Perform LDAP group lookup for an NTLM-authenticated user and merge groups.
 * Only called during login/session start, not on every request.
 * @param {Object} user - Processed NTLM user object
 * @param {Object} ntlmConfig - NTLM configuration
 * @returns {Promise<Object>} User with merged LDAP groups
 */
async function enhanceUserWithLdapGroups(user, ntlmConfig) {
  if (!ntlmConfig.ldapGroupLookupProvider) {
    return user;
  }

  try {
    const ldapProvider = getLdapProviderByName(ntlmConfig.ldapGroupLookupProvider);

    if (!ldapProvider) {
      logger.error('NTLM Auth: ldapGroupLookupProvider references non-existent LDAP provider', {
        component: 'NtlmAuth',
        ldapGroupLookupProvider: ntlmConfig.ldapGroupLookupProvider
      });
      return user;
    }

    if (!ldapProvider.adminDn || !ldapProvider.adminPasswordRef) {
      logger.error(
        'NTLM Auth: LDAP provider for group lookup is missing adminDn or adminPasswordRef',
        {
          component: 'NtlmAuth',
          ldapProvider: ntlmConfig.ldapGroupLookupProvider
        }
      );
      return user;
    }

    logger.info('NTLM Auth: performing LDAP group lookup for user', {
      component: 'NtlmAuth',
      username: user.username,
      ldapProvider: ntlmConfig.ldapGroupLookupProvider
    });

    const ldapGroups = await lookupLdapGroupsForUser(user.username, ldapProvider);

    if (ldapGroups.length > 0) {
      // Merge LDAP groups with any existing external groups (deduplicate)
      const mergedExternalGroups = [...new Set([...user.externalGroups, ...ldapGroups])];
      user.externalGroups = mergedExternalGroups;

      // Re-map all external groups to internal groups
      const mappedGroups = mapExternalGroups(mergedExternalGroups);

      // Re-add default groups
      if (ntlmConfig.defaultGroups && Array.isArray(ntlmConfig.defaultGroups)) {
        ntlmConfig.defaultGroups.forEach(g => {
          if (!mappedGroups.includes(g)) {
            mappedGroups.push(g);
          }
        });
      }

      user.groups = mappedGroups;

      logger.info('NTLM Auth: merged LDAP groups into user', {
        component: 'NtlmAuth',
        username: user.username,
        ldapGroupCount: ldapGroups.length,
        totalExternalGroups: mergedExternalGroups.length,
        mappedGroups: mappedGroups.join(', ')
      });
    } else {
      logger.info('NTLM Auth: LDAP group lookup returned no groups', {
        component: 'NtlmAuth',
        username: user.username
      });
    }
  } catch (error) {
    logger.error('NTLM Auth: LDAP group lookup failed, continuing with NTLM groups only', {
      component: 'NtlmAuth',
      username: user.username,
      ldapGroupLookupProvider: ntlmConfig.ldapGroupLookupProvider,
      error
    });
  }

  return user;
}

/**
 * Cookie that records "this browser signed in with Windows". While it is set,
 * /api/auth/status tells the client to send a signed-out browser straight to
 * the NTLM login endpoint (for example when the session cookie expired),
 * until logout clears it. A cookie rather than a server-side session, so every
 * cluster worker sees the same answer. Not a credential.
 */
export const NTLM_REQUESTED_COOKIE = 'ntlmRequested';
const NTLM_REQUESTED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Remember that this browser explicitly chose NTLM. */
export function markNtlmRequested(res, req) {
  res.cookie(
    NTLM_REQUESTED_COOKIE,
    '1',
    getAuthCookieOptions(NTLM_REQUESTED_MAX_AGE_MS, req, { path: '/' })
  );
}

/** Forget the NTLM choice, so the next visit does not sign in automatically. */
export function clearNtlmRequested(res, req) {
  res.clearCookie(NTLM_REQUESTED_COOKIE, getClearAuthCookieOptions(req, { path: '/' }));
}

/**
 * Whether a request is a Windows sign-in: the only requests that run the NTLM
 * handshake. Every other request is signed in by the session cookie (or not at
 * all), exactly as with local, LDAP and OIDC sign-in: a handshake per request
 * would make every API call a logon at the domain controller, and a wrong
 * password would lock the account within one page load.
 *
 * @param {string} path - The request path (`req.path`), including any base path
 * @returns {boolean}
 */
export function isNtlmLoginPath(path) {
  return path === buildServerPath('/api/auth/ntlm/login');
}

/** How long one NTLM step may wait for the domain controller. */
const NTLM_HANDSHAKE_TIMEOUT_MS = 5000;

const NTLM_RESPONSE_WRITES = new Set([
  'setHeader',
  'writeHead',
  'write',
  'end',
  'send',
  'sendStatus',
  'status',
  'json'
]);
const NTLM_RESPONSE_FINISHERS = new Set(['end', 'send', 'sendStatus', 'json']);

/**
 * The response object handed to express-ntlm. It forwards to `res`, reports
 * when express-ntlm finishes the response, and ignores every write once
 * `isTimedOut()` is true.
 *
 * @param {Object} res - Express response
 * @param {{isTimedOut: () => boolean, onSend: () => void}} hooks
 * @returns {Object}
 */
export function createNtlmResponse(res, { isTimedOut, onSend }) {
  const facade = new Proxy(res, {
    get(target, prop) {
      if (NTLM_RESPONSE_WRITES.has(prop)) {
        if (isTimedOut()) return () => facade;
        const method = target[prop];
        if (NTLM_RESPONSE_FINISHERS.has(prop)) {
          return (...args) => {
            onSend();
            return method.apply(target, args);
          };
        }
        return (...args) => {
          const result = method.apply(target, args);
          return result === target ? facade : result;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(target, prop, value) {
      if (!isTimedOut()) target[prop] = value;
      return true;
    }
  });
  return facade;
}

/**
 * NTLM authentication middleware. Runs the NTLM handshake on the Windows
 * sign-in endpoint only (see isNtlmLoginPath) and leaves the result on the
 * request for the route: `req.ntlm` when the domain controller answered, and
 * `req.ntlmFailure` (a ServiceError) when the sign-in cannot go on. The route
 * issues the session cookie; every later request is signed in by it.
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
export function ntlmAuthMiddleware(req, res, next) {
  const platform = configCache.getPlatform() || {};
  const ntlmAuth = platform.ntlmAuth || {};

  if (!ntlmAuth.enabled || !isNtlmLoginPath(req.path)) {
    return next();
  }

  // The domain controller just rejected this account: refuse its next answers
  // here instead of relaying them, so they do not count as failed logons.
  const identity = parseNtlmType3Identity(req.headers.authorization);
  if (identity) {
    // A browser on a machine outside the domain often sends no domain at all.
    // express-ntlm then reports the configured domain, and that is the name the
    // rejection was recorded under, so look it up the same way.
    const domain = identity.domain || ntlmAuth.domain;
    const remainingMs = ntlmCooldownRemaining(domain, identity.user);
    if (remainingMs > 0) {
      const retryAfterSeconds = Math.ceil(remainingMs / 1000);
      logger.warn('NTLM Auth: sign-in held back after a recent rejection', {
        component: 'NtlmAuth',
        domain,
        user: identity.user,
        retryAfterSeconds
      });
      res.setHeader('Retry-After', String(retryAfterSeconds));
      req.ntlmFailure = new ServiceError(
        'RATE_LIMITED',
        'Windows sign-in was rejected. Check your password and try again shortly.',
        { details: { retryAfterMs: remainingMs } }
      );
      return next();
    }
  }

  const ntlmMiddleware = getNtlmMiddleware(ntlmAuth);
  const isDev = process.env.NODE_ENV === 'development';

  // express-ntlm answers through `ntlmRes`, never through `res` directly, so
  // its writes can be seen (responseSent) and, once this request has timed
  // out, dropped: a challenge that arrives late would otherwise set headers on
  // a response that is already finished and throw inside a socket callback.
  let responseSent = false;
  let timedOut = false;
  const ntlmRes = createNtlmResponse(res, {
    isTimedOut: () => timedOut,
    onSend: () => {
      responseSent = true;
      if (isDev) {
        logger.debug('NTLM Debug: response sent by express-ntlm', {
          component: 'NtlmAuth',
          status: res.statusCode,
          headers: res.getHeaders()
        });
      }
    }
  });

  // The domain controller did not answer: the route reports it as 503.
  const timeout = setTimeout(() => {
    if (responseSent) return;
    timedOut = true;
    // express-ntlm keys its per-connection handshake cache by connection.id and
    // still stores this handshake if the domain controller answers late. Give
    // the connection a fresh key, so that late entry cannot replace the one of
    // a newer handshake on the same connection.
    if (req.connection) delete req.connection.id;
    logger.error('NTLM Auth: domain controller did not answer within 5 seconds', {
      component: 'NtlmAuth',
      url: req.originalUrl
    });
    if (res.headersSent) return;
    res.setHeader('Retry-After', '5');
    req.ntlmFailure = new ServiceError(
      'SERVICE_UNAVAILABLE',
      'The domain controller did not answer the Windows sign-in in time. Try again shortly.'
    );
    next();
  }, NTLM_HANDSHAKE_TIMEOUT_MS);

  try {
    ntlmMiddleware(req, ntlmRes, err => {
      clearTimeout(timeout);
      if (timedOut || responseSent) return;
      if (err) {
        logger.error('NTLM Auth: error in express-ntlm middleware', {
          component: 'NtlmAuth',
          error: err,
          url: req.originalUrl
        });
      }
      next();
    });
  } catch (error) {
    clearTimeout(timeout);
    logger.error('NTLM Auth: unexpected error in NTLM middleware', {
      component: 'NtlmAuth',
      error
    });
    next();
  }
}

/**
 * Get NTLM configuration
 * @returns {Object|null} NTLM configuration
 */
export function getNtlmConfig() {
  const platform = configCache.getPlatform() || {};
  return platform.ntlmAuth || null;
}

/**
 * Login function for NTLM authentication (for API endpoints)
 * @param {Object} req - Express request object with NTLM data
 * @param {Object} ntlmConfig - NTLM configuration
 * @returns {Promise<Object>} Login result with user and token
 */
export async function processNtlmLogin(req, ntlmConfig) {
  if (!req.ntlm || !req.ntlm.Authenticated) {
    throw new Error('NTLM authentication required');
  }

  // Process NTLM user data
  let user = processNtlmUser(req, ntlmConfig);

  if (!user) {
    throw new Error('Failed to process NTLM user data');
  }

  // Enhance user with authenticated group
  const platform = configCache.getPlatform() || {};
  const authConfig = platform.auth || {};

  user = enhanceUserGroups(user, authConfig, ntlmConfig);

  // LDAP group lookup (only during login/session start)
  if (ntlmConfig.ldapGroupLookupProvider) {
    user = await enhanceUserWithLdapGroups(user, ntlmConfig);
    // Re-apply: enhanceUserWithLdapGroups replaces user.groups with freshly
    // mapped groups, so we need to re-add authenticated/provider default groups.
    user = enhanceUserGroups(user, authConfig, ntlmConfig);
  }

  // Validate and persist NTLM user (similar to OIDC/Proxy). The user must be
  // persisted - if this fails, the login fails. The token below is validated on
  // every request against the persisted record (see jwtAuth.js), so one issued
  // for a user that was never persisted could not be used, and continuing here
  // would also let a disabled user or a self-signup the admin turned off through.
  user = await validateAndPersistExternalUser(user, platform);
  logger.info('NTLM Auth: user persisted via login', { component: 'NtlmAuth', userId: user.id });

  // Generate JWT token using centralized token service
  const sessionTimeout =
    ntlmConfig.sessionTimeoutMinutes || platform.localAuth?.sessionTimeoutMinutes || 480;
  const { token, expiresIn } = generateJwt(user, {
    authMode: 'ntlm',
    authProvider: user.provider,
    expiresInMinutes: sessionTimeout,
    additionalClaims: {
      domain: user.domain
    }
  });

  return {
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      groups: user.groups,
      authenticated: user.authenticated,
      authMethod: user.authMethod,
      provider: user.provider,
      domain: user.domain
    },
    // Where the groups came from, for the login audit entry; kept off `user`,
    // which goes back to the browser.
    loginGroups: user.loginGroups,
    token,
    expiresIn
  };
}

export default ntlmAuthMiddleware;
