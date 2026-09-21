/**
 * Turn the outcome of a web search into something an admin can act on.
 *
 * The admin connectivity test exists because the interesting failure is not
 * "the search failed" but *why*, and the two most common whys need opposite
 * responses:
 *
 *  - **Qwant blocked by DataDome.** Nothing in iHub is misconfigured. Qwant
 *    challenges requests from data-centre IP ranges, so the server's egress IP
 *    is the variable — retrying, re-saving the provider or changing the query
 *    will never help. The admin needs to know to change egress or use Brave.
 *  - **Brave missing or rejecting its key.** Genuinely a configuration problem,
 *    fixed on the very page the admin is looking at.
 *
 * Reported verbatim, a captcha reads as an opaque `HTTP 403` and an admin
 * reasonably concludes the feature is broken. So the classification lives here,
 * as pure functions over an outcome: no network, no Express, no provider
 * instance, and therefore straightforward to test and to reuse.
 *
 * @module services/search/searchDiagnostics
 */

/**
 * @typedef {Object} SearchDiagnosis
 * @property {'ok'|'empty'|'blocked'|'unconfigured'|'rate_limited'|'network'|'error'} status
 * @property {string} code - Stable machine-readable code (the provider's error code where it has one)
 * @property {string} title - One-line summary
 * @property {string} detail - What happened, in an admin's terms
 * @property {string[]} remediation - Concrete next steps, most useful first
 * @property {string|null} blockedBy - Bot-protection vendor when one was detected
 * @property {boolean} retryable - Whether running the same test again could plausibly differ
 */

/** Human labels for the providers this test covers. */
const PROVIDER_LABELS = { brave: 'Brave Search', qwant: 'Qwant', staan: 'Staan' };

/**
 * Label a provider for a message, falling back to its id.
 * @param {string} provider
 * @returns {string}
 */
export function providerLabel(provider) {
  return PROVIDER_LABELS[provider] || provider;
}

/**
 * Diagnose a search that returned without throwing.
 *
 * Zero results is deliberately not an error: the request reached the provider
 * and came back, which is exactly what the connectivity test asks. It is
 * reported separately so an admin is not left reading "success" next to an
 * empty list and wondering which of the two to believe.
 *
 * @param {{results?: Array}} payload - What the provider returned
 * @param {string} provider - Provider id
 * @returns {SearchDiagnosis}
 */
export function diagnoseSearchSuccess(payload, provider) {
  const count = Array.isArray(payload?.results) ? payload.results.length : 0;
  const label = providerLabel(provider);

  if (count === 0) {
    return {
      status: 'empty',
      code: 'NO_RESULTS',
      title: `${label} responded, but returned no results`,
      detail:
        'The request reached the provider and was answered normally — connectivity is fine. The query itself matched nothing.',
      remediation: ['Try a broader query, such as a single common word.'],
      blockedBy: null,
      retryable: true
    };
  }

  return {
    status: 'ok',
    code: 'OK',
    title: `${label} returned ${count} result${count === 1 ? '' : 's'}`,
    detail: `This server can reach ${label} and search works from here.`,
    remediation: [],
    blockedBy: null,
    retryable: false
  };
}

/**
 * Diagnose a thrown search error.
 *
 * `WebSearchService` wraps provider errors but preserves `code`, so the
 * provider's own classification (`QWANT_CAPTCHA`, `QWANT_RATE_LIMITED`, …) is
 * what is matched on; the message is only consulted as a fallback for the
 * unconfigured-key case, which predates those codes.
 *
 * @param {Error} error - The thrown error (possibly wrapped by WebSearchService)
 * @param {string} provider - Provider id
 * @returns {SearchDiagnosis}
 */
