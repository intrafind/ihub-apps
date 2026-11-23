// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * The cause of a failed model call, named the same way wherever iHub reports
 * one: the admin model test (`POST /admin/models/:id/_test`) and a failed chat
 * turn (`services/chat/chatErrors.js`, the `cause` of `stream/error` and
 * `run/ended.error`).
 *
 * The server decides the cause; clients only translate its key. The headline
 * and remediation texts here are English and written for administrators (the
 * model test sends them as the problem body); the chat uses only the key and
 * the facts, and decides itself which facts a user may see.
 *
 * @module services/loop/llmFailureCause
 */
import { LLM_ERROR_CODES } from './contracts/errors.js';
import { isMissingApiKeyError } from './llmHttpErrors.js';
import { endpointHost, tlsCertificateErrorCode } from '../../utils/connectionErrors.js';

/** A connection that was never established in time. */
const CONNECTION_TIMEOUT = Object.freeze({
  userMessage: 'Connection timeout',
  messageKey: 'connectionTimeout',
  errorMessage:
    'The model service did not respond within the timeout period. Please check if the model URL is correct and the service is running.'
});

/**
 * Socket-level failure codes (undici / Node `net`, and LLMClient's own
 * `CONNECT_TIMEOUT`) that deserve a dedicated explanation in the admin UI.
 * Checked before the generic code mapping.
 */
const MODEL_TEST_NETWORK_CAUSES = Object.freeze({
  UND_ERR_CONNECT_TIMEOUT: CONNECTION_TIMEOUT,
  // LLMClient's own connect ceiling (`connectTimeoutMs`): a TIMEOUT whose
  // connection was never established, not a slow answer.
  CONNECT_TIMEOUT: CONNECTION_TIMEOUT,
  ECONNREFUSED: {
    userMessage: 'Connection refused',
    messageKey: 'connectionRefused',
    errorMessage:
      'Unable to connect to the model service. Please verify the URL and ensure the service is running.'
  },
  ENOTFOUND: {
    userMessage: 'Service not found',
    messageKey: 'serviceNotFound',
    errorMessage:
      'The model service hostname could not be resolved. Please check the URL configuration.'
  }
});

/**
 * The headline and remediation of an untrusted TLS certificate: a private CA
 * or a self-signed certificate the server has not been told to accept.
 */
const MODEL_TEST_TLS_FAILURE = Object.freeze({
  userMessage: 'Certificate not trusted',
  messageKey: 'certificateUntrusted',
  errorMessage:
    'The TLS certificate of the model service is not trusted by the iHub server (private CA or self-signed certificate). Add the host to the SSL domain whitelist and enable "Ignore invalid SSL certificates" under Admin > Security > SSL / TLS, or install a certificate from a trusted CA on the service.'
});

/** A socket-level error code (`ECONNRESET`, `UND_ERR_SOCKET`), as opposed to a provider's own code. */
const SOCKET_ERROR_CODE = /^(?:E[A-Z]+|UND_ERR_[A-Z_]+)$/;

/**
 * The headline and remediation of a failed model call, without its facts.
 *
 * @param {import('./contracts/errors.js').LLMError} err
 * @param {{ keyless: boolean }} context
 * @returns {{ userMessage: string, errorMessage: string, messageKey: string }}
 */
