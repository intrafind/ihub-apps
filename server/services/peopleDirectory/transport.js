// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The transport rules of a people directory, without opening anything: which
 * protection a URL gets (LDAPS, StartTLS or none) and whether that is allowed.
 * Kept apart from connection.js so the tool listing can apply them without
 * loading the LDAP client.
 */

/** A failure with the step it happened in, for tool results and the admin test. */
export class DirectoryConnectionError extends Error {
  /**
   * @param {string} message
   * @param {Object} options
   * @param {string} options.code - Stable reason, e.g. `ssrf_blocked`
   * @param {string} options.step - `configuration` | `network` | `connect` | `starttls` | `bind`
   * @param {Object} [options.details]
   * @param {string[]} [options.hints]
   * @param {Error} [options.cause]
   */
  constructor(message, { code, step, details, hints, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'DirectoryConnectionError';
    this.code = code;
    this.step = step;
    this.details = details;
    this.hints = hints;
  }
}

/**
 * The parts of a directory URL a connection needs.
 * @param {string} rawUrl
 * @returns {{protocol: string, hostname: string, port: number, secure: boolean}}
 */
export function parseDirectoryUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    throw new DirectoryConnectionError(`"${rawUrl}" is not a valid LDAP URL.`, {
      code: 'invalid_url',
      step: 'configuration'
    });
  }
  if (url.protocol !== 'ldap:' && url.protocol !== 'ldaps:') {
    throw new DirectoryConnectionError(
      `Unsupported protocol "${url.protocol}". Use ldaps:// (port 636) or ldap:// (port 389).`,
      { code: 'invalid_url', step: 'configuration' }
    );
  }
  const secure = url.protocol === 'ldaps:';
  return {
    protocol: url.protocol,
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port) || (secure ? 636 : 389),
    secure
  };
}

/**
 * How a resolved directory's connection is protected.
 * @param {{url: string, starttls?: boolean}} resolved
 * @returns {'ldaps'|'starttls'|'plaintext'|'unknown'}
 */
export function describeTransport(resolved) {
  let secure;
  try {
    secure = parseDirectoryUrl(resolved.url).secure;
  } catch {
    return 'unknown';
  }
  if (secure) return 'ldaps';
  return resolved.starttls === true ? 'starttls' : 'plaintext';
}

/**
 * Refuse a plain-text connection the directory does not allow, and a service
 * bind over plain text whatever the directory says.
 * @param {Object} resolved
 * @throws {DirectoryConnectionError}
 */
export function assertTransportAllowed(resolved) {
  if (describeTransport(resolved) !== 'plaintext') return;
  if (resolved.bind?.mode === 'service') {
    throw new DirectoryConnectionError(
      'A service account is never bound over a plain-text connection. Use an ldaps:// URL or enable StartTLS.',
      { code: 'plaintext_refused', step: 'configuration' }
    );
  }
  if (resolved.allowPlaintext !== true) {
    throw new DirectoryConnectionError(
      'This ldap:// connection is not encrypted, so search terms and the people found would cross the network in plain text. Use an ldaps:// URL or enable StartTLS, or set "allowPlaintext" on the directory.',
      { code: 'plaintext_refused', step: 'configuration' }
    );
  }
}
