// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * `frame-ancestors` helpers shared by every page iHub lets another site embed.
 *
 * @module utils/frameAncestors
 */

/**
 * The `frame-ancestors` source list for a set of allowed origins: `'self'`
 * always, plus each `http(s)` origin. Anything else is ignored.
 *
 * @param {unknown} allowedOrigins - Candidate origins (URLs).
 * @returns {string} Space-separated source list.
 */
export function sanitizeFrameAncestors(allowedOrigins) {
  const sources = ["'self'"];
  if (Array.isArray(allowedOrigins)) {
    for (const item of allowedOrigins) {
      if (typeof item !== 'string') continue;
      try {
        const url = new URL(item);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
        if (!sources.includes(url.origin)) sources.push(url.origin);
      } catch {
        /* ignore */
      }
    }
  }
  return sources.join(' ');
}

/**
 * Set the framing policy on a response. Drops any `X-Frame-Options` the global
 * middleware set: it cannot express a multi-origin allowlist and overrides
 * `frame-ancestors` in some user agents.
 *
 * @param {import('express').Response} res - Express response.
 * @param {unknown} allowedOrigins - Allowed embedding origins.
 * @param {string[]} [extraDirectives] - Further CSP directives to send with it.
 */
export function applyFrameAncestorsCsp(res, allowedOrigins, extraDirectives = []) {
  res.removeHeader('X-Frame-Options');
  res.setHeader(
    'Content-Security-Policy',
    [`frame-ancestors ${sanitizeFrameAncestors(allowedOrigins)}`, ...extraDirectives].join('; ')
  );
}
