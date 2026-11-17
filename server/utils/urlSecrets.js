// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Redact secret-looking parts of a URL so it can be safely included in logs and
 * error messages. Credentials ride along in a URL two ways: query parameters
 * (Google's `?key=`, plus `token` / `api_key` / `client_secret` / ...) and
 * basic-auth userinfo (`http://user:pass@host`). Both are masked; non-strings
 * are returned unchanged.
 *
 * @param {string} url - The URL to sanitize
 * @returns {string} URL with any embedded secrets replaced by `REDACTED`
 */
export function redactUrlSecrets(url) {
  if (typeof url !== 'string') return url;
  return url
    .replace(/(\/\/)[^/@\s]+@/, '$1REDACTED@')
    .replace(
      /([?&](?:api[-_]?key|access[-_]?token|client[-_]?secret|key|token|password|secret)=)[^&#\s]*/gi,
      '$1REDACTED'
    );
}
