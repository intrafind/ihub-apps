// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Query parameter names that carry a credential in a URL. Besides the generic
 * ones (`key`, `token`, `api_key`, `client_secret`, ...) these are the
 * function keys and signed-URL parameters of common hosts: Azure Functions
 * `code`, Azure SAS `sig`, Azure API Management `subscription-key`, AWS SigV4
 * `X-Amz-Signature` / `X-Amz-Credential` / `X-Amz-Security-Token`, and `auth`.
 * Matched as the whole parameter name, case-insensitively.
 */
const SECRET_QUERY_PARAMS =
  /([?&](?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|session[-_]?token|client[-_]?secret|subscription[-_]?key|key|token|password|passwd|secret|code|sig|signature|auth|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&#\s]*/gi;

/**
 * Redact secret-looking parts of a URL so it can be safely included in logs and
 * error messages. Credentials ride along in a URL two ways: query parameters
 * ({@link SECRET_QUERY_PARAMS}) and basic-auth userinfo
 * (`http://user:pass@host`). Both are masked; non-strings are returned
 * unchanged.
 *
 * @param {string} url - The URL to sanitize
 * @returns {string} URL with any embedded secrets replaced by `REDACTED`
 */
export function redactUrlSecrets(url) {
  if (typeof url !== 'string') return url;
  return url.replace(/(\/\/)[^/@\s]+@/, '$1REDACTED@').replace(SECRET_QUERY_PARAMS, '$1REDACTED');
}
