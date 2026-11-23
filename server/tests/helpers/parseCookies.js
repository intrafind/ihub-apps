// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Test helper for the small Express apps of route tests: fills `req.cookies` from the `Cookie`
 * header, which is all the routes under test read of `cookie-parser`.
 *
 * The apps of these tests are harnesses, not deployed apps, and they have no use for a signed or
 * JSON cookie. Using this instead of the library also keeps CodeQL's "Missing CSRF middleware"
 * rule, which keys on the library and not on what a handler does about forged requests, from
 * reporting every harness.
 */

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} _res
 * @param {import('express').NextFunction} next
 */
export function parseCookies(req, _res, next) {
  const cookies = {};
  for (const part of (req.get('cookie') || '').split(';')) {
    const entry = part.trim();
    const at = entry.indexOf('=');
    if (at <= 0) continue;
    const name = entry.slice(0, at);
    const raw = entry.slice(at + 1);
    try {
      cookies[name] = decodeURIComponent(raw);
    } catch {
      cookies[name] = raw;
    }
  }
  req.cookies = cookies;
  next();
}
