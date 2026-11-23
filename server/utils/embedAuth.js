// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Sign-in for iHub shown in a frame of another site (iFinder, a portal).
 *
 * An identity provider such as Microsoft Entra ID refuses to be framed, so the
 * sign-in itself runs in a popup window. The popup hands the frame a one-time
 * code, and the frame redeems it for a session cookie. The cookie is set by a
 * response to a request the framed page made, so it belongs to the frame:
 *
 *   `HttpOnly; Secure; SameSite=None; Partitioned`
 *
 * - `HttpOnly`: no script, including a script that got into the page, can read
 *   the session. It is never in a response body, never in `localStorage`.
 * - `Partitioned` (CHIPS): the browser stores the cookie per top-level site and
 *   sends it only while iHub is framed by that same site. Another site that
 *   frames iHub, or opens it directly, gets none.
 * - `SameSite=None`: needed for a cookie in a cross-site frame. It gives up the
 *   protection `Lax` gives against forged requests, so {@link isSameOriginRequest}
 *   makes up for it: a session carried by this cookie is only honoured for
 *   requests the iHub page itself made.
 *
 * The cookie has a name of its own, so it never clashes with the `authToken`
 * cookie that a same-site frame sends as well.
 *
 * @module utils/embedAuth
 */

/** Name of the session cookie that belongs to a framed iHub. */
export const EMBED_SESSION_COOKIE = 'authTokenEmbed';

/** Marks a code in the authorization code store as an embed sign-in code. */
export const EMBED_CODE_PURPOSE = 'embed-session';

/** A code is for the hop from the popup to the frame: seconds, not minutes. */
export const EMBED_CODE_TTL_MS = 60 * 1000;

/** BASE64URL(SHA-256(verifier)): always 43 characters. */
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** RFC 7636: 43 to 128 unreserved characters (the unreserved `.` and `~` are not used here). */
const CODE_VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

/** What a signed session token is made of: base64url segments joined by dots. */
const COOKIE_SAFE_TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/;

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * @param {unknown} value
 * @returns {boolean} Whether the value is shaped like a PKCE S256 challenge.
 */
export function isValidCodeChallenge(value) {
  return typeof value === 'string' && CODE_CHALLENGE_PATTERN.test(value);
}

/**
 * @param {unknown} value
 * @returns {boolean} Whether the value is shaped like a PKCE verifier.
 */
export function isValidCodeVerifier(value) {
  return typeof value === 'string' && CODE_VERIFIER_PATTERN.test(value);
}

/**
 * The origins of the sites that may show iHub in a frame, from `embedAuth.allowedHostOrigins` of
 * the platform configuration, while `embedAuth.enabled` is on. Only `http(s)` origins count;
 * anything else (a path, another scheme, a non-string) is dropped.
 *
 * Switched off, the list is not in force: nothing is restricted and nothing is allowed, so an
 * admin can keep the list and turn the feature off.
 *
 * @param {object} [platform] - The platform configuration.
 * @returns {string[]} Distinct origins, such as `https://ifinder.example.com`.
 */
export function getEmbedAuthOrigins(platform) {
  if (platform?.embedAuth?.enabled !== true) return [];
  const configured = platform.embedAuth.allowedHostOrigins;
  if (!Array.isArray(configured)) return [];
  const origins = [];
  for (const item of configured) {
    if (typeof item !== 'string') continue;
    try {
      const url = new URL(item);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      if (!origins.includes(url.origin)) origins.push(url.origin);
    } catch {
      /* not a URL: ignore */
    }
  }
  return origins;
}

/**
 * Whether the sign-in in a frame is in force: the switch is on and at least one host origin is
 * allowed. A switch that is on with an empty list does nothing, rather than locking out every site.
 *
 * @param {object} [platform] - The platform configuration.
 * @returns {boolean}
 */
export function isEmbedAuthEnabled(platform) {
  return getEmbedAuthOrigins(platform).length > 0;
}

/**
 * The `Set-Cookie` value of the framed session.
 *
 * Written by hand: `Partitioned` is not known to every version of the cookie
 * serializer that Express ships. The `Path` is `/`, as for `authToken`.
 *
 * @param {string} token - The signed session token.
 * @param {number} maxAgeSeconds - How long the cookie lives; the token's remaining lifetime.
 * @returns {string}
 * @throws {Error} When the token holds a character that is not safe in a cookie.
 */
export function serializeEmbedSessionCookie(token, maxAgeSeconds) {
  if (typeof token !== 'string' || !COOKIE_SAFE_TOKEN_PATTERN.test(token)) {
    throw new Error('Refusing to write a session token that is not cookie safe');
  }
  const maxAge = Math.max(0, Math.floor(maxAgeSeconds));
  return `${EMBED_SESSION_COOKIE}=${token}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`;
}

/**
 * The `Set-Cookie` value that ends the framed session. A partitioned cookie is
 * only replaced by a header that names `Partitioned` as well.
 *
 * @returns {string}
 */
export function serializeClearEmbedSessionCookie() {
  return `${EMBED_SESSION_COOKIE}=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`;
}

/**
 * Whether a request was made by an iHub page itself, as opposed to another site
 * (or a page that site framed) making the browser send the cookie along.
 *
 * Browsers say so in `Sec-Fetch-Site`. Without it (an old browser, a script) the
 * `Origin` header is compared with this server's own origin.
 *
 * - A safe method (`GET`, `HEAD`, `OPTIONS`) is also accepted when the user typed
 *   or bookmarked the address (`Sec-Fetch-Site: none`), or when the browser sent
 *   neither header: it changes nothing, and a cross-site page cannot read the answer.
 * - An unsafe method needs proof: `same-origin`, or a matching `Origin`.
 *
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function isSameOriginRequest(req) {
  const safe = SAFE_METHODS.has(String(req.method).toUpperCase());
  const site = req.get('sec-fetch-site');
  if (site) return site === 'same-origin' || (site === 'none' && safe);
  const origin = req.get('origin');
  if (origin) return origin === `${req.protocol}://${req.host}`;
  return safe;
}
