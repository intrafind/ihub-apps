// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the chat says when a model call failed and the server named its cause.
 *
 * The server decides the cause (`failureCause` on `stream/error`,
 * `run/ended.error` and a stored message's `error`; see
 * server/services/chat/chatErrors.js) with the same keys the admin model test
 * uses. This module only translates the key, so an end user reads "the
 * service's certificate is not trusted" instead of "openai API service error".
 * A cause it does not know keeps the server's message. Kept free of React so
 * it can be unit tested.
 */

/**
 * Translation key and English fallback of the chat message per server cause.
 * Written for end users: no host, no setting, and "tell your administrator"
 * where only an administrator can fix it.
 */
const FAILURE_CAUSE_MESSAGES = Object.freeze({
  certificateUntrusted: [
    'chat.failureCause.certificateUntrusted',
    'The AI model could not be reached securely: the iHub server does not trust the certificate of its service. Please tell your administrator.'
  ],
  serverError: [
    'chat.failureCause.serverError',
    'The service of the AI model failed to answer. The fault is on the side of the service; please try again later.'
  ],
  authenticationFailed: [
    'chat.failureCause.authenticationFailed',
    'The service of the AI model rejected the API key configured in iHub. Please tell your administrator.'
  ],
  accessDenied: [
    'chat.failureCause.accessDenied',
    'The service of the AI model does not allow this request with the configured API key. Please tell your administrator.'
  ],
  apiKeyRequired: [
    'chat.failureCause.apiKeyRequired',
    'The service of the AI model requires an API key, but none is configured for this model. Please tell your administrator.'
  ],
  apiKeyNotConfigured: [
    'chat.failureCause.apiKeyNotConfigured',
    'No API key is configured for this AI model. Please tell your administrator.'
  ],
  apiKeyUndecryptable: [
    'chat.failureCause.apiKeyUndecryptable',
    'The API key stored for this AI model can no longer be read. Please tell your administrator.'
  ],
  modelNotFound: [
    'chat.failureCause.modelNotFound',
    'The service does not offer the configured AI model. Please tell your administrator.'
  ],
  rateLimitExceeded: [
    'chat.failureCause.rateLimitExceeded',
    'The service of the AI model is receiving too many requests. Please wait a moment and try again.'
  ],
  connectionTimeout: [
    'chat.failureCause.unreachable',
    'The service of the AI model could not be reached. Please try again later, or tell your administrator if it persists.'
  ],
  connectionRefused: [
    'chat.failureCause.unreachable',
    'The service of the AI model could not be reached. Please try again later, or tell your administrator if it persists.'
  ],
  serviceNotFound: [
    'chat.failureCause.unreachable',
    'The service of the AI model could not be reached. Please try again later, or tell your administrator if it persists.'
  ],
  networkError: [
    'chat.failureCause.unreachable',
    'The service of the AI model could not be reached. Please try again later, or tell your administrator if it persists.'
  ],
  requestTimeout: [
    'chat.failureCause.timeout',
    'The service of the AI model took too long to answer. Please try again.'
  ]
});

/**
 * The translated chat message of a failure the server named a cause for.
 *
 * @param {(key: string, fallback?: string) => string} t - i18next `t`
 * @param {Object|null|undefined} error - `run.error`, a `stream/error` payload or
 *   a hydrated message's failure (`{ failureCause }`)
 * @returns {string|null} The message, or null for no or an unknown cause
 *   (the caller keeps the server's message)
 *
 * @example
 *   failureCauseMessage(t, { failureCause: 'certificateUntrusted' })
 *   // → 'The AI model could not be reached securely: …'
 */
export function failureCauseMessage(t, error) {
  const entry = FAILURE_CAUSE_MESSAGES[error?.failureCause];
  if (!entry) return null;
  const [key, fallback] = entry;
  return t(key, fallback);
}

/**
 * The failure facts a message keeps for its diagnostics, in the shape the
 * admin's `ConnectionErrorDetails` reads (`messageKey`, `upstreamStatus`,
 * `host`, `errorCode`). `host` and `errorCode` are there only when the server
 * sent them, which it does for an administrator alone.
 *
 * @param {Object|null|undefined} error - `run.error` or a stored message error
 * @returns {{ messageKey: string, upstreamStatus?: number, host?: string,
 *   errorCode?: string }|null} null when the server named no cause
 */
export function failureDiagnostics(error) {
  if (typeof error?.failureCause !== 'string' || !error.failureCause) return null;
  return {
    messageKey: error.failureCause,
    ...(Number.isInteger(error.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}),
    ...(typeof error.host === 'string' && error.host ? { host: error.host } : {}),
    ...(typeof error.errorCode === 'string' && error.errorCode
      ? { errorCode: error.errorCode }
      : {})
  };
}