export function diagnoseSearchError(error, provider) {
  const label = providerLabel(provider);
  const code = error?.code || error?.cause?.code || 'UNKNOWN';
  const message = error?.message || 'Unknown error';

  switch (code) {
    case 'QWANT_CAPTCHA':
      return {
        status: 'blocked',
        code,
        title: `${label} is blocking this server's IP address`,
        detail:
          "Qwant's API sits behind DataDome, which answered with a captcha instead of results. DataDome challenges traffic from data-centre IP ranges, so this is about where this server sends its requests from — not about how the provider is configured here. Nothing on this page will change it, and retrying will not either.",
        remediation: [
          'Route the outbound search traffic through an egress IP Qwant accepts — typically an office or residential network rather than cloud hosting.',
          'If this server must stay on its current network, configure Brave Search and select it as the provider instead.',
          'If an outbound HTTP proxy is in use, check whether its exit IP is the one being challenged.'
        ],
        blockedBy: 'datadome',
        retryable: false
      };

    case 'QWANT_RATE_LIMITED':
      return {
        status: 'rate_limited',
        code,
        title: `${label} is rate-limiting this server`,
        detail:
          'The provider accepted the request but asked us to slow down. This is usually temporary and clears on its own.',
        remediation: [
          'Wait a minute and run the test again.',
          "Raise the tool's requestDelayMs if searches are being issued in rapid bursts."
        ],
        blockedBy: null,
        retryable: true
      };

    case 'QWANT_ACCESS_DENIED':
      return {
        status: 'blocked',
        code,
        title: `${label} refused the request`,
        detail: `The provider answered with HTTP 403 and no captcha body. The request reached it, so this is a refusal rather than a network problem. ${message}`,
        remediation: [
          'Run the test again — a refusal without a captcha body is sometimes the first stage of a bot challenge.',
          'If it persists, treat it like a DataDome block: change egress IP, or use Brave Search.'
        ],
        blockedBy: null,
        retryable: true
      };

    case 'QWANT_INVALID_RESPONSE':
      return {
        status: 'error',
        code,
        title: `${label} returned something that is not JSON`,
        detail: `The response body could not be parsed. This usually means an interception page — a captcha, a corporate proxy notice or a login wall — was returned in place of the API response. ${message}`,
        remediation: [
          'Check whether an outbound proxy or filtering appliance is rewriting the response.',
          'Verify that the configured endpoint still points at the provider’s API.'
        ],
        blockedBy: null,
        retryable: true
      };

    case 'STAAN_UNAUTHORIZED':
      return {
        status: 'unconfigured',
        code,
        title: `${label} rejected this server's API key`,
        detail: `The request reached ${label}, so connectivity is fine — the credential was not accepted. ${message}`,
        remediation: [
          'Re-enter the API key on this page — a truncated, rotated or expired key looks exactly like this.',
          'Check the key is still active in the staan.ai dashboard.',
          'If the key is set through STAAN_API_KEY instead, restart the server after changing it.'
        ],
        blockedBy: null,
        retryable: false
      };

    case 'STAAN_RATE_LIMITED':
      return {
        status: 'rate_limited',
        code,
        title: `${label} is rate-limiting this server`,
        detail: `The provider accepted the request but asked us to slow down. ${message}`,
        remediation: [
          'Wait a moment and run the test again.',
          "Raise the staanSearch tool's requestDelayMs if searches are issued in rapid bursts (the documented limit is 20 requests/second)."
        ],
        blockedBy: null,
        retryable: true
      };

    case 'STAAN_BAD_REQUEST':
      return {
        status: 'error',
        code,
        title: `${label} rejected the search request`,
        detail: `The provider answered HTTP 400 and said what was wrong with the request itself. ${message}`,
        remediation: [
          'Try the test with a plain one-word query, which rules out the query as the cause.',
          'If a custom STAAN_SEARCH_ENDPOINT is set, check it still points at the v2 web search endpoint.'
        ],
        blockedBy: null,
        retryable: false
      };

    case 'STAAN_INVALID_RESPONSE':
      return {
        status: 'error',
        code,
        title: `${label} returned something that is not JSON`,
        detail: `The response body could not be parsed. This usually means an interception page — a corporate proxy notice or a login wall — was returned in place of the API response. ${message}`,
        remediation: [
          'Check whether an outbound proxy or filtering appliance is rewriting the response.',
          'Verify that the configured endpoint still points at the provider’s API.'
        ],
        blockedBy: null,
        retryable: true
      };

    case 'NETWORK_ERROR':
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'ETIMEDOUT':
    case 'EAI_AGAIN':
    case 'ENOTFOUND':
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return {
        status: 'network',
        code,
        title: `This server could not reach ${label}`,
        detail: `The request never got an answer. ${message}`,
        remediation: [
          'Check HTTPS_PROXY / HTTP_PROXY / NO_PROXY for this server.',
          'Check ssl.domainWhitelist and proxy.urlPatterns in platform.json.',
          'Confirm the provider’s host is reachable from this network at all.'
        ],
        blockedBy: null,
        retryable: true
      };

    default:
      break;
  }

  // Brave's missing-key error predates the structured codes above.
  if (/api key is not configured/i.test(message)) {
    return {
      status: 'unconfigured',
      code: 'MISSING_API_KEY',
      title: `${label} has no API key configured`,
      detail: `${label} needs a key before it can answer any search.`,
      remediation: [
        `Enter the key on this page, or set the provider's API key environment variable and restart the server.`,
        'Or switch the app to another engine: Staan (also keyed) or Qwant (no API key, but blocked on many cloud hosts).'
      ],
      blockedBy: null,
      retryable: false
    };
  }

  if (code === 'HTTP_401' || code === 'HTTP_403') {
    return {
      status: 'unconfigured',
      code,
      title: `${label} rejected this server's API key`,
      detail: `The provider answered ${code.replace('HTTP_', 'HTTP ')}, which means the request arrived but the credential was not accepted. ${message}`,
      remediation: [
        'Re-enter the API key — a truncated or expired key looks exactly like this.',
        'Check the key is still active in the provider’s own dashboard.'
      ],
      blockedBy: null,
      retryable: false
    };
  }

  if (code === 'HTTP_429') {
    return {
      status: 'rate_limited',
      code,
      title: `${label} is rate-limiting this server`,
      detail: `The provider answered HTTP 429. ${message}`,
      remediation: [
        'Wait a minute and run the test again.',
        'Check the plan’s request-per-second limit against the tool’s requestDelayMs.'
      ],
      blockedBy: null,
      retryable: true
    };
  }

  return {
    status: 'error',
    code,
    title: `${label} search failed`,
    detail: message,
    remediation: ['Check the server log for the full error, which records the provider response.'],
    blockedBy: null,
    retryable: true
  };
}
