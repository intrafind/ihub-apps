// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

/**
 * What the admin UI says below the headline of a failed connection: the facts
 * (upstream HTTP status, host, socket or certificate code) and a translated
 * "what to check" line per cause.
 *
 * Used by the model test (`POST /admin/models/:id/_test`, on the models list
 * and in the providers health check) and the model import
 * (`POST /admin/models/_discover`). Both send the cause as `details.messageKey`
 * and the facts as `details.upstreamStatus`, `details.host` and
 * `details.errorCode` (server/routes/admin/models.js `describeModelTestFailure`,
 * server/services/ModelEndpointDiscovery.js). The server decides the cause; this
 * module only translates it. Kept free of React so it can be unit tested.
 */

/** Where the SSL domain whitelist and "Ignore invalid SSL certificates" are edited. */
export const SSL_SETTINGS_PATH = '/admin/security#settings-section-ssl';

/**
 * Translation key of the remediation line per server `messageKey`. Causes the
 * model test and the import name differently share one line. Causes without an
 * entry keep the server's own (English) text, which carries specifics such as a
 * redirect target.
 */
const REMEDIATION_KEYS = {
  certificateUntrusted: 'admin.connectionErrors.remediation.certificateUntrusted',
  serverError: 'admin.connectionErrors.remediation.serverError',
  authenticationFailed: 'admin.connectionErrors.remediation.authenticationFailed',
  accessDenied: 'admin.connectionErrors.remediation.accessDenied',
  apiKeyRequired: 'admin.connectionErrors.remediation.apiKeyRequired',
  apiKeyNotConfigured: 'admin.connectionErrors.remediation.apiKeyNotConfigured',
  apiKeyUndecryptable: 'admin.connectionErrors.remediation.apiKeyUndecryptable',
  modelNotFound: 'admin.connectionErrors.remediation.wrongPath',
  notFound: 'admin.connectionErrors.remediation.listNotFound',
  connectionRefused: 'admin.connectionErrors.remediation.connectionRefused',
  serviceNotFound: 'admin.connectionErrors.remediation.hostNotFound',
  hostNotFound: 'admin.connectionErrors.remediation.hostNotFound',
  connectionTimeout: 'admin.connectionErrors.remediation.timeout',
  timeout: 'admin.connectionErrors.remediation.timeout',
  requestTimeout: 'admin.connectionErrors.remediation.requestTimeout',
  networkError: 'admin.connectionErrors.remediation.networkError',
  rateLimitExceeded: 'admin.connectionErrors.remediation.rateLimitExceeded'
};

/** English fallbacks of the remediation lines (the i18n files hold the real text). */
const REMEDIATION_FALLBACKS = {
  certificateUntrusted:
    'The iHub server does not trust the TLS certificate of this endpoint, which is typical for a private CA or a self-signed certificate. Add the host to the SSL domain whitelist and turn on "Ignore invalid SSL certificates".',
  serverError:
    'The endpoint itself failed. Check the status and logs of the service (or of a proxy in front of it) and try again; the configuration in iHub is probably correct.',
  authenticationFailed:
    'The endpoint rejected the API key. Check the key on the model or its provider.',
  accessDenied:
    'The endpoint accepted the API key but does not allow this request. Check the permissions of the key and which models the account may use.',
  apiKeyRequired:
    'The endpoint asks for an API key, but none is configured. Enter the key on the provider or the model and try again.',
  apiKeyNotConfigured:
    'No API key is configured. Enter one on the model or its provider, or set the environment variable.',
  apiKeyUndecryptable:
    'The stored API key was saved with a different encryption key. Enter the key again.',
  wrongPath:
    'Nothing was found at this URL. Check the path (it usually ends in /v1/chat/completions) and the model ID.',
  listNotFound:
    'No model list was found at this URL. Check the path: it usually ends in /v1 or /v1/models.',
  connectionRefused:
    'Nothing accepts connections at this host and port. Check the port in the URL and that the service is running.',
  hostNotFound:
    'The host name could not be resolved. Check the spelling of the URL, or the DNS and proxy settings of the iHub server.',
  timeout:
    'The endpoint did not answer in time. Check the URL, that the service is running, and that the iHub server can reach it (firewall, VPN, proxy).',
  requestTimeout:
    'The service took too long to answer. Try again, or check how busy the service is.',
  networkError:
    'The connection failed. Check that the iHub server can reach the host (firewall, VPN, outbound proxy).',
  rateLimitExceeded: 'The endpoint is limiting requests. Wait a moment and try again.'
};

/**
 * @typedef {Object} ConnectionErrorHelp
 * @property {string|null} facts - e.g. "HTTP 502 · Host: llm.example.com · Code: ECONNRESET"
 * @property {string|null} remediation - What to check, translated when the cause is known
 * @property {boolean} showSslSettingsLink - Link to the SSL / TLS settings (untrusted certificate)
 */

/**
 * The facts and the remediation line of a failed connection.
 *
 * @param {(key: string, fallbackOrOptions?: string|Object, options?: Object) => string} t - i18next `t`
 * @param {Object|null|undefined} details - The problem body's `details`
 *   (`messageKey`, `remediation`, `upstreamStatus`, `host`, `errorCode`)
 * @param {string|null} [fallbackRemediation] - Shown when there is neither a
 *   known cause nor a server remediation (e.g. "HTTP 500" from a bare failure)
 * @returns {ConnectionErrorHelp}
 *
 * @example
 *   describeConnectionError(t, { messageKey: 'serverError', upstreamStatus: 502, host: 'llm' })
 *   // → { facts: 'HTTP 502 · Host: llm', remediation: 'The endpoint itself failed…', showSslSettingsLink: false }
 */
export function describeConnectionError(t, details, fallbackRemediation = null) {
  const info = details && typeof details === 'object' ? details : {};
  const facts = [];
  if (Number.isInteger(info.upstreamStatus)) {
    facts.push(
      t('admin.connectionErrors.facts.status', 'HTTP {{status}}', { status: info.upstreamStatus })
    );
  }
  if (typeof info.host === 'string' && info.host) {
    facts.push(t('admin.connectionErrors.facts.host', 'Host: {{host}}', { host: info.host }));
  }
  if (typeof info.errorCode === 'string' && info.errorCode) {
    facts.push(t('admin.connectionErrors.facts.code', 'Code: {{code}}', { code: info.errorCode }));
  }

  const remediationKey = REMEDIATION_KEYS[info.messageKey];
  let remediation = null;
  if (remediationKey) {
    const fallback = REMEDIATION_FALLBACKS[remediationKey.split('.').pop()];
    remediation = t(remediationKey, fallback);
  } else if (typeof info.remediation === 'string' && info.remediation) {
    remediation = info.remediation;
  } else {
    remediation = fallbackRemediation || null;
  }

  return {
    facts: facts.length > 0 ? facts.join(' · ') : null,
    remediation,
    showSslSettingsLink: info.messageKey === 'certificateUntrusted'
  };
}
