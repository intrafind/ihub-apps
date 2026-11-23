// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Facts about a failed outbound connection that the admin UI shows next to the
 * error headline: which host was called, and whether the failure was a TLS
 * certificate the server does not trust.
 *
 * Used by the model test (`POST /admin/models/:id/_test`) and the model import
 * (`POST /admin/models/_discover`), so both name the same causes the same way.
 * Nothing here ever returns a URL path, a query string or credentials: only the
 * host (and port), which the admin entered themselves.
 *
 * @module utils/connectionErrors
 */

/**
 * OpenSSL / Node codes of a certificate the server does not trust. All of them are
 * cured by trusting the certificate: a private CA in the domain whitelist with
 * `ssl.ignoreInvalidCertificates`, or a certificate that is fixed on the endpoint.
 */
export const TLS_CERTIFICATE_ERROR_CODES = Object.freeze(
  new Set([
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_DECRYPT_CERT_SIGNATURE',
    'CERT_SIGNATURE_FAILURE',
    'CERT_UNTRUSTED',
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID',
    'ERR_TLS_CERT_ALTNAME_INVALID'
  ])
);

/** Messages of the same failures, for an error that carries no code. */
const TLS_CERTIFICATE_MESSAGE =
  /unable to verify the first certificate|self[- ]signed certificate|unable to get (?:local )?issuer certificate|certificate has expired|certificate is not yet valid|does not match certificate'?s altnames/i;

/** How deep a `cause` chain is followed (fetch failed → socket error → …). */
const MAX_CAUSE_DEPTH = 4;

/**
 * The errors of a `cause` chain, outermost first.
 *
 * @param {unknown} err
 * @returns {Array<Object>}
 */
function causeChain(err) {
  const chain = [];
  let current = err;
  while (current && typeof current === 'object' && chain.length < MAX_CAUSE_DEPTH) {
    chain.push(current);
    current = current.cause;
  }
  return chain;
}

/**
 * The certificate error code behind a failed connection, if the failure was an
 * untrusted TLS certificate.
 *
 * Looks at `code` and `providerCode` along the `cause` chain (undici wraps the
 * socket error as `fetch failed` → `cause`), then at the messages and a string
 * `details` (what `LLMClient` keeps of the cause), since some clients report
 * the failure only as text ("unable to verify the first certificate").
 *
 * @param {unknown} err - Anything thrown by a fetch, an SDK or `LLMClient`
 * @returns {string|null} The code (e.g. `UNABLE_TO_VERIFY_LEAF_SIGNATURE`), the
 *   generic `CERT_UNTRUSTED` when only the message names the failure, or null
 *
 * @example
 *   tlsCertificateErrorCode(Object.assign(new Error('fetch failed'), {
 *     cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' }
 *   })); // → 'SELF_SIGNED_CERT_IN_CHAIN'
 */
export function tlsCertificateErrorCode(err) {
  const chain = causeChain(err);
  for (const entry of chain) {
    for (const candidate of [entry.code, entry.providerCode]) {
      if (typeof candidate === 'string' && TLS_CERTIFICATE_ERROR_CODES.has(candidate)) {
        return candidate;
      }
    }
  }
  for (const entry of chain) {
    const texts = [entry.message, typeof entry.details === 'string' ? entry.details : null];
    if (texts.some(text => typeof text === 'string' && TLS_CERTIFICATE_MESSAGE.test(text))) {
      return 'CERT_UNTRUSTED';
    }
  }
  return null;
}

/**
 * The host (with port, when one is set) of an endpoint URL, for an error
 * message. Credentials, path and query are never part of it.
 *
 * @param {unknown} url - Endpoint URL as configured
 * @returns {string|null} e.g. `llm.example.com:8443`, or null for anything that is not a URL
 */
export function endpointHost(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const { host } = new URL(url.trim());
    return host || null;
  } catch {
    return null;
  }
}
