// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Icon from '../../../../shared/components/Icon';
import { apiTypeLabel } from '../../utils/modelImport';
import { hostOf } from '../../utils/providerConnect';
import { LINK_BUTTON, SECONDARY_BUTTON, STEP_INTRO, STEP_TITLE } from './connectStyles';

/**
 * What to check for each cause of a failed test, and the one action that fixes it.
 *
 * @param {Function} t
 * @param {string} category - `classifyConnectionError` result
 */
function causeAdvice(t, category) {
  return {
    unreachable: t(
      'admin.providers.connect.test.causes.unreachable',
      'The iHub server could not reach the host. Check the host name and port, and that the server (not your browser) can reach it through your network, firewall or proxy.'
    ),
    tls: t(
      'admin.providers.connect.test.causes.tls',
      'The endpoint presents a certificate the iHub server does not trust, which is usual for a private CA. Add the host to the SSL whitelist under Security, or install the CA on the server.'
    ),
    auth: t(
      'admin.providers.connect.test.causes.auth',
      'The endpoint rejected the key. Check that it is the key for this endpoint and that it may list models.'
    ),
    path: t(
      'admin.providers.connect.test.causes.path',
      'The host answered, but not with a model list at this path. Check the URL; it usually ends in /v1.'
    ),
    other: t(
      'admin.providers.connect.test.causes.other',
      'Check the URL and the key, then test again.'
    )
  }[category];
}

/**
 * Step 3, the connection test: lists the endpoint's models through
 * `POST /admin/models/_discover` (run by the page) and shows status, host and
 * model count — or the cause of the failure with the setting that fixes it.
 *
 * @param {Object} props
 * @param {boolean} props.testing
 * @param {Object|null} props.discovery - `_discover` response on success
 * @param {{ message: string, remediation?: string, category: string }|null} props.error
 * @param {string} props.url - URL that was tested
 * @param {() => void} props.onRetry
 * @param {() => void} props.onEditConnection - Back to step 2
 */
function TestStep({ testing, discovery, error, url, onRetry, onEditConnection }) {
  const { t } = useTranslation();
  const host = hostOf(discovery?.modelsUrl || url);
  const chatCount = (discovery?.models || []).filter(m => m.type === 'chat').length;

  return (
    <div className="space-y-4">
      <div>
        <h2 className={STEP_TITLE}>
          {t('admin.providers.connect.test.title', 'Test the connection')}
        </h2>
        <p className={STEP_INTRO}>
          {t(
            'admin.providers.connect.test.intro',
            'iHub asks the endpoint for its model list from the server, with the key you entered.'
          )}
        </p>
      </div>

      {testing && (
        <div
          role="status"
          className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300"
        >
          <Icon name="refresh" className="h-4 w-4 animate-spin" />
          {t('admin.providers.connect.test.running', 'Connecting to {{host}}…', { host })}
        </div>
      )}

      {!testing && discovery && (
        <div
          role="status"
          data-testid="connect-test-success"
          className="rounded-md border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/30 p-4"
        >
          <p className="flex items-center gap-2 text-sm font-medium text-green-800 dark:text-green-300">
            <Icon name="check-circle" className="h-5 w-5" />
            {t('admin.providers.connect.test.success', 'Connected')}
          </p>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-green-900 dark:text-green-200">
            <dt className="font-medium">{t('admin.providers.connect.test.host', 'Host')}</dt>
            <dd className="break-all">{host}</dd>
            {discovery.region && (
              <>
                <dt className="font-medium">
                  {t('admin.providers.connect.connection.region', 'AWS region')}
                </dt>
                <dd>{discovery.region}</dd>
              </>
            )}
            <dt className="font-medium">{t('admin.providers.connect.test.models', 'Models')}</dt>
            <dd>
              {t(
                'admin.providers.connect.test.modelCount',
                '{{count}} listed, {{chat}} chat models',
                {
                  count: discovery.models.length,
                  chat: chatCount
                }
              )}
            </dd>
            <dt className="font-medium">{t('admin.providers.fields.apiType', 'API type')}</dt>
            <dd>
              {discovery.gateway
                ? t('admin.providers.gateway.ifinder', 'iFinder Model Gateway')
                : apiTypeLabel(t, discovery.apiType)}
              {discovery.azure && ' (Azure OpenAI)'}
            </dd>
          </dl>
          {discovery.models.length === 0 && (
            <p className="mt-2 text-sm text-amber-800 dark:text-amber-300">
              {t(
                'admin.providers.connect.test.noModels',
                'The endpoint lists no models. Check that models are deployed, or that the key may see them.'
              )}
            </p>
          )}
        </div>
      )}

      {!testing && error && (
        <div
          role="alert"
          data-testid="connect-test-error"
          className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 p-4"
        >
          <p className="text-sm font-medium text-red-800 dark:text-red-300">{error.message}</p>
          {error.remediation && (
            <p className="mt-1 text-sm text-red-700 dark:text-red-400">{error.remediation}</p>
          )}
          <p className="mt-2 text-sm text-red-700 dark:text-red-400">
            {causeAdvice(t, error.category)}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button type="button" className={SECONDARY_BUTTON} onClick={onRetry}>
              {t('admin.providers.connect.test.retry', 'Test again')}
            </button>
            {error.category === 'tls' ? (
              <Link to="/admin/security" className={LINK_BUTTON}>
                {t('admin.providers.connect.test.openSsl', 'Open the SSL whitelist')}
              </Link>
            ) : (
              <button type="button" className={LINK_BUTTON} onClick={onEditConnection}>
                {error.category === 'auth'
                  ? t('admin.providers.connect.test.changeKey', 'Change the key')
                  : t('admin.providers.connect.test.changeConnection', 'Change the URL or key')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default TestStep;
