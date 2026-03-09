import { useEffect, useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  fetchAdminUsageTimeline,
  triggerUsageRollup,
  fetchAdminUsageUsers,
  fetchAdminUsageApps,
  fetchAdminUsageModels
} from '../../../api/adminApi';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';

const RANGES = [
  { label: '7d', value: '7d' },
  { label: '30d', value: '30d' },
  { label: '90d', value: '90d' },
  { label: '12m', value: '12m' }
];

const COLORS = {
  promptTokens: '#3b82f6',
  completionTokens: '#10b981',
  messages: '#8b5cf6'
};

function SimpleLineChart({ data, dataKeys, height = 200 }) {
  const padding = { top: 20, right: 20, bottom: 30, left: 60 };
  const width = 600;
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  if (!data || data.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-gray-400 dark:text-gray-500"
        style={{ height }}
      >
        No data available
      </div>
    );
  }

  // Calculate max value across all keys
  const maxValue = Math.max(1, ...data.flatMap(d => dataKeys.map(k => d[k.key] || 0)));

  // Scale functions
  const xScale = i => padding.left + (i / Math.max(1, data.length - 1)) * chartWidth;
  const yScale = v => padding.top + chartHeight - (v / maxValue) * chartHeight;

  // Y-axis ticks
  const yTicks = [0, maxValue * 0.25, maxValue * 0.5, maxValue * 0.75, maxValue];

  const formatNumber = n => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return Math.round(n).toString();
  };

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" preserveAspectRatio="xMidYMid meet">
      {/* Grid lines */}
      {yTicks.map((tick, i) => (
        <g key={i}>
          <line
            x1={padding.left}
            y1={yScale(tick)}
            x2={width - padding.right}
            y2={yScale(tick)}
            stroke="currentColor"
            className="text-gray-200 dark:text-gray-700"
            strokeDasharray="4,4"
          />
          <text
            x={padding.left - 8}
            y={yScale(tick) + 4}
            textAnchor="end"
            className="text-gray-400 dark:text-gray-500"
            fontSize="10"
            fill="currentColor"
          >
            {formatNumber(tick)}
          </text>
        </g>
      ))}

      {/* X-axis labels */}
      {data.map((d, i) => {
        // Show every Nth label depending on data length
        const showEvery = Math.max(1, Math.floor(data.length / 6));
        if (i % showEvery !== 0 && i !== data.length - 1) return null;
        return (
          <text
            key={i}
            x={xScale(i)}
            y={height - 5}
            textAnchor="middle"
            className="text-gray-400 dark:text-gray-500"
            fontSize="9"
            fill="currentColor"
          >
            {d.label}
          </text>
        );
      })}

      {/* Lines */}
      {dataKeys.map(({ key, color }) => {
        const points = data.map((d, i) => `${xScale(i)},${yScale(d[key] || 0)}`).join(' ');
        return (
          <polyline
            key={key}
            points={points}
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinejoin="round"
          />
        );
      })}

      {/* Data points */}
      {dataKeys.map(({ key, color }) =>
        data.map((d, i) => (
          <circle key={`${key}-${i}`} cx={xScale(i)} cy={yScale(d[key] || 0)} r="3" fill={color}>
            <title>
              {d.label}: {formatNumber(d[key] || 0)}
            </title>
          </circle>
        ))
      )}
    </svg>
  );
}

