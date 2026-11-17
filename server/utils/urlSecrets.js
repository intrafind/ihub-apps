// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The names with an optional `-` or `_` between two words (`api[-_]?key`),
 * written out: `apikey`, `api-key`, `api_key`.
 *
 * @param {string} first
 * @param {string} second
 * @returns {string[]}
 */
function joinedEitherWay(first, second) {
  return [`${first}${second}`, `${first}-${second}`, `${first}_${second}`];
}

/**
 * Query parameter names that carry a credential in a URL, in lower case. Besides
 * the generic ones (`key`, `token`, `api_key`, `client_secret`, ...) these are
 * the function keys and signed-URL parameters of common hosts: Azure Functions
 * `code`, Azure SAS `sig`, Azure API Management `subscription-key`, AWS SigV4
 * `X-Amz-Signature` / `X-Amz-Credential` / `X-Amz-Security-Token`, and `auth`.
 * Matched as the whole parameter name, case-insensitively.
 */
const SECRET_QUERY_PARAMS = new Set([
  ...joinedEitherWay('api', 'key'),
  ...joinedEitherWay('access', 'token'),
  ...joinedEitherWay('refresh', 'token'),
  ...joinedEitherWay('id', 'token'),
  ...joinedEitherWay('session', 'token'),
  ...joinedEitherWay('client', 'secret'),
  ...joinedEitherWay('subscription', 'key'),
  'key',
  'token',
  'password',
  'passwd',
  'secret',
  'code',
  'sig',
  'signature',
  'auth',
  'x-amz-signature',
  'x-amz-credential',
  'x-amz-security-token'
]);

/** The longest name in {@link SECRET_QUERY_PARAMS}; no longer name can match. */
const LONGEST_SECRET_PARAM = Math.max(...[...SECRET_QUERY_PARAMS].map(name => name.length));

/** Characters a name in {@link SECRET_QUERY_PARAMS} is made of, in any case. */
const SECRET_PARAM_NAME_CHARS = /^[a-z_-]+$/i;

/**
 * The end of a secret query parameter's name that starts after `?`/`&` at
 * `start` (the index of its `=`), or -1 when the name there is not one of
 * {@link SECRET_QUERY_PARAMS}. Looks at most {@link LONGEST_SECRET_PARAM} + 1
 * characters ahead.
 *
 * @param {string} url
 * @param {number} start - Index of the `?` or `&`
 * @returns {number}
 */
function secretParamNameEnd(url, start) {
  const ahead = url.slice(start + 1, start + 2 + LONGEST_SECRET_PARAM);
  const nameLength = ahead.indexOf('=');
  if (nameLength < 1) return -1;
  const name = ahead.slice(0, nameLength);
  // ASCII letters only: a regular expression with the `i` flag never matched
  // a non-ASCII character (the Kelvin sign) against an ASCII one either.
  if (!SECRET_PARAM_NAME_CHARS.test(name)) return -1;
  return SECRET_QUERY_PARAMS.has(name.toLowerCase()) ? start + 1 + nameLength : -1;
}

/**
 * Mask the value of every {@link SECRET_QUERY_PARAMS} parameter: `?token=abc`
 * becomes `?token=REDACTED`. The value runs to the next `&`, `#` or
 * whitespace. Plain string code, linear in the length of `url`.
 *
 * @param {string} url
 * @returns {string}
 */
function redactSecretQueryParams(url) {
  let redacted = '';
  let copiedUpTo = 0;
  let index = 0;
  while (index < url.length) {
    const char = url[index];
    const equalsAt = char === '?' || char === '&' ? secretParamNameEnd(url, index) : -1;
    if (equalsAt === -1) {
      index++;
      continue;
    }
    let valueEnd = equalsAt + 1;
    while (valueEnd < url.length && !'&#'.includes(url[valueEnd]) && !/\s/.test(url[valueEnd])) {
      valueEnd++;
    }
    redacted += `${url.slice(copiedUpTo, equalsAt + 1)}REDACTED`;
    copiedUpTo = valueEnd;
    index = valueEnd;
  }
  return redacted + url.slice(copiedUpTo);
}

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
  return redactSecretQueryParams(url.replace(/(\/\/)[^/@\s]+@/, '$1REDACTED@'));
}
