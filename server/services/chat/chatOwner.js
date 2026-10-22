// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Chat ownership — who a stored chat belongs to, signed-in or not.
 *
 * Every chat is stored now, an anonymous visitor's included, so an anonymous
 * caller needs an identity that survives from one request to the next. The run
 * principal cannot be it: `resolvePrincipal` mints a fresh random id for an
 * anonymous user on every call, deliberately, so that a run is never listed
 * under somebody who cannot sign in.
 *
 * A **guest** is that identity: a server-minted 256-bit secret in an HttpOnly
 * cookie, given to the first anonymous API request that has none. The chat
 * stores `guest-<sha256(secret)>` as its owner, so neither the document nor a
 * log line ever carries the secret itself, and a request without the cookie
 * matches no stored guest chat.
 *
 * The secret rides on `req.user` through a WeakMap rather than a property, so it
 * can never be serialized back to the browser with the user object (the auth
 * status endpoint echoes it) — the cookie is HttpOnly for a reason.
 *
 * @module services/chat/chatOwner
 */
import crypto from 'node:crypto';
import { isAnonymousUser, normalizeIdentityMode, resolvePrincipal } from '../loop/runIdentity.js';
import { getCookieSecureFlag } from '../../utils/cookieSettings.js';

/** Name of the guest identity cookie. */
export const GUEST_COOKIE = 'ihubGuest';

/** How long a browser keeps its guest identity. */
export const GUEST_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Prefix of a guest's owner id. */
export const GUEST_OWNER_PREFIX = 'guest-';

/** A guest secret is 32 random bytes, hex encoded. */
const GUEST_ID_PATTERN = /^[0-9a-f]{64}$/;

/** Guest secret per request principal. Never enumerable, never serialized. */
const guestIds = new WeakMap();

/**
 * The guest secret a cookie value carries, or null for anything else.
 *
 * @param {unknown} value - Raw cookie value.
 * @returns {string|null}
 */
export function parseGuestId(value) {
  return typeof value === 'string' && GUEST_ID_PATTERN.test(value) ? value : null;
}

/**
 * The guest secret a raw `Cookie` header carries — for a request that never
 * went through Express's cookie parser (the realtime WebSocket upgrade).
 *
 * @param {unknown} header - The `Cookie` request header.
 * @returns {string|null}
 */
export function guestIdFromCookieHeader(header) {
  if (typeof header !== 'string') return null;
  const prefix = `${GUEST_COOKIE}=`;
  const entry = header
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(prefix));
  return entry ? parseGuestId(entry.slice(prefix.length)) : null;
}

/** @returns {string} A new guest secret. */
export function mintGuestId() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * The owner id a guest's chats are stored under.
 *
 * @param {string} guestId - Guest secret.
 * @returns {string}
 */
export function guestOwnerId(guestId) {
  return `${GUEST_OWNER_PREFIX}${crypto.createHash('sha256').update(guestId).digest('hex')}`;
}

/**
 * Bind a guest secret to a principal object.
 *
 * @param {Object} user - `req.user` of an anonymous request.
 * @param {string} guestId - Guest secret.
 */
export function setGuestId(user, guestId) {
  if (user && typeof user === 'object' && parseGuestId(guestId)) guestIds.set(user, guestId);
}

/**
 * The guest secret bound to a principal, or null.
 *
 * @param {Object} [user] - `req.user`.
 * @returns {string|null}
 */
export function guestIdOf(user) {
  return user && typeof user === 'object' ? guestIds.get(user) || null : null;
}

/**
 * Give an anonymous request its guest identity: the one its cookie names, or a
 * new one (and the cookie that carries it).
 *
 * Only for API requests, so a page load or a static asset never sets a cookie,
 * and only for the anonymous principal — a signed-in user owns chats under its
 * own id.
 *
 * @param {import('express').Request} req - Request whose `req.user` is the
 *   anonymous principal.
 * @param {import('express').Response} res - Response the cookie is set on.
 * @returns {string|null} The guest secret, or null when the request gets none.
 */
export function attachGuestIdentity(req, res) {
  if (!req?.user || !isAnonymousUser(req.user)) return null;
  const existing = parseGuestId(req.cookies?.[GUEST_COOKIE]);
  if (existing) {
    setGuestId(req.user, existing);
    return existing;
  }
  if (!/\/api\//.test(req.originalUrl || req.url || '') || typeof res?.cookie !== 'function') {
    return null;
  }
  const minted = mintGuestId();
  res.cookie(GUEST_COOKIE, minted, {
    httpOnly: true,
    secure: getCookieSecureFlag(req),
    sameSite: 'lax',
    maxAge: GUEST_COOKIE_MAX_AGE_MS,
    path: '/'
  });
  setGuestId(req.user, minted);
  return minted;
}

/**
 * The owner a caller's chats are stored under, in identity mode `mode`.
 *
 * A signed-in caller is its run principal in that mode — the mode recorded on
 * a chat, or the configured one for a new chat — so an admin changing
 * `runLog.identityMode` does not orphan stored chats. A guest is its hashed
 * secret whatever the mode: there is no user id to pseudonymize.
 *
 * @param {Object} [user] - `req.user`.
 * @param {Object} [options]
 * @param {string} [options.mode='default'] - Identity mode.
 * @returns {Promise<{id: string, mode: string, guest: boolean}|null>} null for
 *   an anonymous caller without a guest identity, which owns nothing.
 */
export async function resolveChatOwner(user, { mode = 'default' } = {}) {
  if (isAnonymousUser(user)) {
    const guestId = guestIdOf(user);
    if (!guestId) return null;
    return { id: guestOwnerId(guestId), mode: normalizeIdentityMode(mode), guest: true };
  }
  const principal = await resolvePrincipal(user, { mode });
  return { id: principal.id, mode: principal.mode || normalizeIdentityMode(mode), guest: false };
}
