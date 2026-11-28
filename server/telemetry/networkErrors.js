// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * One closed classification of network failures, for `error.type` on outbound
 * metrics and for the telemetry export status. Never the message: it can carry
 * a URL with a token or a header.
 *
 * @module telemetry/networkErrors
 */

/** Node and OpenSSL codes of a failed TLS handshake or certificate check. */
const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'EPROTO'
]);

/**
 * The class of a network failure: `tls`, `connection_refused`, `dns`,
 * `timeout`, `network`, or `unknown`. Looks through wrapped causes.
 *
 * @param {unknown} error
 * @returns {{type: string, tls: boolean}}
 */
export function networkErrorClass(error) {
  const seen = new Set();
  for (let current = error; current && typeof current === 'object' && !seen.has(current);) {
    seen.add(current);
    const code = typeof current.code === 'string' ? current.code : undefined;
    const errno = typeof current.errno === 'string' ? current.errno : undefined;
    const effective = code || errno;
    if (effective && TLS_CODES.has(effective)) return { type: 'tls', tls: true };
    if (effective === 'ECONNREFUSED' || effective === 'ECONNRESET') {
      return { type: 'connection_refused', tls: false };
    }
    if (effective === 'ENOTFOUND' || effective === 'EAI_AGAIN') return { type: 'dns', tls: false };
    if (
      effective === 'ETIMEDOUT' ||
      effective === 'ESOCKETTIMEDOUT' ||
      current.name === 'TimeoutError' ||
      current.type === 'request-timeout'
    ) {
      return { type: 'timeout', tls: false };
    }
    if (effective && /^E[A-Z]+$/.test(effective)) return { type: 'network', tls: false };
    current = current.cause;
  }
  return { type: 'unknown', tls: false };
}

/**
 * Whether a signal's abort reason is a deadline: `AbortSignal.timeout()` and
 * the LLM client's own timers abort with a `TimeoutError`.
 *
 * @param {unknown} reason - `signal.reason`
 * @returns {boolean}
 */
export function isTimeoutReason(reason) {
  return !!reason && typeof reason === 'object' && reason.name === 'TimeoutError';
}

/** Whether an error is a request the caller aborted (not a dependency failure). */
export function isAbortedRequest(error) {
  return (
    !!error &&
    typeof error === 'object' &&
    (error.name === 'AbortError' || error.type === 'aborted' || error.code === 'ABORT_ERR')
  );
}