function describeLlmFailureCause(err, { keyless }) {
  if (tlsCertificateErrorCode(err)) {
    return MODEL_TEST_TLS_FAILURE;
  }

  // `fetch failed` wraps the socket error one level deeper (err.cause.cause);
  // LLMClient also surfaces that code as providerCode for network failures.
  const socketCode = String(err.providerCode || err.cause?.code || err.cause?.cause?.code || '');
  if (MODEL_TEST_NETWORK_CAUSES[socketCode]) {
    return MODEL_TEST_NETWORK_CAUSES[socketCode];
  }

  const fallback = {
    userMessage: 'Model test failed',
    messageKey: 'testFailed',
    errorMessage: err.message || 'Unknown error occurred'
  };

  switch (err.code) {
    case LLM_ERROR_CODES.NETWORK: {
      const detail =
        typeof err.details === 'string' && err.details
          ? err.details
          : err.cause?.message || err.message;
      return {
        userMessage: 'Network error',
        messageKey: 'networkError',
        errorMessage: `Network connection failed: ${detail}`
      };
    }
    case LLM_ERROR_CODES.TIMEOUT:
      return {
        userMessage: 'Request timeout',
        messageKey: 'requestTimeout',
        errorMessage:
          'The model service took too long to respond. Please try again or check the service status.'
      };
    case LLM_ERROR_CODES.AUTH_FAILED:
      if (err.providerCode === 'API_KEY_UNDECRYPTABLE') {
        return {
          userMessage: 'Stored API key cannot be decrypted',
          messageKey: 'apiKeyUndecryptable',
          errorMessage: err.message
        };
      }
      if (isMissingApiKeyError(err)) {
        return {
          userMessage: 'API key not configured',
          messageKey: 'apiKeyNotConfigured',
          errorMessage: err.message
        };
      }
      // No key was sent, so none can have been rejected: the endpoint wants one.
      if (keyless) {
        return {
          userMessage: 'The endpoint requires an API key',
          messageKey: 'apiKeyRequired',
          errorMessage:
            'No API key is configured for this model, and the model service asked for one. Enter the key on the model or its provider and test again.'
        };
      }
      if (err.status === 403) {
        return {
          userMessage: 'Access denied',
          messageKey: 'accessDenied',
          errorMessage: 'Access denied by the model service. Please check your API key permissions.'
        };
      }
      return {
        userMessage: 'Authentication failed',
        messageKey: 'authenticationFailed',
        errorMessage:
          'Invalid API key or authentication credentials. Please check your model configuration.'
      };
    case LLM_ERROR_CODES.MODEL_NOT_FOUND:
      return {
        userMessage: 'Model not found',
        messageKey: 'modelNotFound',
        errorMessage:
          'Nothing was found at the model URL. Check the URL path (it usually ends in /v1/chat/completions) and the model ID.'
      };
    case LLM_ERROR_CODES.RATE_LIMITED:
      return {
        userMessage: 'Rate limit exceeded',
        messageKey: 'rateLimitExceeded',
        errorMessage: 'Too many requests to the model service. Please try again later.'
      };
    default:
      // An upstream 5xx under a code that names no cause of its own
      // (PROVIDER_ERROR, or a provider code the client does not map).
      if (typeof err.status === 'number' && err.status >= 500) {
        return {
          userMessage: 'Server error',
          messageKey: 'serverError',
          errorMessage:
            'The model service itself failed to answer. Check its status and logs; the configuration in iHub is probably correct. Try again later.'
        };
      }
      return fallback;
  }
}

/**
 * Translate a failed model call (`LLMError`) into what the UI shows: a short
 * `userMessage` headline (English, used as a fallback and in logs), an
 * `errorMessage` with remediation hints (English; the client
 * shows its own translation per `messageKey`), a `messageKey` — a stable
 * identifier the client maps to a translated headline (see shared/i18n/*.json
 * `admin.models.testResults.messages`) — and the facts that help the admin
 * find the fault: the upstream HTTP status, the host that was called and the
 * socket or certificate error code.
 *
 * Keys off `err.code` (and the underlying socket or certificate error code for
 * network failures) — never off provider message substrings, which differ per
 * provider and language. Never returns credentials, a URL path or a query.
 *
 * @param {import('./contracts/errors.js').LLMError} err
 * @param {Object} [context]
 * @param {string} [context.url] - The model's endpoint URL; only its host is reported
 * @param {boolean} [context.keyless=false] - The model runs without an API key
 *   (key status `keyless`), so a 401/403 means "a key is required", not "rejected"
 * @returns {{ userMessage: string, errorMessage: string, messageKey: string,
 *   upstreamStatus: number|null, host: string|null, errorCode: string|null }}
 *
 * @example
 *   describeLlmFailure(err, { url: 'https://llm.example.com/v1/chat/completions' })
 *   // → { messageKey: 'serverError', upstreamStatus: 503, host: 'llm.example.com', … }
 */
export function describeLlmFailure(err, { url, keyless = false } = {}) {
  const providerCode = typeof err.providerCode === 'string' ? err.providerCode : '';
  const socketCode = [providerCode, err.cause?.code, err.cause?.cause?.code].find(
    code => typeof code === 'string' && SOCKET_ERROR_CODE.test(code)
  );
  return {
    ...describeLlmFailureCause(err, { keyless }),
    upstreamStatus: typeof err.status === 'number' ? err.status : null,
    host: endpointHost(url),
    errorCode: tlsCertificateErrorCode(err) || socketCode || null
  };
}

/**
 * The sentence a run's ledger keeps for a failed model call: the cause's
 * headline (`Service not found`, `Connection timeout`, `Server error`), or
 * the error code when no cause is recognized. Never the raw failure text: a
 * socket message names the host (`getaddrinfo ENOTFOUND llm.corp.local`) and
 * a provider error carries the provider's body, and the ledger is replayed to
 * the run's owner (`GET /api/runs/:runId/events`), who need not be an admin.
 * The raw text goes to the server log (`LLMClient._recordError`).
 *
 * @param {import('./contracts/errors.js').LLMError} err
 * @returns {string}
 * @example
 *   ledgerErrorMessage(dnsError); // → 'Service not found'
 */
export function ledgerErrorMessage(err) {
  const code = String(err?.code || 'ERROR');
  if (code === LLM_ERROR_CODES.ABORTED) return 'The model call was stopped';
  const { messageKey, userMessage } = describeLlmFailureCause(err || {}, { keyless: false });
  return messageKey === 'testFailed' ? `The model call failed (${code})` : userMessage;
}
