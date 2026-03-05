import { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { fetchAdminUsageTimeline } from '../../../api/adminApi';
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

export default function UsageTimeline() {
  const { t } = useTranslation();
  const [range, setRange] = useState('30d');
  const [timeline, setTimeline] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchAdminUsageTimeline(range)
      .then(data => {
        if (!cancelled) setTimeline(data);
      })
      .catch(e => console.error('Failed to load timeline', e))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range]);

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

  return (
    <div className="space-y-6">
      {/* Range selector */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('admin.usage.timeline.title', 'Usage Timeline')}
        </h3>
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
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner />
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
        </>
      )}
    </div>
  );
}
