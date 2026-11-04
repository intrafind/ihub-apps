// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { fetchUsageReliability } from '../../../../api/usageReportsAdminApi';
import ChartSlot from './ChartSlot';
import useUsageQuery from './useUsageQuery';
import { EmptyState, ErrorNote, Panel } from './UsageUi';
import { formatDuration, formatNumber, formatPercent } from './usageFormat';

const TH =
  'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400';
const TD = 'px-3 py-2 text-sm tabular-nums text-gray-700 dark:text-gray-300 whitespace-nowrap';

function Table({ headers, rows, empty }) {
  if (!rows.length) return <EmptyState title={empty} />;
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead>
          <tr>
            {headers.map(h => (
              <th key={h} className={TH}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-700/60">
          {rows.map(cells => (
            <tr key={cells[0]}>
              {cells.map((c, i) => (
                <td
                  key={headers[i]}
                  className={i === 0 ? `${TD} font-medium text-gray-900 dark:text-gray-100` : TD}
                >
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Error rate over time, errors by code and by provider, latency p50/p95 per model. */
export default function ReliabilityPanel({ state }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const live = state.range === 'today' || state.range === '24h';
  const { data, error, loading } = useUsageQuery(fetchUsageReliability, state.rangeParams, {
    autoRefresh: live && state.auto
  });
  const outcomeLabel = st => t(`admin.usage.reports.outcome.${st}`, st);

  return (
    <div className="space-y-6" data-testid="usage-reliability">
      <ErrorNote error={error} />
      <Panel
        title={t('admin.usage.reports.errorRateOverTime', 'Error rate over time')}
        loading={loading}
      >
        {data && data.series.some(p => p.requests > 0) ? (
          <ChartSlot
            title={t('admin.usage.reports.errorRateOverTime', 'Error rate over time')}
            points={data.series}
            granularity={data.granularity}
            format="percent"
            stacks={[
              {
                key: 'errorRate',
                label: t('admin.usage.reports.kpi.errorRate', 'Error rate'),
                className: 'fill-red-500',
                swatch: 'bg-red-500'
              }
            ]}
          />
        ) : data ? (
          <EmptyState title={t('admin.usage.reports.empty.title', 'No usage in this range')} />
        ) : (
          <div className="h-60" />
        )}
        {data && Object.keys(data.byOutcome || {}).length > 0 && (
          <div className="mt-3 flex flex-wrap gap-3 text-xs text-gray-600 dark:text-gray-400">
            {Object.entries(data.byOutcome).map(([st, n]) => (
              <span key={st} className="rounded bg-gray-100 px-2 py-0.5 dark:bg-gray-700">
                {outcomeLabel(st)}: {formatNumber(n, lang)}
              </span>
            ))}
          </div>
        )}
      </Panel>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Panel title={t('admin.usage.reports.errorsByCode', 'Errors by code')} loading={loading}>
          <Table
            empty={t('admin.usage.reports.empty.errors', 'No errors in this range')}
            headers={[
              t('admin.usage.reports.col.code', 'Code'),
              t('admin.usage.reports.col.count', 'Count'),
              t('admin.usage.reports.dim.provider', 'Provider')
            ]}
            rows={(data?.byError || []).map(e => [
              e.code,
              formatNumber(e.count, lang),
              Object.entries(e.byProvider || {})
                .map(([p, n]) => `${p} (${n})`)
                .join(', ') || '—'
            ])}
          />
        </Panel>
        <Panel
          title={t('admin.usage.reports.errorsByProvider', 'Errors by provider')}
          loading={loading}
        >
          <Table
            empty={t('admin.usage.reports.empty.title', 'No usage in this range')}
            headers={[
              t('admin.usage.reports.dim.provider', 'Provider'),
              t('admin.usage.reports.col.requests', 'Requests'),
              t('admin.usage.reports.chart.errors', 'Errors'),
              t('admin.usage.reports.kpi.errorRate', 'Error rate')
            ]}
            rows={(data?.byProvider || []).map(p => [
              p.key,
              formatNumber(p.requests, lang),
              formatNumber(p.errors, lang),
              formatPercent(p.errorRate, lang)
            ])}
          />
        </Panel>
      </div>
      <Panel title={t('admin.usage.reports.latencyByModel', 'Latency by model')} loading={loading}>
        <Table
          empty={t('admin.usage.reports.empty.models', 'No model was used in this range')}
          headers={[
            t('admin.usage.reports.dim.model', 'Model'),
            t('admin.usage.reports.col.requests', 'Requests'),
            t('admin.usage.reports.col.p50', 'p50'),
            t('admin.usage.reports.col.p95', 'p95'),
            t('admin.usage.reports.col.ttft', 'First token (avg.)'),
            t('admin.usage.reports.kpi.errorRate', 'Error rate')
          ]}
          rows={(data?.byModel || []).map(m => [
            m.key,
            formatNumber(m.requests, lang),
            formatDuration(m.latencyP50, lang),
            formatDuration(m.latencyP95, lang),
            formatDuration(m.ttftAvg, lang),
            formatPercent(m.errorRate, lang)
          ])}
        />
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          {t(
            'admin.usage.reports.latencyNote',
            'Latency is the whole call, from the request to the last token; calls refused by a usage limit are left out.'
          )}
        </p>
      </Panel>
    </div>
  );
}
