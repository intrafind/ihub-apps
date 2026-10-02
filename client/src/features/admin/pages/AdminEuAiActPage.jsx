import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowDownTrayIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import { getAdminApiErrorMessage } from '../../../api/adminApi';
import { downloadComplianceReport } from '../../../api/aiTransparencyAdminApi';
import AdminTabs from '../components/AdminTabs';
import { ConformancePill } from '../components/euAiAct/ComplianceBadges';
import OverviewTab from '../components/euAiAct/OverviewTab';
import ModelsTab from '../components/euAiAct/ModelsTab';
import AppsTab from '../components/euAiAct/AppsTab';
import SettingsTab from '../components/euAiAct/SettingsTab';
import CertificatesTab from '../components/euAiAct/CertificatesTab';
import DetectionTab from '../components/euAiAct/DetectionTab';
import { useAiTransparencyStatus } from '../hooks/useAiTransparencyStatus';
import {
  DEFAULT_EU_AI_ACT_TAB,
  EU_AI_ACT_TABS,
  formatDateTime,
  resolveEuAiActTab,
  splitWarnings
} from '../utils/euAiAct';

/** Prefix of the tab/panel element ids (see AdminTabs). */
const TAB_ID_PREFIX = 'euaiact-';

/** Tab id → panel component. Every panel gets `{ status, reload }`. */
const TAB_PANELS = {
  overview: OverviewTab,
  models: ModelsTab,
  apps: AppsTab,
  settings: SettingsTab,
  certificates: CertificatesTab,
  detection: DetectionTab
};

/** English fallbacks of the tab labels (`admin.euAiAct.tabs.<id>`). */
const TAB_LABEL_FALLBACKS = {
  overview: 'Overview',
  models: 'Models',
  apps: 'Apps',
  settings: 'Settings',
  certificates: 'Certificates',
  detection: 'Detection'
};

