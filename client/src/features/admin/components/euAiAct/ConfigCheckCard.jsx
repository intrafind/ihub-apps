// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AdminLoadError from '../AdminLoadError';
import Badge from '../../../../shared/components/Badge';
import Icon from '../../../../shared/components/Icon';
import CheckStatus from './CheckStatus';
import EuAiActCard from './EuAiActCard';

const ORDER = { error: 0, warn: 1, ok: 2 };
const byLevel = (a, b) => ORDER[a.level] - ORDER[b.level];

/** A fix link keeps the in-page anchor (`/admin/eu-ai-act#watermark-keys`) as a hash. */
function FixLink({ fix, label }) {
  const { t } = useTranslation();
  const text = t(fix.labelKey, 'Open');
  const [pathname, hash] = fix.href.split('#');
  return (
    <Link
      to={{ pathname, hash: hash ? `#${hash}` : '' }}
      aria-label={`${text}: ${label}`}
      className="ml-auto text-sm font-medium text-indigo-700 dark:text-indigo-300 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-500 rounded-sm"
    >
      {text}
      <Icon name="arrow-right" size="sm" className="inline ml-1" />
    </Link>
  );
}

function CheckRow({ check }) {
  const { t } = useTranslation();
  const label = t(check.messageKey, check.message, check.params);
  return (
    <li data-check-id={check.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
      <CheckStatus level={check.level} className="w-24 sm:w-28 justify-center" />
      <span className="text-sm text-gray-900 dark:text-gray-100 min-w-0 flex-1">{label}</span>
      {check.fix && <FixLink fix={check.fix} label={label} />}
    </li>
  );
}

/**
 * Card 1: the traffic-light list. The server decides every level and sentence;
 * this only renders them, worst first.
 */
export default function ConfigCheckCard({ status, loading, error, checking, onRecheck }) {
  const { t } = useTranslation();
  const paused = status?.summary?.level === 'disabled';
  const counts = paused ? null : status?.summary?.counts;
  const checks = [...(status?.checks || [])].sort(byLevel);

  const summary = counts && (
    <div className="flex flex-wrap gap-2">
      {counts.error > 0 && (
        <Badge tone="danger" icon={<Icon name="x-circle" size="sm" />}>
          {t('admin.euAiAct.summary.failing', '{{count}} failing', { count: counts.error })}
        </Badge>
      )}
      {counts.warn > 0 && (
        <Badge tone="warning" icon={<Icon name="exclamation-triangle" size="sm" />}>
          {t('admin.euAiAct.summary.attention', '{{count}} need attention', {
            count: counts.warn
          })}
        </Badge>
      )}
      {counts.error === 0 && counts.warn === 0 && (
        <Badge tone="success" icon={<Icon name="check-circle" size="sm" />}>
          {t('admin.euAiAct.summary.allOk', 'All checks passed')}
        </Badge>
      )}
    </div>
  );

  return (
    <EuAiActCard
      id="config-check"
      title={t('admin.euAiAct.check.title', 'Configuration check')}
      description={t(
        'admin.euAiAct.check.description',
        'Green means "configured as designed", not "legally compliant". It shows what is set up, not whether your use is lawful.'
      )}
      actions={summary}
    >
      {paused ? (
        <div data-testid="checks-paused">
          <Badge tone="neutral" icon={<Icon name="minus-circle" size="sm" />}>
            {t('admin.euAiAct.master.notEvaluated', 'Not evaluated')}
          </Badge>
          <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">
            {t(
              'admin.euAiAct.master.checksPaused',
              'Checks are paused. Nothing is evaluated while the features are off.'
            )}{' '}
            <a
              href="#conformity"
              className="font-medium underline text-indigo-700 dark:text-indigo-300 focus-visible:ring-2 focus-visible:ring-indigo-500 rounded-sm"
            >
              {t('admin.euAiAct.master.pausedLink', 'Switch on again')}
            </a>
          </p>
        </div>
      ) : error && !status ? (
        <AdminLoadError
          framed={false}
          message={error}
          title={t('admin.euAiAct.check.loadError', 'Could not load the checks')}
          action={{ label: t('common.retry', 'Retry'), onClick: () => onRecheck() }}
        />
      ) : loading ? (
        <div aria-busy="true">
          <span className="sr-only">{t('admin.euAiAct.check.loading', 'Loading checks')}</span>
          <div aria-hidden="true" className="space-y-3">
            {[0, 1, 2, 3, 4].map(i => (
              <div
                key={i}
                className="h-4 bg-gray-200 dark:bg-gray-700 rounded-sm animate-pulse motion-reduce:animate-none"
              />
            ))}
          </div>
        </div>
      ) : (
        <>
          {/* role="list" keeps the list semantics Safari drops for unstyled lists */}
          {/* eslint-disable-next-line jsx-a11y/no-redundant-roles */}
          <ul
            role="list"
            aria-busy={checking}
            className="divide-y divide-gray-200 dark:divide-gray-700"
          >
            {checks.map(check => (
              <CheckRow key={`${check.id}-${check.modelId || ''}`} check={check} />
            ))}
          </ul>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => onRecheck({ refresh: true })}
              disabled={checking}
              className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-60 focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              <Icon
                name="refresh"
                size="sm"
                className={checking ? 'animate-spin motion-reduce:animate-none' : ''}
              />
              {checking
                ? t('admin.euAiAct.check.checking', 'Checking…')
                : t('admin.euAiAct.check.recheck', 'Check again')}
            </button>
            {status?.generatedAt && (
              <span className="text-xs text-gray-600 dark:text-gray-400">
                {t('admin.euAiAct.check.lastChecked', 'Last checked {{time}}', {
                  time: new Date(status.generatedAt).toLocaleTimeString()
                })}
              </span>
            )}
          </div>
          {status?.summary?.skippedDisabledModels > 0 && (
            <p className="mt-3 text-xs text-gray-600 dark:text-gray-400">
              {t(
                'admin.euAiAct.check.disabledSkipped',
                '{{count}} disabled models are not checked.',
                { count: status.summary.skippedDisabledModels }
              )}
            </p>
          )}
        </>
      )}
    </EuAiActCard>
  );
}