function BreakdownTable({ title, data, columns, expanded, onToggle }) {
  const formatNumber = n => new Intl.NumberFormat().format(n);

  if (!data || data.length === 0) return null;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between p-4 text-left hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors"
      >
        <h4 className="text-sm font-medium text-gray-600 dark:text-gray-400">
          {title} ({data.length})
        </h4>
        <svg
          className={`w-4 h-4 text-gray-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="px-4 pb-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                {columns.map(col => (
                  <th
                    key={col.key}
                    className={`py-2 px-3 font-medium text-gray-500 dark:text-gray-400 ${col.align === 'right' ? 'text-right' : 'text-left'}`}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((row, i) => (
                <tr
                  key={i}
                  className="border-b border-gray-100 dark:border-gray-700/50 last:border-0"
                >
                  {columns.map(col => (
                    <td
                      key={col.key}
                      className={`py-2 px-3 text-gray-700 dark:text-gray-300 ${col.align === 'right' ? 'text-right tabular-nums' : ''}`}
                    >
                      {col.format ? col.format(row[col.key]) : formatNumber(row[col.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function UsageTimeline() {
  const { t } = useTranslation();
  const [range, setRange] = useState('30d');
  const [timeline, setTimeline] = useState(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [rollupMessage, setRollupMessage] = useState(null);
  const [breakdowns, setBreakdowns] = useState({ users: [], apps: [], models: [] });
  const [expanded, setExpanded] = useState({ users: false, apps: false, models: false });

  const loadTimeline = useCallback(
    selectedRange => {
      setLoading(true);
      return Promise.all([
        fetchAdminUsageTimeline(selectedRange),
        fetchAdminUsageUsers(selectedRange),
        fetchAdminUsageApps(selectedRange),
        fetchAdminUsageModels(selectedRange)
      ])
        .then(([timelineData, usersData, appsData, modelsData]) => {
          setTimeline(timelineData);
          setBreakdowns({
            users: toSortedArray(usersData?.users, 'userId'),
            apps: toSortedArray(appsData?.apps, 'appId'),
            models: toSortedArray(modelsData?.models, 'modelId')
          });
        })
        .catch(e => console.error('Failed to load timeline', e))
        .finally(() => setLoading(false));
    },
    [setTimeline, setBreakdowns, setLoading]
  );

  useEffect(() => {
    loadTimeline(range);
  }, [range, loadTimeline]);

  const handleGenerateRollup = async () => {
    try {
      setGenerating(true);
      setRollupMessage(null);
      const result = await triggerUsageRollup();
      await loadTimeline(range);

      if (result.eventsProcessed > 0) {
        setRollupMessage({
          type: 'success',
          text: t(
            'admin.usage.timeline.rollupSuccess',
            'Processed {{events}} events into {{days}} daily rollup(s).',
            { events: result.eventsProcessed, days: result.daysGenerated }
          )
        });
      } else {
        setRollupMessage({
          type: 'warning',
          text: t(
            'admin.usage.timeline.rollupEmpty',
            'No usage events found. Make some chat requests first.'
          )
        });
      }
    } catch (e) {
      console.error('Failed to generate rollup', e);
      setRollupMessage({
        type: 'error',
        text: t('admin.usage.timeline.rollupError', 'Failed to generate rollup.')
      });
    } finally {
      setGenerating(false);
      setTimeout(() => setRollupMessage(null), 5000);
    }
  };

  const chartData = useMemo(() => {
    if (!timeline?.data) return [];
    return timeline.data.map(d => ({
      label: d.date || d.month || '',
      promptTokens: d.totals?.promptTokens || 0,
      completionTokens: d.totals?.completionTokens || 0,
      messages: d.totals?.messages || 0,
      uniqueUsers: d.totals?.uniqueUsers || 0
    }));
  }, [timeline]);

  const totals = useMemo(() => {
    if (!chartData.length) return { promptTokens: 0, completionTokens: 0, messages: 0 };
    return chartData.reduce(
      (acc, d) => ({
        promptTokens: acc.promptTokens + d.promptTokens,
        completionTokens: acc.completionTokens + d.completionTokens,
        messages: acc.messages + d.messages
      }),
      { promptTokens: 0, completionTokens: 0, messages: 0 }
    );
  }, [chartData]);

  const formatNumber = n => new Intl.NumberFormat().format(n);

  const toggleSection = key => setExpanded(prev => ({ ...prev, [key]: !prev[key] }));

  const userColumns = [
    {
      key: 'userId',
      label: t('admin.usage.breakdown.userId', 'User'),
      align: 'left',
      format: v => v
    },
    { key: 'messages', label: t('admin.usage.breakdown.messages', 'Messages'), align: 'right' },
    {
      key: 'promptTokens',
      label: t('admin.usage.breakdown.promptTokens', 'Prompt Tokens'),
      align: 'right'
    },
    {
      key: 'completionTokens',
      label: t('admin.usage.breakdown.completionTokens', 'Completion Tokens'),
      align: 'right'
    },
    { key: 'days', label: t('admin.usage.breakdown.daysActive', 'Days Active'), align: 'right' }
  ];

  const appColumns = [
    { key: 'appId', label: t('admin.usage.breakdown.appId', 'App'), align: 'left', format: v => v },
    { key: 'messages', label: t('admin.usage.breakdown.messages', 'Messages'), align: 'right' },
    {
      key: 'promptTokens',
      label: t('admin.usage.breakdown.promptTokens', 'Prompt Tokens'),
      align: 'right'
    },
    {
      key: 'completionTokens',
      label: t('admin.usage.breakdown.completionTokens', 'Completion Tokens'),
      align: 'right'
    }
  ];

  const modelColumns = [
    {
      key: 'modelId',
      label: t('admin.usage.breakdown.modelId', 'Model'),
      align: 'left',
      format: v => v
    },
    { key: 'messages', label: t('admin.usage.breakdown.messages', 'Messages'), align: 'right' },
    {
      key: 'promptTokens',
      label: t('admin.usage.breakdown.promptTokens', 'Prompt Tokens'),
      align: 'right'
    },
    {
      key: 'completionTokens',
      label: t('admin.usage.breakdown.completionTokens', 'Completion Tokens'),
      align: 'right'
    }
  ];

  return (
    <div className="space-y-6">
      {/* Range selector */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('admin.usage.timeline.title', 'Usage Timeline')}
        </h3>
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            {RANGES.map(r => (
              <button
                key={r.value}
                onClick={() => setRange(r.value)}
                className={`px-3 py-1 text-sm rounded-md transition-colors ${
                  range === r.value
                    ? 'bg-blue-500 text-white'
                    : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button
            onClick={handleGenerateRollup}
            disabled={generating}
            className="px-3 py-1 text-sm rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {generating
              ? t('admin.usage.timeline.generating', 'Generating...')
              : t('admin.usage.timeline.generateReport', 'Generate Report')}
          </button>
        </div>
      </div>

      {/* Rollup feedback banner */}
      {rollupMessage && (
        <div
          className={`px-4 py-3 rounded-lg text-sm ${
            rollupMessage.type === 'success'
              ? 'bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800'
              : rollupMessage.type === 'warning'
                ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800'
                : 'bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800'
          }`}
        >
          {rollupMessage.text}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner />
        </div>
      ) : chartData.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-12 text-center">
          <div className="text-gray-400 dark:text-gray-500 text-5xl mb-4">
            <svg
              className="w-16 h-16 mx-auto"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z"
              />
            </svg>
          </div>
          <h4 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
            {t('admin.usage.timeline.noData', 'No timeline data yet')}
          </h4>
          <p className="text-gray-500 dark:text-gray-400 mb-6">
            {t(
              'admin.usage.timeline.noDataDesc',
              'Generate a report to aggregate usage events into the timeline view.'
            )}
          </p>
          <button
            onClick={handleGenerateRollup}
            disabled={generating}
            className="px-6 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {generating
              ? t('admin.usage.timeline.generating', 'Generating...')
              : t('admin.usage.timeline.generateReport', 'Generate Report')}
          </button>
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
              <p className="text-sm text-blue-600 dark:text-blue-400">
                {t('admin.usage.timeline.promptTokens', 'Prompt Tokens')}
              </p>
              <p className="text-2xl font-bold text-blue-700 dark:text-blue-300">
                {formatNumber(totals.promptTokens)}
              </p>
            </div>
            <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-4">
              <p className="text-sm text-green-600 dark:text-green-400">
                {t('admin.usage.timeline.completionTokens', 'Completion Tokens')}
              </p>
              <p className="text-2xl font-bold text-green-700 dark:text-green-300">
                {formatNumber(totals.completionTokens)}
              </p>
            </div>
            <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-4">
              <p className="text-sm text-purple-600 dark:text-purple-400">
                {t('admin.usage.timeline.messages', 'Messages')}
              </p>
              <p className="text-2xl font-bold text-purple-700 dark:text-purple-300">
                {formatNumber(totals.messages)}
              </p>
            </div>
          </div>

          {/* Token chart */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
            <h4 className="text-sm font-medium text-gray-600 dark:text-gray-400 mb-4">
              {t('admin.usage.timeline.tokensOverTime', 'Tokens Over Time')}
            </h4>
            <SimpleLineChart
              data={chartData}
              dataKeys={[
                { key: 'promptTokens', color: COLORS.promptTokens },
                { key: 'completionTokens', color: COLORS.completionTokens }
              ]}
              height={240}
            />
            <div className="flex justify-center gap-6 mt-3">
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <span
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: COLORS.promptTokens }}
                />
                {t('admin.usage.timeline.prompt', 'Prompt')}
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <span
                  className="w-3 h-3 rounded-full"
                  style={{ backgroundColor: COLORS.completionTokens }}
                />
                {t('admin.usage.timeline.completion', 'Completion')}
              </div>
            </div>
          </div>

          {/* Messages chart */}
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
            <h4 className="text-sm font-medium text-gray-600 dark:text-gray-400 mb-4">
              {t('admin.usage.timeline.messagesOverTime', 'Messages Over Time')}
            </h4>
            <SimpleLineChart
              data={chartData}
              dataKeys={[{ key: 'messages', color: COLORS.messages }]}
              height={200}
            />
          </div>

          {/* Breakdown tables */}
          <BreakdownTable
            title={t('admin.usage.breakdown.topUsers', 'Top Users')}
            data={breakdowns.users}
            columns={userColumns}
            expanded={expanded.users}
            onToggle={() => toggleSection('users')}
          />
          <BreakdownTable
            title={t('admin.usage.breakdown.topApps', 'Top Apps')}
            data={breakdowns.apps}
            columns={appColumns}
            expanded={expanded.apps}
            onToggle={() => toggleSection('apps')}
          />
          <BreakdownTable
            title={t('admin.usage.breakdown.topModels', 'Top Models')}
            data={breakdowns.models}
            columns={modelColumns}
            expanded={expanded.models}
            onToggle={() => toggleSection('models')}
          />
        </>
      )}
    </div>
  );
}

/** Convert a { [key]: stats } object into a sorted array with the key as idField */
function toSortedArray(obj, idField) {
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj)
    .map(([key, val]) => ({ [idField]: key, ...val }))
    .sort((a, b) => b.messages - a.messages);
}
