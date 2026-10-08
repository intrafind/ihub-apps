/**
 * The OAuth `state` of an OIDC login, as a signed ticket bound to the browser.
 *
 * An OIDC login spans two requests — `GET /api/auth/oidc/<provider>` sends the
 * browser to the identity provider, `GET /api/auth/oidc/<provider>/callback`
 * receives the code — and in cluster mode they land on different workers.
 * passport-oauth2's default state store keeps the state handle and the PKCE
 * verifier in `req.session`, which was a per-process memory store, so the
 * callback failed with "Unable to verify authorization request state" roughly
 * (N-1)/N of the time for N workers.
 *
 * This store keeps nothing on the server. Everything the callback needs travels
 * in the `state` parameter, protected by an HMAC like the integration sign-in
 * state (`utils/integrationOAuthState.js`):
 *
 *   - `provider`: the OIDC provider that started the flow; a ticket for one
 *     provider cannot complete another.
 *   - `cv`: the PKCE verifier, AES-256-GCM encrypted with the token store's
 *     key — it never leaves the server in clear text.
 *   - `returnUrl`: where to send the browser afterwards (validated by the
 *     caller before it is put in here).
 *   - `bh`: hash of a random nonce that is also set as an httpOnly cookie on
 *     the browser that started the login. The callback requires the cookie, so
 *     a callback URL captured from one browser cannot complete a login in
 *     another (login CSRF) — the job the session cookie used to do.
 *   - `exp`: a 15-minute lifetime.
 *
 * The object implements passport-oauth2's state store interface
 * (`store(req, verifier, state, meta, cb)` / `verify(req, state, cb)`).
 *
 * @module utils/oidcLoginState
 */
import crypto from 'node:crypto';
import tokenStorageService from '../services/TokenStorageService.js';
import { resolveJwtSecret } from './tokenService.js';
import { getAuthCookieOptions, getClearAuthCookieOptions } from './cookieSettings.js';
import logger from './logger.js';

export const OIDC_LOGIN_STATE_TTL_MS = 15 * 60 * 1000;

/** httpOnly cookie that binds a login's state to the browser that started it. */
export const OIDC_LOGIN_COOKIE = 'oidcLoginNonce';

/**
 * Path '/', like the old session cookie: the base path is request-scoped
 * (X-Forwarded-Prefix), so a scoped path would miss the callback under a
 * subpath deployment.
 */
const COOKIE_PATH = '/';

const STATE_VERSION = 1;

/** Message passport hands to the callback on any verification failure. */
const VERIFY_FAILED = 'Unable to verify authorization request state.';

function sign(encodedPayload) {
  const secret = resolveJwtSecret();
  if (!secret || typeof secret !== 'string') {
    throw new Error('Cannot sign OIDC login state: no JWT secret is configured');
  }
  return crypto
    .createHmac('sha256', secret)
    .update(`oidc-login:${encodedPayload}`)
    .digest('base64url');
}

