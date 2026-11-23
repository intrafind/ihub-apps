// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * Translation for `POST /admin/models/:id/_test` result headlines.
 *
 * The backend (`describeLlmFailure` in server/services/loop/llmFailureCause.js)
 * sends a stable `messageKey` alongside its English `message`/`error` text.
 * Map that key to a translation rather than the English text itself — the
 * text differs per provider/network cause and is not meant to double as an
 * i18n key.
 */
const MODEL_TEST_MESSAGE_I18N_KEYS = {
  testSuccessful: 'admin.models.testResults.messages.testSuccessful',
  testFailed: 'admin.models.testResults.messages.testFailed',
  connectionTimeout: 'admin.models.testResults.messages.connectionTimeout',
  connectionRefused: 'admin.models.testResults.messages.connectionRefused',
  serviceNotFound: 'admin.models.testResults.messages.serviceNotFound',
  networkError: 'admin.models.testResults.messages.networkError',
  requestTimeout: 'admin.models.testResults.messages.requestTimeout',
  apiKeyNotConfigured: 'admin.models.testResults.messages.apiKeyNotConfigured',
  apiKeyUndecryptable: 'admin.models.testResults.messages.apiKeyUndecryptable',
  accessDenied: 'admin.models.testResults.messages.accessDenied',
  authenticationFailed: 'admin.models.testResults.messages.authenticationFailed',
  modelNotFound: 'admin.models.testResults.messages.modelNotFound',
  rateLimitExceeded: 'admin.models.testResults.messages.rateLimitExceeded',
  serverError: 'admin.models.testResults.messages.serverError',
  apiKeyRequired: 'admin.models.testResults.messages.apiKeyRequired',
  certificateUntrusted: 'admin.models.testResults.messages.certificateUntrusted'
};

/**
 * @param {(key: string, fallback: string) => string} t - i18next `t`
 * @param {string|undefined} messageKey - stable key from the test response
 * @param {string} fallbackMessage - raw backend text, used when there is no
 *   key or the key isn't recognized (e.g. an older server build)
 * @returns {string}
 */
export function translateModelTestMessage(t, messageKey, fallbackMessage) {
  const i18nKey = messageKey ? MODEL_TEST_MESSAGE_I18N_KEYS[messageKey] : undefined;
  return i18nKey ? t(i18nKey, fallbackMessage) : fallbackMessage;
}

/**
 * @typedef {Object} ModelTestResult
 * @property {boolean} success - The model answered.
 * @property {string} [response] - Its answer, on success.
 * @property {string} [message] - Translated headline of a failure.
 * @property {Object|null} [details] - The server's failure details (`messageKey`, `remediation`,
 *   `upstreamStatus`, `host`, `errorCode`), shown by `ConnectionErrorDetails`.
 * @property {string} [error] - The HTTP status or network message, when there are no details.
 */

/**
 * Runs `POST /admin/models/{id}/_test` against the model as it is stored, and
 * turns the answer into what the list and the editor show.
 *
 * The test endpoint maps a provider rejecting the server's key onto 502 (not
 * 401), so the shared admin client is safe here: a 401 really is an expired
 * admin session and goes through the global re-authentication flow.
 *
 * @param {string} modelId
 * @param {(key: string, fallback?: string) => string} t - i18next `t`
 * @param {(url: string, options?: Object) => Promise<{data?: Object}>} request - `makeAdminApiCall`
 * @returns {Promise<ModelTestResult>} Never rejects: a failed test is a result.
 */
export async function runModelTest(modelId, t, request) {
  try {
    const response = await request(`/admin/models/${encodeURIComponent(modelId)}/_test`, {
      method: 'POST'
    });
    // A failed test is an HTTP error (the catch below); an answer is a passed test.
    return { ...(response?.data || {}), success: true };
  } catch (err) {
    // Server body: { detail: headline, code, details: { messageKey, remediation,
    // upstreamStatus?, host?, errorCode? } }
    const body = err?.response?.data || {};
    const fallbackMessage = body.detail || t('admin.models.testResults.failed', 'Test Failed');
    return {
      success: false,
      message: translateModelTestMessage(t, body.details?.messageKey, fallbackMessage),
      details: body.details || null,
      error: err?.response?.status ? `HTTP ${err.response.status}` : err?.message
    };
  }
}
