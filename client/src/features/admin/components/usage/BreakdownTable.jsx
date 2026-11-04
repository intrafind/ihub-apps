// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Fragment, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchUsageBreakdown, downloadUsageExport } from '../../../../api/usageReportsAdminApi';
import Icon from '../../../../shared/components/Icon';
import useUsageQuery from './useUsageQuery';
import { DIMENSIONS } from './useUsageReportState';
import { EmptyState, ErrorNote, Panel, Segmented, SmallButton } from './UsageUi';
import {
  downloadText,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelative,
  toCsv
} from './usageFormat';

const TH =
  'px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400';
const TD = 'px-3 py-2 text-sm tabular-nums text-gray-700 dark:text-gray-300 whitespace-nowrap';

/**
 * Usage per user, group, app, model, provider or surface: sortable columns
 * (sort kept in the URL), rows that expand into per-model sub-rows, CSV of
 * the table and the raw records of the range.
 */
export default function BreakdownTable({ state }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const [open, setOpen] = useState(() => new Set());
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  const params = {
    ...state.rangeParams,
    dimension: state.dim,
    sort: state.sort,
    order: state.order
  };
  const { data, error, loading } = useUsageQuery(fetchUsageBreakdown, params);

  const dimLabels = {
    user: t('admin.usage.reports.dim.user', 'User'),
    group: t('admin.usage.reports.dim.group', 'Group'),
    app: t('admin.usage.reports.dim.app', 'App'),
    model: t('admin.usage.reports.dim.model', 'Model'),
    provider: t('admin.usage.reports.dim.provider', 'Provider'),
    surface: t('admin.usage.reports.dim.surface', 'Surface')
  };
  const surfaceLabel = key => t(`admin.usage.reports.surface.${key}`, key);
  const labelOf = key => (state.dim === 'surface' ? surfaceLabel(key) : key);

  const columns = [
    ['key', dimLabels[state.dim]],
    ['requests', t('admin.usage.reports.col.requests', 'Requests')],
    ['promptTokens', t('admin.usage.reports.col.input', 'Input')],
    ['cacheReadTokens', t('admin.usage.reports.col.cached', 'Cached')],
    ['completionTokens', t('admin.usage.reports.col.output', 'Output')],
    ['totalTokens', t('admin.usage.reports.col.total', 'Total tokens')],
    ['errorRate', t('admin.usage.reports.col.errorRate', 'Errors')],
    ['latencyP95', t('admin.usage.reports.col.p95', 'p95')],
    ['lastTs', t('admin.usage.reports.col.lastUsed', 'Last used')]
  ];

  const setSort = key => {
    const order = state.sort === key && state.order === 'desc' ? 'asc' : 'desc';
    state.update({ sort: key, order });
  };

  const exportCsv = () => {
    const rows = [];
    for (const r of data?.rows || []) {
      rows.push([
        r.key,
        '',
        r.requests,
        r.promptTokens,
        r.cacheReadTokens,
        r.completionTokens,
        r.totalTokens,
        r.errors,
        r.latencyP50 ?? '',
        r.latencyP95 ?? '',
        r.lastTs || ''
      ]);
      for (const m of r.models || []) {
        rows.push([
          r.key,
          m.key,
          m.requests,
          m.promptTokens,
          m.cacheReadTokens,
          m.completionTokens,
          m.totalTokens,
          m.errors,
          '',
          '',
          ''
        ]);
      }
    }
    downloadText(
      toCsv(
        [
          state.dim,
          'model',
          'requests',
          'inputTokens',
          'cachedInputTokens',
          'outputTokens',
          'totalTokens',
          'errors',
          'latencyP50Ms',
          'latencyP95Ms',
          'lastUsed'
        ],
        rows
      ),
      `usage-by-${state.dim}-${state.range}.csv`
    );
  };

  const exportRaw = async () => {
    setExporting(true);
    setExportError(null);
    try {
      await downloadUsageExport(state.rangeParams, 'csv');
    } catch (err) {
      setExportError(err);
    } finally {
      setExporting(false);
    }
  };

  const rows = data?.rows || [];

  return (
    <div className="space-y-4" data-testid="usage-breakdown">
      <ErrorNote error={error || exportError} />
      <Panel
        title={t('admin.usage.reports.breakdown', 'Breakdown')}
        loading={loading}
        actions={
          <>
            <Segmented
              label={t('admin.usage.reports.dimension', 'Dimension')}
              value={state.dim}
              onChange={dim => {
                setOpen(new Set());
                state.update({ dim });
              }}
              options={DIMENSIONS.map(d => [d, dimLabels[d]])}
            />
            <SmallButton icon="download" onClick={exportCsv} disabled={!rows.length}>
              {t('admin.usage.reports.exportTable', 'Table CSV')}
            </SmallButton>
            <SmallButton icon="download" onClick={exportRaw} disabled={exporting}>
              {t('admin.usage.reports.exportRaw', 'Raw events CSV')}
            </SmallButton>
          </>
        }
      >
        {rows.length === 0 ? (
          data ? (
            <EmptyState
              title={t(
                'admin.usage.reports.empty.breakdown',
                'Nothing to break down in this range'
              )}
            >
              {state.dim === 'group'
                ? t(
                    'admin.usage.reports.empty.groupHint',
                    'Calls are grouped by the groups a user had when they were made; built-in groups such as "authenticated" are left out.'
                  )
                : null}
            </EmptyState>
          ) : (
            <div className="h-32" />
          )
        ) : (
          <div className="-mx-4 overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead>
                <tr>
                  <th className="w-8">
                    <span className="sr-only">
                      {t('admin.usage.reports.perModel', 'Per model')}
                    </span>
                  </th>
                  {columns.map(([key, label]) => (
                    <th
                      key={key}
                      className={TH}
                      aria-sort={
                        state.sort === key
                          ? state.order === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                    >
                      <button
                        type="button"
                        onClick={() => setSort(key)}
                        className="inline-flex items-center gap-1 uppercase hover:text-gray-900 dark:hover:text-gray-100"
                      >
                        {label}
                        {state.sort === key && (
                          <span aria-hidden="true">{state.order === 'asc' ? '▲' : '▼'}</span>
                        )}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700/60">
                {rows.map(row => {
                  const expanded = open.has(row.key);
                  const canExpand = (row.models || []).length > 0;
                  return (
                    <Fragment key={row.key}>
                      <tr className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                        <td className="px-2">
                          {canExpand && (
                            <button
                              type="button"
                              aria-expanded={expanded}
                              aria-label={t('admin.usage.reports.perModel', 'Per model')}
                              onClick={() =>
                                setOpen(prev => {
                                  const next = new Set(prev);
                                  if (next.has(row.key)) next.delete(row.key);
                                  else next.add(row.key);
                                  return next;
                                })
                              }
                              className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700"
                            >
                              <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size="sm" />
                            </button>
                          )}
                        </td>
                        <td
                          className={`${TD} max-w-xs truncate font-medium text-gray-900 dark:text-gray-100`}
                          title={row.key}
                        >
                          {labelOf(row.key)}
                        </td>
                        <td className={TD}>{formatNumber(row.requests, lang)}</td>
                        <td className={TD}>{formatNumber(row.promptTokens, lang)}</td>
                        <td className={TD}>{formatNumber(row.cacheReadTokens, lang)}</td>
                        <td className={TD}>{formatNumber(row.completionTokens, lang)}</td>
                        <td className={`${TD} font-medium`}>
                          {formatNumber(row.totalTokens, lang)}
                        </td>
                        <td className={TD}>
                          {row.errors ? formatPercent(row.errorRate, lang) : '—'}
                        </td>
                        <td className={TD}>{formatDuration(row.latencyP95, lang)}</td>
                        <td className={TD} title={row.lastTs || ''}>
                          {row.lastTs ? formatRelative(row.lastTs, lang) : '—'}
                        </td>
                      </tr>
                      {expanded &&
                        row.models.map(m => (
                          <tr
                            key={`${row.key}::${m.key}`}
                            className="bg-gray-50/70 dark:bg-gray-900/30"
                          >
                            <td />
                            <td className={`${TD} pl-8 text-gray-600 dark:text-gray-400`}>
                              {m.key}
                            </td>
                            <td className={TD}>{formatNumber(m.requests, lang)}</td>
                            <td className={TD}>{formatNumber(m.promptTokens, lang)}</td>
                            <td className={TD}>{formatNumber(m.cacheReadTokens, lang)}</td>
                            <td className={TD}>{formatNumber(m.completionTokens, lang)}</td>
                            <td className={TD}>{formatNumber(m.totalTokens, lang)}</td>
                            <td className={TD}>
                              {m.errors ? formatPercent(m.errors / m.requests, lang) : '—'}
                            </td>
                            <td className={TD} />
                            <td className={TD} />
                          </tr>
                        ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
