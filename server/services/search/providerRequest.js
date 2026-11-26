// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the HTTP search providers (Staan, SearXNG) do the same way around one
 * request: wait before a retry, turn a failed answer into an error, wrap a
 * network failure so a proxy or TLS problem can be diagnosed from the log, and
 * read a body that may not be JSON. The providers differ in what they send and
 * how they classify the answer; none of that is here.
 *
 * Functions only, no module-scope work: this sits on both sides of the
 * `configCache → toolLoader → WebSearchService` import cycle, like the other
 * modules of this folder.
 *
 * @module services/search/providerRequest
 */
import logger from '../../utils/logger.js';

/** Most seconds a `Retry-After` header may make a search wait. */
const MAX_RETRY_AFTER_MS = 5000;

/** The hint every network failure carries, unless the provider has a better one. */
export const PROXY_HINT =
  'If a proxy is configured, verify HTTPS_PROXY/HTTP_PROXY, ssl.domainWhitelist, and proxy.urlPatterns in platform.json.';

/**
 * Wait before the next attempt after throttling: the `Retry-After` the
 * provider sent (at most five seconds), else a growing backoff. Logs it.
 *
 * @param {Object} params
 * @param {Object} params.res - the throttled response
 * @param {number} params.attempt - attempts made so far (0 for the first retry)
 * @param {number} params.backoffMs - base backoff
 * @param {string} params.provider - id, for the log
 * @param {string} params.label - name, for the log
 * @returns {Promise<void>}
 */
export async function waitBeforeRetry({ res, attempt, backoffMs, provider, label }) {
  const retryAfter = Number(res.headers?.get?.('retry-after'));
  const waitMs =
    Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, MAX_RETRY_AFTER_MS)
      : backoffMs * (attempt + 1);
  logger.warn(`${label} search rate-limited; backing off and retrying`, {
    component: 'WebSearch',
    provider,
    status: res.status,
    attempt: attempt + 1,
    waitMs
  });
  await new Promise(resolve => setTimeout(resolve, waitMs));
}

/**
 * The error of a search the provider answered with a failure: logged, with the
 * provider's `code` and the HTTP `status` kept on it.
 *
 * @param {Object} params
 * @param {{code: string, message: string}} params.error - the provider's classification
 * @param {Object} params.res - the response
 * @param {string} params.provider
 * @param {string} params.label
 * @param {Object} [params.details] - more log fields (a page offset)
 * @returns {Error}
 */
export function searchFailure({ error, res, provider, label, details = {} }) {
  logger.error(`${label} search failed`, {
    component: 'WebSearch',
    provider,
    status: res.status,
    ...details,
    errorCode: error.code,
    errorMessage: error.message
  });
  const failure = new Error(error.message);
  failure.code = error.code;
  failure.status = res.status;
  return failure;
}

/**
 * The error of a request that got no answer (DNS, connection, TLS, proxy):
 * logged with its cause and wrapped in one that says what failed, with the
 * low-level `code` kept.
 *
 * @param {Object} params
 * @param {Error} params.error - what the transport threw
 * @param {string} params.provider
 * @param {string} params.label
 * @param {Object} [params.details] - more log fields (the endpoint)
 * @param {string} [params.hint] - what to check; the proxy hint by default
 * @returns {Error}
 */
export function networkFailure({ error, provider, label, details = {}, hint = PROXY_HINT }) {
  const causeMsg =
    error?.cause?.message || (typeof error?.cause === 'string' ? error.cause : undefined);
  logger.error(`${label} search network request failed`, {
    component: 'WebSearch',
    provider,
    ...details,
    errorName: error?.name,
    errorCode: error?.code || error?.cause?.code,
    errorMessage: error?.message,
    errorCause: causeMsg,
    hint
  });
  const detailParts = [error?.message];
  if (error?.code) detailParts.push(`code=${error.code}`);
  if (causeMsg) detailParts.push(`cause=${causeMsg}`);
  const wrapped = new Error(
    `${label} search request failed: ${detailParts.filter(Boolean).join(' ')}`
  );
  wrapped.code = error?.code || error?.cause?.code || 'NETWORK_ERROR';
  wrapped.cause = error;
  return wrapped;
}

/**
 * A response body as JSON, or null when it is not JSON at all (an HTML page of
 * a proxy, an empty body), so the caller classifies it instead of throwing a
 * SyntaxError.
 *
 * @param {Object} res - fetch Response
 * @returns {Promise<Object|null>}
 */
export async function readJsonBody(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
