import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';

/**
 * Renders the outcome of a web search provider connectivity test.
 *
 * Presentational only — it takes the server's response as-is so the providers
 * list and the provider edit page show one identical verdict. The server
 * classifies (services/search/searchDiagnostics.js); this decides how loudly to
 * say it.
 *
 * The distinction the whole panel exists to draw: a DataDome block is not a
 * misconfiguration. It is reported as its own state, with the outbound path
 * shown next to it, because the egress IP is the thing an admin has to change —
 * no amount of editing the provider on this page will help.
 */

/** Diagnosis status → how the panel presents it. */
const STATUS_STYLES = {
  ok: {
    container: 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800',
    icon: 'CheckCircleIcon',
    iconColor: 'text-green-600 dark:text-green-400',
    title: 'text-green-900 dark:text-green-100'
  },
  empty: {
    container: 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800',
    icon: 'ExclamationTriangleIcon',
    iconColor: 'text-yellow-600 dark:text-yellow-400',
    title: 'text-yellow-900 dark:text-yellow-100'
  },
  blocked: {
    container: 'bg-orange-50 dark:bg-orange-900/20 border-orange-200 dark:border-orange-800',
    icon: 'shield-exclamation',
    iconColor: 'text-orange-600 dark:text-orange-400',
    title: 'text-orange-900 dark:text-orange-100'
  },
  rate_limited: {
    container: 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800',
    icon: 'clock',
    iconColor: 'text-yellow-600 dark:text-yellow-400',
    title: 'text-yellow-900 dark:text-yellow-100'
  },
  unconfigured: {
    container: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800',
    icon: 'KeyIcon',
    iconColor: 'text-blue-600 dark:text-blue-400',
    title: 'text-blue-900 dark:text-blue-100'
  },
  network: {
    container: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800',
    icon: 'x-circle',
    iconColor: 'text-red-600 dark:text-red-400',
    title: 'text-red-900 dark:text-red-100'
  },
  error: {
    container: 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800',
    icon: 'x-circle',
    iconColor: 'text-red-600 dark:text-red-400',
    title: 'text-red-900 dark:text-red-100'
  }
};

function WebsearchTestResult({ result }) {
  const { t } = useTranslation();

  if (!result) return null;

  const diagnosis = result.diagnosis || {};
  const style = STATUS_STYLES[diagnosis.status] || STATUS_STYLES.error;
  const remediation = Array.isArray(diagnosis.remediation) ? diagnosis.remediation : [];
  const samples = Array.isArray(result.results) ? result.results : [];
  const environment = result.environment || {};

  return (
    <div className={`rounded-lg border p-4 ${style.container}`}>
      <div className="flex items-start gap-3">
        <Icon name={style.icon} className={`w-5 h-5 mt-0.5 shrink-0 ${style.iconColor}`} />
        <div className="min-w-0 flex-1 space-y-3">
          <div>
            <p className={`text-sm font-semibold ${style.title}`}>{diagnosis.title}</p>
            <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">{diagnosis.detail}</p>
          </div>

          {/* Bot protection gets its own line: it is the one outcome an admin
              can misread as "the integration is broken". */}
          {diagnosis.blockedBy && (
            <div className="inline-flex items-center gap-1.5 rounded-full bg-orange-100 dark:bg-orange-900/50 px-2.5 py-0.5 text-xs font-medium text-orange-800 dark:text-orange-200">
              <Icon name="shield-exclamation" className="w-3.5 h-3.5" />
              {t(
                'admin.providers.websearchTest.blockedBy',
                'Blocked by {{vendor}} bot protection',
                {
                  vendor: diagnosis.blockedBy === 'datadome' ? 'DataDome' : diagnosis.blockedBy
                }
              )}
            </div>
          )}

          {remediation.length > 0 && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {t('admin.providers.websearchTest.whatToDo', 'What to do')}
              </p>
              <ul className="mt-1.5 space-y-1">
                {remediation.map((step, idx) => (
                  <li
                    key={idx}
                    className="flex gap-2 text-sm text-gray-700 dark:text-gray-300 before:content-['•'] before:text-gray-400"
                  >
                    <span>{step}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {samples.length > 0 && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {t('admin.providers.websearchTest.sampleResults', 'Sample results')}
              </p>
              <ul className="mt-1.5 space-y-1.5">
                {samples.map((sample, idx) => (
                  <li key={idx} className="text-sm">
                    <span className="font-medium text-gray-900 dark:text-gray-100">
                      {sample.title}
                    </span>
                    <span className="block truncate text-xs text-gray-500 dark:text-gray-400">
                      {sample.url}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* The outbound path, because that — not the provider record — is
              what decides whether a bot-protection block happens. */}
          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-gray-500 dark:text-gray-400">
            <div className="flex gap-1">
              <dt>{t('admin.providers.websearchTest.query', 'Query')}:</dt>
              <dd className="font-mono text-gray-700 dark:text-gray-300">{result.query}</dd>
            </div>
            <div className="flex gap-1">
              <dt>{t('admin.providers.websearchTest.results', 'Results')}:</dt>
              <dd className="text-gray-700 dark:text-gray-300">{result.resultCount ?? 0}</dd>
            </div>
            <div className="flex gap-1">
              <dt>{t('admin.providers.websearchTest.duration', 'Took')}:</dt>
              <dd className="text-gray-700 dark:text-gray-300">{result.durationMs}ms</dd>
            </div>
            {environment.endpoint && (
              <div className="flex gap-1">
                <dt>{t('admin.providers.websearchTest.endpoint', 'Endpoint')}:</dt>
                <dd className="font-mono text-gray-700 dark:text-gray-300">
                  {environment.endpoint}
                </dd>
              </div>
            )}
            <div className="flex gap-1">
              <dt>{t('admin.providers.websearchTest.egress', 'Egress')}:</dt>
              <dd className="font-mono text-gray-700 dark:text-gray-300">
                {environment.proxyEnabled
                  ? environment.proxy
                  : t('admin.providers.websearchTest.egressDirect', 'direct (no proxy)')}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}

export default WebsearchTestResult;