const SECONDARY_BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 shadow-xs hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 disabled:opacity-50 disabled:cursor-not-allowed';
const PRIMARY_BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white shadow-xs hover:bg-indigo-700 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * Admin page `/admin/eu-ai-act` (concept §8.6, issue #2566): the EU AI Act
 * Art. 50 conformance of this installation.
 *
 * The page owns the status (`GET /admin/ai-transparency/status`) and the tab
 * selection (`?tab=overview|models|apps|settings|certificates|detection`, so
 * the checklist's "Fix" links such as `/admin/eu-ai-act?tab=settings` open the
 * right tab). Each tab receives `{ status, reload }` and calls `reload()`
 * after it changed something.
 *
 * The header shows the overall conformance, the installation identity and
 * the signed compliance report download (`GET /admin/ai-transparency/report.pdf`).
 */
function AdminEuAiActPage() {
  const { t, i18n } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { status, loading, refreshing, error, reload } = useAiTransparencyStatus();
  const [downloading, setDownloading] = useState(false);
  const [downloadMessage, setDownloadMessage] = useState(null);

  const activeTab = resolveEuAiActTab(searchParams.get('tab'));
  const ActivePanel = TAB_PANELS[activeTab];
  const activeWarningCount = status ? splitWarnings(status).active.length : undefined;

  const tabs = EU_AI_ACT_TABS.map(id => ({
    id,
    label: t(`admin.euAiAct.tabs.${id}`, TAB_LABEL_FALLBACKS[id]),
    count: id === 'overview' && activeWarningCount ? activeWarningCount : undefined
  }));

  /**
   * Select a tab. Only `tab` is kept in the query: parameters a previous tab
   * put there belong to that tab. The overview is the default and has none.
   * @param {string} id
   */
  const handleTabChange = id => {
    if (id === activeTab) return;
    const next = new URLSearchParams();
    if (id !== DEFAULT_EU_AI_ACT_TAB) next.set('tab', id);
    setSearchParams(next, { replace: true });
  };

  const handleDownloadReport = async () => {
    setDownloading(true);
    setDownloadMessage(null);
    try {
      const filename = await downloadComplianceReport();
      setDownloadMessage({
        type: 'success',
        text: t('admin.euAiAct.report.downloaded', 'Compliance report saved as {{filename}}.', {
          filename
        })
      });
    } catch (err) {
      setDownloadMessage({
        type: 'error',
        text: t(
          'admin.euAiAct.report.error',
          'The compliance report could not be created: {{error}}',
          {
            error: getAdminApiErrorMessage(err)
          }
        )
      });
    } finally {
      setDownloading(false);
    }
  };

  const installation = status?.installation || {};

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Header */}
      <header className="mb-6">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {t('admin.euAiAct.title', 'EU AI Act')}
              </h1>
              {status && <ConformancePill conforming={Boolean(status.conforming)} size="md" />}
            </div>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {t(
                'admin.euAiAct.subtitle',
                'Art. 50 transparency of this installation: conformance status, records and settings.'
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => reload()}
              disabled={refreshing}
              className={SECONDARY_BUTTON}
            >
              <ArrowPathIcon
                className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              {refreshing
                ? t('admin.euAiAct.refreshing', 'Refreshing…')
                : t('admin.euAiAct.refresh', 'Refresh')}
            </button>
            <button
              type="button"
              onClick={handleDownloadReport}
              disabled={downloading}
              className={PRIMARY_BUTTON}
            >
              <ArrowDownTrayIcon className="h-4 w-4" aria-hidden="true" />
              {downloading
                ? t('admin.euAiAct.report.downloading', 'Creating report…')
                : t('admin.euAiAct.report.download', 'Download compliance report')}
            </button>
          </div>
        </div>

        {status && (
          <dl className="mt-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-x-6 gap-y-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3 text-sm">
            <div className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {t('admin.euAiAct.installation.id', 'Installation ID')}
              </dt>
              <dd className="font-mono text-gray-900 dark:text-gray-100 break-all">
                {installation.installationId || '—'}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {t('admin.euAiAct.installation.url', 'Installation URL')}
              </dt>
              <dd className="text-gray-900 dark:text-gray-100 break-all">
                {installation.installationUrl || '—'}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {t('admin.euAiAct.installation.version', 'iHub version')}
              </dt>
              <dd className="text-gray-900 dark:text-gray-100">
                {installation.ihubVersion || '—'}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
                {t('admin.euAiAct.installation.generatedAt', 'Status as of')}
              </dt>
              <dd className="text-gray-900 dark:text-gray-100">
                {formatDateTime(status.generatedAt, i18n.language) || '—'}
              </dd>
            </div>
          </dl>
        )}

        <div aria-live="polite" role="status">
          {downloadMessage && (
            <p
              className={`mt-3 text-sm ${
                downloadMessage.type === 'success'
                  ? 'text-green-700 dark:text-green-400'
                  : 'text-red-700 dark:text-red-400'
              }`}
            >
              {downloadMessage.text}
            </p>
          )}
        </div>
      </header>

      {loading && !status ? (
        <div className="flex items-center justify-center py-12" role="status">
          <div
            className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"
            aria-hidden="true"
          />
          <span className="ml-3 text-gray-600 dark:text-gray-400">
            {t('common.loading', 'Loading...')}
          </span>
        </div>
      ) : !status ? (
        <div
          role="alert"
          className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/30 p-4"
        >
          <p className="text-sm font-medium text-red-800 dark:text-red-200">
            {t('admin.euAiAct.loadError', 'The EU AI Act status could not be loaded.')}
          </p>
          {error && <p className="mt-1 text-sm text-red-700 dark:text-red-300">{error}</p>}
          <button type="button" onClick={() => reload()} className={`${SECONDARY_BUTTON} mt-3`}>
            {t('admin.euAiAct.retry', 'Try again')}
          </button>
        </div>
      ) : (
        <>
          {error && (
            <div
              role="alert"
              className="mb-4 rounded-md border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/30 px-4 py-3 text-sm text-amber-900 dark:text-amber-200"
            >
              {t(
                'admin.euAiAct.refreshError',
                'Refreshing the status failed; showing the last loaded status. {{error}}',
                { error }
              )}
            </div>
          )}

          <AdminTabs
            tabs={tabs}
            activeId={activeTab}
            onChange={handleTabChange}
            ariaLabel={t('admin.euAiAct.tabs.aria', 'EU AI Act sections')}
            idPrefix={TAB_ID_PREFIX}
            activation="automatic"
          />

          <div
            role="tabpanel"
            id={`${TAB_ID_PREFIX}tabpanel-${activeTab}`}
            aria-labelledby={`${TAB_ID_PREFIX}tab-${activeTab}`}
            // Focusable so keyboard users can move from the tab into the panel
            // even when it starts with static content.
            tabIndex={0}
            className="focus:outline-hidden"
          >
            <ActivePanel status={status} reload={reload} />
          </div>
        </>
      )}
    </div>
  );
}

export default AdminEuAiActPage;
