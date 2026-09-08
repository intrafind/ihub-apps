import { buildServerPath } from './basePath.js';
import { getAuthCookieOptions, getClearAuthCookieOptions } from './cookieSettings.js';
import logger from './logger.js';

/**
 * The `oidcLogoutHint` cookie: everything that reads, writes or clears it.
 *
 * OIDC RP-Initiated Logout (https://openid.net/specs/openid-connect-rpinitiated-1_0.html)
 * needs two things at logout time that iHub's own JWT does not carry: which
 * provider authenticated this browser, and (ideally) that provider's ID token
 * to pass as `id_token_hint`. Both are stashed here at login by
 * createOidcCallbackHandler and consumed by GET /api/auth/oidc-logout.
 *
 * Centralised in one module because a cookie is only clearable with the exact
 * `path` + `sameSite` it was set with, and this one is set in
 * middleware/oidcAuth.js but cleared in routes/auth.js — two files that would
 * otherwise drift apart and leave an ID token sitting in the browser.
 */
export const OIDC_LOGOUT_HINT_COOKIE = 'oidcLogoutHint';

/**
 * Cookies larger than ~4096 bytes (name + value + attributes) are silently
 * dropped by browsers, and proxies commonly cap the whole request header block
 * at 4-8 KB (nginx's default `large_client_header_buffers` is `4 8k`). ID
 * tokens carrying a fat `groups` claim - Microsoft Entra ID in particular - get
 * close to that on their own, and this cookie rides alongside the authToken
 * JWT. Stay well under the limit and degrade deliberately (see
 * setOidcLogoutHint) rather than letting the browser drop the whole cookie and
 * silently turn every logout back into a local-only one.
 */
export const MAX_HINT_COOKIE_BYTES = 3072;

/**
 * Scope the cookie to the only two endpoints that read it
 * (POST /api/auth/logout and GET /api/auth/oidc-logout) so a bearer-grade ID
 * token is not attached to every asset, API and streaming request for the
 * whole session.
 *
 * Depends on the same base-path detection as the OIDC callback URL
 * (X-Forwarded-Prefix, see utils/basePath.js): a subpath deployment whose proxy
 * does not send that header, but which pins `callbackURL` by hand, will not send
 * this cookie back. That degrades to local-only logout, never to a broken login.
 */
function hintCookiePath() {
  return buildServerPath('/api/auth');
}

/**
 * SameSite=Strict, not Lax like the authToken cookie. The hint is only ever
 * read on a same-site navigation that iHub's own page initiates (AuthContext's
 * `logout()`), so Strict costs nothing - and it stops any third-party page
 * from navigating a logged-in user to /api/auth/oidc-logout to force a global
 * SSO logout at their IdP, or to burn the hint so that this session's real
 * logout silently degrades to local-only.
 *
 * Setting the cookie still works from the IdP's cross-site callback redirect:
 * SameSite governs when a cookie is *sent*, not when it may be stored.
 *
 * @param {number} maxAge - Maximum age in milliseconds
 * @param {Object} req - Express request
 */
export function getOidcLogoutHintCookieOptions(maxAge, req) {
  return getAuthCookieOptions(maxAge, req, { sameSite: 'strict', path: hintCookiePath() });
}

/**
 * @param {Object} req - Express request
 */
export function getClearOidcLogoutHintCookieOptions(req) {
  return getClearAuthCookieOptions(req, { sameSite: 'strict', path: hintCookiePath() });
}

/**
 * Drop the hint cookie. Safe (and cheap) to call when there is none.
 *
 * Call this on every successful non-OIDC login as well: without it, a hint
 * written by an earlier OIDC login outlives that session and keeps an ID token
 * in the browser for the rest of the JWT lifetime.
 *
 * @param {Object} res - Express response
 * @param {Object} req - Express request
 */
export function clearOidcLogoutHint(res, req) {
  res.clearCookie(OIDC_LOGOUT_HINT_COOKIE, getClearOidcLogoutHintCookieOptions(req));
}

/**
 * Write the hint for a freshly authenticated OIDC session, or clear any stale
 * one when this provider can't do RP-Initiated Logout.
 *
 * Always writes *something*: a user who logs in via provider A (which has a
 * logoutURL) and then via provider B (which doesn't) without an intervening
 * logout would otherwise still hold A's cookie, and their logout would be sent
 * to A's end_session_endpoint carrying A's long-dead ID token.
 *
 * When the ID token is too large to store (see MAX_HINT_COOKIE_BYTES), the
 * provider name is kept on its own: `id_token_hint` is only RECOMMENDED by the
 * spec, and a `client_id` + `post_logout_redirect_uri` logout still terminates
 * the provider session (some providers then show a confirmation page). A loud
 * warning beats a dropped cookie.
 *
 * @param {Object} res - Express response
 * @param {Object} req - Express request
 * @param {object} params
 * @param {string} params.provider - Configured provider name
 * @param {string} [params.idToken] - Raw ID token from the token response
 * @param {string} [params.logoutURL] - The provider's end_session_endpoint, if any
 * @param {number} params.maxAge - Cookie lifetime in milliseconds
 * @returns {boolean} True when a hint cookie was written
 */
export function setOidcLogoutHint(res, req, { provider, idToken, logoutURL, maxAge }) {
  if (!logoutURL) {
    clearOidcLogoutHint(res, req);
    return false;
  }

  let value = JSON.stringify({ provider, idToken });
  if (Buffer.byteLength(encodeURIComponent(value), 'utf8') > MAX_HINT_COOKIE_BYTES) {
    logger.warn(
      'OIDC ID token is too large to store as a logout hint; falling back to a ' +
        'client_id-only RP-Initiated Logout, which some providers answer with a ' +
        'logout confirmation page instead of logging out silently.',
      {
        component: 'OidcLogoutHint',
        providerName: provider,
        idTokenLength: idToken?.length || 0,
        limitBytes: MAX_HINT_COOKIE_BYTES
      }
    );
    value = JSON.stringify({ provider });
  }

  res.cookie(OIDC_LOGOUT_HINT_COOKIE, value, getOidcLogoutHintCookieOptions(maxAge, req));
  return true;
}

/**
 * Read and parse the hint cookie without throwing.
 *
 * @param {Object} req - Express request
 * @returns {{ present: boolean, parseError: boolean, hint: object|null }}
 */
export function readOidcLogoutHint(req) {
  const raw = req.cookies?.[OIDC_LOGOUT_HINT_COOKIE];
  if (raw === undefined) {
    return { present: false, parseError: false, hint: null };
  }
  try {
    return { present: true, parseError: false, hint: JSON.parse(raw) };
  } catch {
    return { present: true, parseError: true, hint: null };
  }
}
