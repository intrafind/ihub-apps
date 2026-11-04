// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { CARD } from './UsageUi';
import {
  changeOf,
  formatCompact,
  formatDuration,
  formatNumber,
  formatPercent
} from './usageFormat';

/**
 * One KPI with its change against the previous equal period. `lowerIsBetter`
 * colours a rise red (error rate, latency).
 */
function Kpi({ label, value, title, hint, current, previous, lowerIsBetter = false, testId }) {
  const { t, i18n } = useTranslation();
  const change = changeOf(current, previous);
  let tone = 'text-gray-500 dark:text-gray-400';
  if (change && change.direction !== 'flat') {
    const good = (change.direction === 'down') === lowerIsBetter;
    tone = good ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400';
  }
  return (
    <div className={`${CARD} p-4`} data-testid={testId}>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </p>
      <p
        className="mt-1 truncate text-2xl font-semibold tabular-nums text-gray-900 dark:text-gray-100"
        title={title}
      >
        {value}
      </p>
      {hint && <p className="text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
      <p className={`mt-1 text-xs ${tone}`}>
        {change
          ? change.direction === 'flat'
            ? t('admin.usage.reports.kpi.noChange', 'No change vs. previous period')
            : t('admin.usage.reports.kpi.change', '{{arrow}} {{percent}} vs. previous period', {
                arrow: change.direction === 'up' ? '↑' : '↓',
                percent: formatPercent(Math.abs(change.ratio), i18n.language, 0)
              })
          : t('admin.usage.reports.kpi.noPrevious', 'No data in the previous period')}
      </p>
    </div>
  );
}

/** Requests, input/cached/output tokens, error rate, p95 latency, active users. */
export default function KpiCards({ totals, previous }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const cur = totals || {};
  const prev = previous || {};
  return (
    <div
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7"
      data-testid="usage-kpis"
    >
      <Kpi
        testId="usage-kpi-requests"
        label={t('admin.usage.reports.kpi.requests', 'Requests')}
        value={formatNumber(cur.requests, lang)}
        current={cur.requests}
        previous={prev.requests}
      />
      <Kpi
        label={t('admin.usage.reports.kpi.inputTokens', 'Input tokens')}
        value={formatCompact(cur.promptTokens || 0, lang)}
        title={formatNumber(cur.promptTokens || 0, lang)}
        current={cur.promptTokens}
        previous={prev.promptTokens}
      />
      <Kpi
        label={t('admin.usage.reports.kpi.cachedTokens', 'Cached input')}
        value={formatCompact(cur.cacheReadTokens || 0, lang)}
        title={formatNumber(cur.cacheReadTokens || 0, lang)}
        hint={t('admin.usage.reports.kpi.cacheHit', '{{percent}} cache hit', {
          percent: formatPercent(cur.cacheHitRate || 0, lang)
        })}
        current={cur.cacheReadTokens}
        previous={prev.cacheReadTokens}
      />
      <Kpi
        label={t('admin.usage.reports.kpi.outputTokens', 'Output tokens')}
        value={formatCompact(cur.completionTokens || 0, lang)}
        title={formatNumber(cur.completionTokens || 0, lang)}
        current={cur.completionTokens}
        previous={prev.completionTokens}
      />
      <Kpi
        label={t('admin.usage.reports.kpi.errorRate', 'Error rate')}
        value={formatPercent(cur.errorRate || 0, lang)}
        hint={t('admin.usage.reports.kpi.errors', '{{count}} errors', {
          count: formatNumber(cur.errors || 0, lang)
        })}
        current={cur.errorRate}
        previous={prev.requests ? prev.errorRate : null}
        lowerIsBetter
      />
      <Kpi
        label={t('admin.usage.reports.kpi.latencyP95', 'Latency p95')}
        value={formatDuration(cur.latencyP95, lang)}
        hint={t('admin.usage.reports.kpi.latencyP50', 'p50 {{value}}', {
          value: formatDuration(cur.latencyP50, lang)
        })}
        current={cur.latencyP95}
        previous={prev.latencyP95}
        lowerIsBetter
      />
      <Kpi
        label={t('admin.usage.reports.kpi.activeUsers', 'Active users')}
        value={formatNumber(cur.activeUsers, lang)}
        current={cur.activeUsers}
        previous={prev.activeUsers}
      />
    </div>
  );
}