function hashNonce(nonce) {
  return crypto.createHash('sha256').update(nonce).digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a), 'utf8');
  const right = Buffer.from(String(b), 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Issue the signed `state` for one login.
 *
 * @param {Object} context
 * @param {string} context.provider - OIDC provider name
 * @param {string} context.nonce - Random value also set as the binding cookie
 * @param {string} [context.returnUrl] - Already validated
 * @param {string} [context.codeVerifier] - PKCE verifier in clear text; encrypted here
 * @param {number} [context.now] - Test seam
 * @returns {string} `<payload>.<signature>`
 */
export function issueOidcLoginState({
  provider,
  nonce,
  returnUrl,
  codeVerifier,
  now = Date.now()
}) {
  if (typeof provider !== 'string' || !provider) {
    throw new Error('OIDC login state needs a provider');
  }
  if (typeof nonce !== 'string' || !nonce) {
    throw new Error('OIDC login state needs a nonce');
  }
  const payload = {
    v: STATE_VERSION,
    provider,
    bh: hashNonce(nonce),
    ...(returnUrl ? { returnUrl } : {}),
    ...(codeVerifier ? { cv: tokenStorageService.encryptString(codeVerifier) } : {}),
    exp: now + OIDC_LOGIN_STATE_TTL_MS
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encodedPayload}.${sign(encodedPayload)}`;
}

/**
 * Verify the `state` a callback received against the binding cookie.
 *
 * @param {Object} input
 * @param {string} input.state - `state` query parameter
 * @param {string} [input.nonce] - Value of the binding cookie
 * @param {string} input.provider - Provider whose callback received the state
 * @param {number} [input.now] - Test seam
 * @returns {{ok: true, returnUrl?: string, codeVerifier?: string}
 *   | {ok: false, reason: string}}
 */
export function verifyOidcLoginState({ state, nonce, provider, now = Date.now() }) {
  const fail = reason => ({ ok: false, reason });
  if (!state || typeof state !== 'string' || state.length > 4096) return fail('missing_state');

  const separator = state.lastIndexOf('.');
  if (separator <= 0 || separator === state.length - 1) return fail('malformed_state');
  const encodedPayload = state.slice(0, separator);
  const signature = state.slice(separator + 1);

  let expected;
  try {
    expected = sign(encodedPayload);
  } catch (error) {
    logger.error('Cannot verify OIDC login state', {
      component: 'OidcLoginState',
      error: error?.message || String(error)
    });
    return fail('no_secret');
  }
  if (!safeEqual(signature, expected)) return fail('bad_signature');

  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return fail('malformed_state');
  }
  if (!payload || payload.v !== STATE_VERSION) return fail('malformed_state');
  if (payload.provider !== provider) return fail('wrong_provider');
  if (typeof payload.exp !== 'number' || now > payload.exp) return fail('expired');
  if (!nonce || typeof nonce !== 'string' || !safeEqual(hashNonce(nonce), payload.bh)) {
    return fail('browser_mismatch');
  }

  let codeVerifier;
  if (payload.cv) {
    try {
      codeVerifier = tokenStorageService.decryptString(payload.cv);
    } catch {
      return fail('bad_verifier');
    }
  }
  return {
    ok: true,
    ...(typeof payload.returnUrl === 'string' ? { returnUrl: payload.returnUrl } : {}),
    ...(codeVerifier ? { codeVerifier } : {})
  };
}

/**
 * passport-oauth2 state store for one provider.
 *
 * Pass the validated return URL as `passport.authenticate(name, { state: { returnUrl } })`;
 * it comes back on the callback as `info.state.returnUrl`.
 *
 * @param {string} provider - OIDC provider name
 * @returns {{store: Function, verify: Function}}
 */
export function createOidcStateStore(provider) {
  return {
    // passport-oauth2 dispatches on arity: five arguments means "PKCE-aware".
    store(req, verifier, state, _meta, callback) {
      try {
        const nonce = crypto.randomBytes(32).toString('base64url');
        const signed = issueOidcLoginState({
          provider,
          nonce,
          returnUrl: state?.returnUrl,
          codeVerifier: verifier
        });
        req.res.cookie(
          OIDC_LOGIN_COOKIE,
          nonce,
          getAuthCookieOptions(OIDC_LOGIN_STATE_TTL_MS, req, { path: COOKIE_PATH })
        );
        callback(null, signed);
      } catch (error) {
        callback(error);
      }
    },

    verify(req, providedState, callback) {
      const result = verifyOidcLoginState({
        state: providedState,
        nonce: req.cookies?.[OIDC_LOGIN_COOKIE],
        provider
      });
      // One login per cookie: drop it whatever the outcome.
      req.res?.clearCookie(
        OIDC_LOGIN_COOKIE,
        getClearAuthCookieOptions(req, { path: COOKIE_PATH })
      );

      if (!result.ok) {
        logger.warn('OIDC login state rejected', {
          component: 'OidcLoginState',
          provider,
          reason: result.reason,
          hasBindingCookie: Boolean(req.cookies?.[OIDC_LOGIN_COOKIE])
        });
        return callback(null, false, { message: VERIFY_FAILED });
      }
      // A string tells passport to send it as `code_verifier`; `true` means
      // "verified, no PKCE" for providers that disable it.
      return callback(null, result.codeVerifier || true, {
        ...(result.returnUrl ? { returnUrl: result.returnUrl } : {})
      });
    }
  };
}
