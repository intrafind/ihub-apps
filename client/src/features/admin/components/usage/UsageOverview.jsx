// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { fetchUsageSummary } from '../../../../api/usageReportsAdminApi';
import ChartSlot from './ChartSlot';
import KpiCards from './KpiCards';
import TopList from './TopList';
import useUsageQuery from './useUsageQuery';
import { EmptyState, ErrorNote, Panel, Segmented } from './UsageUi';
import { formatNumber, formatRelative } from './usageFormat';

/** KPI cards, usage over time with a metric toggle, top models and apps. */
export default function UsageOverview({ state }) {
  const { t, i18n } = useTranslation();
  const live = state.range === 'today' || state.range === '24h';
  const { data, error, loading } = useUsageQuery(fetchUsageSummary, state.rangeParams, {
    autoRefresh: live && state.auto
  });

  const tokenStacks = [
    {
      key: 'uncached',
      label: t('admin.usage.reports.chart.inputUncached', 'Input (uncached)'),
      value: p => Math.max(0, (p.promptTokens || 0) - (p.cacheReadTokens || 0)),
      className: 'fill-indigo-500',
      swatch: 'bg-indigo-500'
    },
    {
      key: 'cacheReadTokens',
      label: t('admin.usage.reports.chart.inputCached', 'Input (cached)'),
      className: 'fill-sky-300 dark:fill-sky-600',
      swatch: 'bg-sky-300 dark:bg-sky-600'
    },
    {
      key: 'completionTokens',
      label: t('admin.usage.reports.chart.output', 'Output'),
      className: 'fill-emerald-500',
      swatch: 'bg-emerald-500'
    }
  ];
  const requestStacks = [
    {
      key: 'ok',
      label: t('admin.usage.reports.chart.succeeded', 'Requests'),
      value: p => (p.requests || 0) - (p.errors || 0),
      className: 'fill-indigo-500',
      swatch: 'bg-indigo-500'
    },
    {
      key: 'errors',
      label: t('admin.usage.reports.chart.errors', 'Errors'),
      className: 'fill-red-500',
      swatch: 'bg-red-500'
    }
  ];

  const hasData = (data?.totals?.requests || 0) > 0;

  return (
    <div className="space-y-6" data-testid="usage-overview">
      <ErrorNote error={error} />
      {data && <KpiCards totals={data.totals} previous={data.previous} />}
      <Panel
        title={t('admin.usage.reports.overTime', 'Usage over time')}
        subtitle={
          data
            ? t('admin.usage.reports.updated', 'Updated {{when}}', {
                when: formatRelative(data.generatedAt, i18n.language)
              })
            : null
        }
        loading={loading}
        actions={
          <Segmented
            label={t('admin.usage.reports.metric', 'Metric')}
            value={state.metric}
            onChange={metric => state.update({ metric })}
            options={[
              ['tokens', t('admin.usage.reports.metricTokens', 'Tokens')],
              ['requests', t('admin.usage.reports.metricRequests', 'Requests')]
            ]}
          />
        }
        testId="usage-over-time"
      >
        {!data && !error ? (
          <div className="h-60" />
        ) : hasData ? (
          <ChartSlot
            title={t('admin.usage.reports.overTime', 'Usage over time')}
            points={data.series}
            granularity={data.granularity}
            stacks={state.metric === 'requests' ? requestStacks : tokenStacks}
          />
        ) : (
          <EmptyState title={t('admin.usage.reports.empty.title', 'No usage in this range')}>
            {t(
              'admin.usage.reports.empty.hint',
              'Model calls from chats, agents, workflows, scheduled tasks and the API appear here as they happen.'
            )}
          </EmptyState>
        )}
      </Panel>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title={t('admin.usage.reports.topModels', 'Top models')} loading={loading}>
          <TopList
            testId="usage-top-models"
            rows={data?.topModels}
            emptyTitle={t('admin.usage.reports.empty.models', 'No model was used in this range')}
          />
        </Panel>
        <Panel title={t('admin.usage.reports.topApps', 'Top apps')} loading={loading}>
          <TopList
            testId="usage-top-apps"
            rows={data?.topApps}
            emptyTitle={t('admin.usage.reports.empty.apps', 'No app was used in this range')}
          />
        </Panel>
      </div>
      {data && (data.totals.feedbackCount || 0) > 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('admin.usage.reports.feedbackLine', '{{count}} ratings, average {{avg}} ★', {
            count: formatNumber(data.totals.feedbackCount, i18n.language),
            avg: (data.totals.averageRating || 0).toFixed(1)
          })}
        </p>
      )}
    </div>
  );
}
