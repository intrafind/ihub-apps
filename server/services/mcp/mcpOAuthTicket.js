/**
 * The OAuth `state` of an outbound per-user MCP sign-in, as a signed ticket.
 *
 * The flow spans two requests — `GET /api/mcp/oauth/authorize` sends the
 * browser to the authorization server, `GET /api/mcp/oauth/callback` receives
 * the code — and in cluster mode they land on different workers. Instead of a
 * session, everything the callback needs travels in the `state` parameter,
 * protected by an HMAC exactly like the consent ticket of iHub's own
 * authorization server (`utils/consentTicket.js`):
 *
 *   - `serverId`, `userId`: which server, and which signed-in user started the
 *     flow. The callback requires the same user, so a ticket minted in one
 *     browser cannot complete a flow in another (login CSRF).
 *   - `codeVerifier`: the PKCE verifier, AES-256-GCM encrypted with the token
 *     store's key. It never leaves the server in clear text, and a callback
 *     with a forged ticket cannot present a verifier the signature covers.
 *   - `redirectUri`, `resource`: what the authorization request used, so the
 *     token exchange repeats them verbatim.
 *   - `returnUrl`: where to send the browser afterwards (validated before it
 *     is put in here).
 *   - `nonce`, `exp`: uniqueness and a 15-minute lifetime.
 *
 * A ticket is not single-use: replaying it re-presents a code the
 * authorization server already consumed, which fails at the token endpoint.
 *
 * @module services/mcp/mcpOAuthTicket
 */
import crypto from 'crypto';
import tokenStorageService from '../TokenStorageService.js';
import { resolveJwtSecret } from '../../utils/tokenService.js';
import logger from '../../utils/logger.js';

const COMPONENT = 'McpOAuthTicket';

/** Ticket lifetime — long enough to log in and consent at the IdP. */
export const MCP_OAUTH_TICKET_TTL_MS = 15 * 60 * 1000;

const TICKET_VERSION = 1;

/**
 * HMAC-SHA256 over the encoded payload with the platform's JWT secret.
 * Fails closed when no secret is configured.
 *
 * @param {string} encodedPayload
 * @returns {string} base64url signature
 */
function sign(encodedPayload) {
  const secret = resolveJwtSecret();
  if (!secret || typeof secret !== 'string') {
    throw new Error('Cannot sign MCP OAuth state: no JWT secret is configured');
  }
  return crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

/**
 * Issue the signed `state` for one sign-in.
 *
 * @param {Object} context
 * @param {string} context.serverId
 * @param {string} context.userId
 * @param {string} context.returnUrl - Already validated
 * @param {string} context.codeVerifier - PKCE verifier in clear text; encrypted here
 * @param {string} context.redirectUri
 * @param {string} [context.resource] - RFC 8707 resource indicator
 * @param {number} [context.now] - Test seam
 * @returns {string} `<payload>.<signature>`
 */
export function issueMcpOAuthTicket({
  serverId,
  userId,
  returnUrl,
  codeVerifier,
  redirectUri,
  resource,
  now = Date.now()
}) {
  for (const [name, value] of Object.entries({
    serverId,
    userId,
    returnUrl,
    codeVerifier,
    redirectUri
  })) {
    if (typeof value !== 'string' || !value) {
      throw new Error(`MCP OAuth ticket needs a ${name}`);
    }
  }
  const payload = {
    v: TICKET_VERSION,
    serverId,
    userId,
    returnUrl,
    cv: tokenStorageService.encryptString(codeVerifier),
    redirectUri,
    ...(resource ? { resource } : {}),
    nonce: crypto.randomBytes(16).toString('hex'),
    exp: now + MCP_OAUTH_TICKET_TTL_MS
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

/**
 * Verify a ticket and decrypt its verifier.
 *
 * @param {string} ticket
 * @param {Object} [options]
 * @param {number} [options.now] - Test seam
 * @returns {{ok: true, ticket: Object}|{ok: false, reason: 'invalid'|'expired'}}
 *   On success `ticket` carries `serverId`, `userId`, `returnUrl`,
 *   `codeVerifier` (clear text), `redirectUri`, `resource?`, `nonce`, `exp`.
 */
export function verifyMcpOAuthTicket(ticket, { now = Date.now() } = {}) {
  const invalid = { ok: false, reason: 'invalid' };
  if (!ticket || typeof ticket !== 'string' || ticket.length > 8192) return invalid;

  const separator = ticket.lastIndexOf('.');
  if (separator <= 0 || separator === ticket.length - 1) return invalid;
  const encodedPayload = ticket.slice(0, separator);
  const signature = ticket.slice(separator + 1);

  let expected;
  try {
    expected = sign(encodedPayload);
  } catch (error) {
    logger.error('Cannot verify MCP OAuth state', {
      component: COMPONENT,
      error: error?.message || String(error)
    });
    return invalid;
  }
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'))) {
      return invalid;
    }
  } catch {
    return invalid;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return invalid;
  }
  if (!payload || typeof payload !== 'object' || payload.v !== TICKET_VERSION) return invalid;
  for (const field of ['serverId', 'userId', 'returnUrl', 'cv', 'redirectUri', 'nonce']) {
    if (typeof payload[field] !== 'string' || !payload[field]) return invalid;
  }
  if (typeof payload.exp !== 'number') return invalid;
  if (now > payload.exp) return { ok: false, reason: 'expired' };

  let codeVerifier;
  try {
    codeVerifier = tokenStorageService.decryptString(payload.cv);
  } catch {
    return invalid;
  }
  const { cv: _cv, ...rest } = payload;
  return { ok: true, ticket: { ...rest, codeVerifier } };
}
