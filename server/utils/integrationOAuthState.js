/**
 * The OAuth `state` of an integration sign-in (Office 365, Google Drive, Jira,
 * Nextcloud), as a signed ticket.
 *
 * The flow spans two requests — `GET /api/integrations/<service>/auth` sends
 * the browser to the identity provider, the callback receives the code — and
 * in cluster mode they land on different workers. A per-process session store
 * then has no record of the flow and the callback fails with `invalid_state`
 * roughly (N-1)/N of the time for N workers. Instead of a session, everything
 * the callback needs travels in the `state` parameter, protected by an HMAC
 * like the MCP sign-in ticket (`services/mcp/mcpOAuthTicket.js`):
 *
 *   - `service`, `providerId`: which integration and provider started the flow;
 *     a ticket for one cannot complete another.
 *   - `userId`: the signed-in user who started it. The callback requires the
 *     same user, so a ticket minted in one browser cannot complete a flow in
 *     another (login CSRF).
 *   - `codeVerifier`: the PKCE verifier, AES-256-GCM encrypted with the token
 *     store's key — it never leaves the server in clear text.
 *   - `returnUrl`: where to send the browser afterwards (validated before it is
 *     put in here).
 *   - `nonce`, `exp`: uniqueness and a 15-minute lifetime.
 *
 * @module utils/integrationOAuthState
 */
import crypto from 'crypto';
import tokenStorageService from '../services/TokenStorageService.js';
import { resolveJwtSecret } from './tokenService.js';
import logger from './logger.js';

export const INTEGRATION_OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

/** Where the browser lands when the state cannot be trusted. */
export const DEFAULT_INTEGRATION_RETURN_URL = '/settings/integrations';

const STATE_VERSION = 1;

function sign(encodedPayload) {
  const secret = resolveJwtSecret();
  if (!secret || typeof secret !== 'string') {
    throw new Error('Cannot sign integration OAuth state: no JWT secret is configured');
  }
  return crypto
    .createHmac('sha256', secret)
    .update(`integration-oauth:${encodedPayload}`)
    .digest('base64url');
}

/**
 * Issue the signed `state` for one sign-in.
 *
 * @param {Object} context
 * @param {string} context.service - e.g. 'office365'
 * @param {string} [context.providerId] - Provider id for multi-provider services
 * @param {string} context.userId
 * @param {string} context.returnUrl - Already validated
 * @param {string} [context.codeVerifier] - PKCE verifier in clear text; encrypted here
 * @param {number} [context.now] - Test seam
 * @returns {string} `<payload>.<signature>`
 */
export function issueIntegrationOAuthState({
  service,
  providerId = '',
  userId,
  returnUrl,
  codeVerifier,
  now = Date.now()
}) {
  for (const [name, value] of Object.entries({ service, userId, returnUrl })) {
    if (typeof value !== 'string' || !value) {
      throw new Error(`Integration OAuth state needs a ${name}`);
    }
  }
  const payload = {
    v: STATE_VERSION,
    service,
    providerId: String(providerId),
    userId: String(userId),
    returnUrl,
    ...(codeVerifier ? { cv: tokenStorageService.encryptString(codeVerifier) } : {}),
    nonce: crypto.randomBytes(16).toString('hex'),
    exp: now + INTEGRATION_OAUTH_STATE_TTL_MS
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

/**
 * Verify the `state` a callback received and bind it to the current request.
 *
 * `returnUrl` is always set: the ticket's own when its signature holds (even if
 * it then fails another check), the default otherwise — so every outcome can
 * redirect the user back to a safe page.
 *
 * @param {import('express').Request} req - Callback request (`req.query.state`, `req.user`)
 * @param {Object} expected
 * @param {string} expected.service
 * @param {string} [expected.providerId]
 * @param {number} [expected.now] - Test seam
 * @returns {{ok: true, returnUrl: string, userId: string, providerId: string, codeVerifier?: string}
 *   | {ok: false, returnUrl: string, error: 'invalid_state'|'session_expired'}}
 */
export function verifyIntegrationOAuthState(req, { service, providerId = '', now = Date.now() }) {
  const invalid = { ok: false, returnUrl: DEFAULT_INTEGRATION_RETURN_URL, error: 'invalid_state' };
  const state = req.query?.state;
  if (!state || typeof state !== 'string' || state.length > 4096) return invalid;

  const separator = state.lastIndexOf('.');
  if (separator <= 0 || separator === state.length - 1) return invalid;
  const encodedPayload = state.slice(0, separator);
  const signature = state.slice(separator + 1);

  let expected;
  try {
    expected = sign(encodedPayload);
  } catch (error) {
    logger.error('Cannot verify integration OAuth state', {
      component: 'IntegrationOAuthState',
      error: error?.message || String(error)
    });
    return invalid;
  }
  const given = Buffer.from(signature, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return invalid;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return invalid;
  }
  if (!payload || payload.v !== STATE_VERSION || typeof payload.returnUrl !== 'string') {
    return invalid;
  }

  // From here on the ticket is authentic, so its return URL is safe to use.
  const fail = error => ({ ok: false, returnUrl: payload.returnUrl, error });
  if (payload.service !== service || payload.providerId !== String(providerId)) {
    return fail('invalid_state');
  }
  if (typeof payload.exp !== 'number' || now > payload.exp) return fail('session_expired');
  // Bound to the user who started the flow; the auth cookie is SameSite=lax,
  // so it arrives on the IdP's top-level redirect back to us.
  if (!req.user?.id || String(req.user.id) !== payload.userId) {
    logger.warn('Integration OAuth callback for a different or no user refused', {
      component: 'IntegrationOAuthState',
      service,
      providerId: payload.providerId
    });
    return fail('invalid_state');
  }

  let codeVerifier;
  if (payload.cv) {
    try {
      codeVerifier = tokenStorageService.decryptString(payload.cv);
    } catch {
      return fail('invalid_state');
    }
  }
  return {
    ok: true,
    returnUrl: payload.returnUrl,
    userId: payload.userId,
    providerId: payload.providerId,
    codeVerifier
  };
}

/** Append `key=value` to a (relative or absolute) return URL. */
export function withQueryParam(url, key, value) {
  return `${url}${url.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;
}
