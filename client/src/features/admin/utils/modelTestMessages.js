/**
 * Translation for `POST /admin/models/:id/test` result headlines.
 *
 * The backend (`describeModelTestFailure` in server/routes/admin/models.js)
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
  accessDenied: 'admin.models.testResults.messages.accessDenied',
  authenticationFailed: 'admin.models.testResults.messages.authenticationFailed',
  modelNotFound: 'admin.models.testResults.messages.modelNotFound',
  rateLimitExceeded: 'admin.models.testResults.messages.rateLimitExceeded',
  serverError: 'admin.models.testResults.messages.serverError'
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
