// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Origins of the sites that may show iHub in a frame, as an admin enters them (the Nextcloud
 * embed and the sign-in in a frame, `utils/embedAuth.js`). Each entry ends up in a
 * `frame-ancestors` policy or a `postMessage` check, so a malformed one must not widen either.
 *
 * @module utils/hostOrigins
 */

import { ServiceError } from './ServiceError.js';

/** How many origins one list may hold. */
export const MAX_HOST_ORIGINS = 50;

/**
 * Validate a single origin. Only well-formed `http`/`https` origins are accepted (scheme and
 * host, optionally a port: no path, query or fragment, no credentials).
 *
 * @param {unknown} raw - The entry as entered.
 * @returns {string|null} The canonical origin (no trailing slash), or null when invalid.
 */
export function canonicalizeOrigin(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return null;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.pathname && url.pathname !== '/') return null;
  if (url.search || url.hash) return null;
  return url.origin;
}

/**
 * Validate a list of origins: canonical form, duplicates dropped, order kept.
 *
 * @param {unknown} value - The list as sent.
 * @param {string} [field='allowedHostOrigins'] - Its name, for the error message.
 * @returns {string[]} The canonical origins.
 * @throws {ServiceError} `BAD_REQUEST` when it is not a list, is too long, or holds an invalid entry.
 */
export function sanitizeHostOrigins(value, field = 'allowedHostOrigins') {
  if (!Array.isArray(value)) {
    throw new ServiceError('BAD_REQUEST', `${field} must be an array`);
  }
  if (value.length > MAX_HOST_ORIGINS) {
    throw new ServiceError(
      'BAD_REQUEST',
      `${field} must not contain more than ${MAX_HOST_ORIGINS} entries`
    );
  }
  const origins = [];
  value.forEach((entry, index) => {
    const canonical = canonicalizeOrigin(entry);
    if (!canonical) {
      throw new ServiceError(
        'BAD_REQUEST',
        `${field}[${index}] must be a valid http(s) origin (e.g. https://ifinder.example.com)`
      );
    }
    if (!origins.includes(canonical)) origins.push(canonical);
  });
  return origins;
}
