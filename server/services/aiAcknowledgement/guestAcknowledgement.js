// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The acknowledgement of a principal that has no users.json record: an
 * anonymous guest (or, rarely, a signed-in user whose record is gone).
 *
 * It is remembered in a signed, HttpOnly cookie `ihubAiAck`:
 * `v<version>.<issuedAtMs>.<hmac>`. The HMAC covers the subject, the version and
 * the issue time, and the subject is the guest secret (or `user:<id>`), so a
 * cookie cannot be moved to another browser identity. The evidence of the
 * acknowledgement is the audit entry, not the cookie.
 *
 * @module services/aiAcknowledgement/guestAcknowledgement
 */
import crypto from 'node:crypto';
import { GUEST_COOKIE_MAX_AGE_MS, guestIdOf } from '../chat/chatOwner.js';
import { getCookieSecureFlag } from '../../utils/cookieSettings.js';
import { resolveJwtSecret } from '../../utils/tokenService.js';

/** Name of the acknowledgement cookie. */
export const ACK_COOKIE = 'ihubAiAck';

/**
 * What the cookie is bound to: the guest secret of an anonymous caller, else
 * the user id. Never leaves the server.
 *
 * @param {Object} [user] - `req.user`
 * @returns {string|null}
 */
export function cookieSubject(user) {
  const guest = guestIdOf(user);
  if (guest) return `guest:${guest}`;
  if (user?.id && user.id !== 'anonymous') return `user:${user.id}`;
  return null;
}

function sign(subject, version, issuedAt) {
  const secret = resolveJwtSecret();
  if (!secret) return null;
  return crypto
    .createHmac('sha256', secret)
    .update(`${subject}|${version}|${issuedAt}`)
    .digest('base64url');
}

/**
 * Build the cookie value for a subject.
 *
 * @param {string} subject - See {@link cookieSubject}
 * @param {number} version - Acknowledged version
 * @param {number} [issuedAt] - Issue time in ms
 * @returns {string|null} null when no signing secret exists
 */
export function signAcknowledgement(subject, version, issuedAt = Date.now()) {
  const mac = sign(subject, version, issuedAt);
  return mac ? `v${version}.${issuedAt}.${mac}` : null;
}

/**
 * Whether a cookie value proves an acknowledgement for `subject` that still
 * counts.
 *
 * @param {unknown} value - Raw cookie value
 * @param {string|null} subject - See {@link cookieSubject}
 * @param {{requiredVersion: number, resetAt: string|null}} settings
 * @returns {boolean}
 */
export function verifyAcknowledgement(value, subject, settings) {
  if (typeof value !== 'string' || !subject) return false;
  const match = /^v(\d{1,9})\.(\d{10,16})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return false;
  const version = Number(match[1]);
  const issuedAt = Number(match[2]);
  const expected = sign(subject, version, issuedAt);
  if (!expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(match[3]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  if (version < settings.requiredVersion) return false;
  if (settings.resetAt) {
    const reset = Date.parse(settings.resetAt);
    if (Number.isFinite(reset) && issuedAt < reset) return false;
  }
  return Date.now() - issuedAt <= GUEST_COOKIE_MAX_AGE_MS;
}

/**
 * Whether the request carries a valid acknowledgement cookie.
 *
 * @param {import('express').Request} req
 * @param {{requiredVersion: number, resetAt: string|null}} settings
 * @returns {boolean}
 */
export function hasValidAcknowledgementCookie(req, settings) {
  return verifyAcknowledgement(req.cookies?.[ACK_COOKIE], cookieSubject(req.user), settings);
}

/**
 * Set the cookie on the response.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {number} version
 * @returns {boolean} false when the caller has no identity to bind to
 */
export function setAcknowledgementCookie(req, res, version) {
  const subject = cookieSubject(req.user);
  const value = subject ? signAcknowledgement(subject, version) : null;
  if (!value) return false;
  res.cookie(ACK_COOKIE, value, {
    httpOnly: true,
    secure: getCookieSecureFlag(req),
    sameSite: 'lax',
    maxAge: GUEST_COOKIE_MAX_AGE_MS,
    path: '/'
  });
  return true;
}
