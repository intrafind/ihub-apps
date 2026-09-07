import crypto from 'crypto';
import { resolveJwtSecret } from './tokenService.js';
import logger from './logger.js';

/**
 * Signed, self-contained consent tickets for the OAuth consent screen.
 *
 * ## Why this is not a session
 *
 * The consent screen spans two requests: `GET /api/oauth/authorize` renders the
 * form, `POST /api/oauth/authorize/decision` acts on it. The parameters that
 * must survive that hop — above all the PKCE `code_challenge`, which binds the
 * authorization code to the client — used to live in an `express-session`
 * backed by a per-process `MemoryStore`.
 *
 * In cluster mode those two requests land on different workers (round-robin
 * routing, see `server/server.js`), and the second worker's store has no record
 * of the session. The CSRF token then reads as missing (HTTP 403 "CSRF token
 * missing") or, worse, the `code_challenge` reads as empty and a code gets
 * minted with no PKCE binding at all — which the token endpoint later rejects.
 * Both failures are intermittent, roughly 1 in N requests for N workers.
 *
 * A shared session store would fix the lookup; this removes the need for one.
 * The consent context is serialised into the form itself and protected by an
 * HMAC, so any worker can verify it with no shared state.
 *
 * ## What the signature buys
 *
 * The ticket carries every parameter the decision handler needs, so those
 * values no longer have to be trusted from the POST body — a client cannot
 * swap the `redirect_uri`, widen `scope`, or drop `code_challenge` between the
 * screen and the decision, because doing so invalidates the HMAC.
 *
 * It also replaces the CSRF token. The ticket is bound to the `userId` it was
 * issued for and the decision handler checks that against the caller's session
 * cookie, so a ticket minted for an attacker cannot drive a victim's consent —
 * and a ticket cannot be minted at all without the signing key.
 *
 * A ticket is replayable until it expires. That is deliberate: replaying it
 * re-issues a code for the same user who already consented to the same client
 * and scopes, which is exactly what revisiting `/authorize` with remembered
 * consent does anyway. Single-use protection lives where it matters, on the
 * authorization code (`authorizationCodeStore.js`).
 *
 * @module consentTicket
 */

/**
 * Ticket lifetime. Matches the 15 minutes the OAuth session cookie used to
 * allow — long enough for a user to read the screen, short enough that a
 * leaked ticket is stale before it is useful.
 */
const TICKET_TTL_MS = 15 * 60 * 1000;

/**
 * HMAC the payload with the platform's JWT secret.
 *
 * Fails closed: with no secret configured an empty key would still produce a
 * valid-looking signature that anyone could reproduce, making tickets forgeable.
 * Refusing to sign turns that misconfiguration into a loud server error instead.
 *
 * @param {string} encodedPayload - base64url payload.
 * @returns {string} base64url signature.
 * @throws {Error} If no JWT secret is available.
 */
function sign(encodedPayload) {
  const secret = resolveJwtSecret();
  if (!secret || typeof secret !== 'string') {
    throw new Error('Cannot sign consent ticket: no JWT secret is configured');
  }
  return crypto.createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

/**
 * Issue a signed consent ticket.
 *
 * @param {Object} context - Consent context to protect.
 * @param {string} context.clientId - OAuth client requesting access.
 * @param {string} context.redirectUri - Validated redirect URI.
 * @param {string} context.scope - Space-separated granted scopes.
 * @param {string} [context.state] - Client state to echo back.
 * @param {string} [context.codeChallenge] - PKCE challenge.
 * @param {string} [context.codeChallengeMethod] - PKCE method.
 * @param {string} [context.nonce] - OIDC nonce.
 * @param {string} context.userId - Subject the ticket is bound to.
 * @returns {string} Ticket of the form `<payload>.<signature>`.
 */
export function issueConsentTicket(context) {
  const payload = { ...context, exp: Date.now() + TICKET_TTL_MS };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

/**
 * Verify a consent ticket and return its context.
 *
 * @param {string} ticket - Ticket from the consent form.
 * @returns {Object|null} The context, or null if malformed, tampered with, or
 *   expired.
 */
export function verifyConsentTicket(ticket) {
  if (!ticket || typeof ticket !== 'string') return null;

  const separator = ticket.lastIndexOf('.');
  if (separator <= 0 || separator === ticket.length - 1) return null;

  const encodedPayload = ticket.slice(0, separator);
  const signature = ticket.slice(separator + 1);

  let expected;
  try {
    expected = sign(encodedPayload);
  } catch (error) {
    // A missing secret is a server misconfiguration, not a bad ticket. Log it
    // as such and reject rather than letting it surface as a 500.
    logger.error('Cannot verify consent ticket', {
      component: 'ConsentTicket',
      error: error?.message || String(error)
    });
    return null;
  }

  // timingSafeEqual throws on a length mismatch, which is itself a rejection.
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expected, 'utf8'))) {
      return null;
    }
  } catch {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    logger.warn('Consent ticket carried an unparsable payload', { component: 'ConsentTicket' });
    return null;
  }

  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
  if (!payload.clientId || !payload.redirectUri || !payload.userId) return null;

  return payload;
}
