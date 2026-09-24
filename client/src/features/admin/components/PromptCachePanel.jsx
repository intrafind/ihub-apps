import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { buildCacheRows, formatRatio, summarizePromptCache } from '../utils/promptCacheStats';

const DIMENSIONS = [
  { id: 'perModel', labelKey: 'admin.usage.promptCache.byModel', fallback: 'Model' },
  { id: 'perApp', labelKey: 'admin.usage.promptCache.byApp', fallback: 'App' },
  { id: 'perProvider', labelKey: 'admin.usage.promptCache.byProvider', fallback: 'Provider' }
];

function Tile({ title, value, hint, tone = 'default', icon }) {
  const toneClass =
    tone === 'warning' ? 'text-amber-600 dark:text-amber-400' : 'text-gray-900 dark:text-gray-100';
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-600 dark:text-gray-400">{title}</p>
          <p className={`text-2xl font-bold tabular-nums ${toneClass}`}>{value}</p>
          {hint && <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{hint}</p>}
        </div>
        {icon && <div className="p-2 rounded-full bg-cyan-500 shrink-0">{icon}</div>}
      </div>
    </div>
  );
}

/**
 * Prompt-cache KPIs and the per-model / per-app / per-provider breakdown,
 * from the all-time usage aggregate (`usage.tokens`).
 */
export default function PromptCachePanel({ tokens }) {
  const { t, i18n } = useTranslation();
  const [dim, setDim] = useState('perModel');
  const locale = i18n?.language;
  const format = n => new Intl.NumberFormat(locale).format(n);
  const summary = summarizePromptCache(tokens);
  const rows = buildCacheRows(tokens, dim);
  const writesExceedReads = summary.writeToRead !== null && summary.writeToRead > 1;

  const writeHint =
    summary.writeToRead === null
      ? null
      : Number.isFinite(summary.writeToRead)
        ? t('admin.usage.promptCache.writeToRead', '{{ratio}} of cache reads', {
            ratio: formatRatio(summary.writeToRead, locale)
          })
        : t('admin.usage.promptCache.writesOnly', 'Written but never read yet');

  return (
    <section className="space-y-4" aria-labelledby="prompt-cache-heading">
      <div>
        <h3
          id="prompt-cache-heading"
          className="text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          {t('admin.usage.promptCache.title', 'Prompt caching')}
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t(
            'admin.usage.promptCache.subtitle',
            'Input tokens the provider served from its prompt cache. Cached tokens are billed at a discount and return faster.'
          )}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Tile
          title={t('admin.usage.promptCache.hitRatio', 'Cache hit ratio')}
          value={formatRatio(summary.hitRatio, locale)}
          hint={
            summary.reported
              ? t(
                  'admin.usage.promptCache.hitRatioHint',
                  'Of {{tokens}} input tokens on models that report caching',
                  { tokens: format(summary.reportedPromptTokens) }
                )
              : t('admin.usage.promptCache.notReported', 'No provider has reported cache usage yet')
          }
          icon={<Icon name="chart" size="md" className="text-white" />}
        />
        <Tile
          title={t('admin.usage.promptCache.cachedTokens', 'Cached input tokens')}
          value={format(summary.cacheReadTokens)}
          icon={<Icon name="database" size="md" className="text-white" />}
        />
        <Tile
          title={t('admin.usage.promptCache.writeTokens', 'Cache write tokens')}
          value={format(summary.cacheWriteTokens)}
          hint={
            writesExceedReads
              ? t(
                  'admin.usage.promptCache.writesExceedReads',
                  'More writes than reads: where writes cost extra, caching costs more than it saves'
                )
              : writeHint
          }
          tone={writesExceedReads ? 'warning' : 'default'}
          icon={<Icon name="document-text" size="md" className="text-white" />}
        />
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h4 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.usage.promptCache.breakdown', 'Cache usage by')}
          </h4>
          <div
            role="group"
            aria-label={t('admin.usage.promptCache.breakdown', 'Cache usage by')}
            className="inline-flex rounded-md bg-gray-100 dark:bg-gray-700 p-0.5"
          >
            {DIMENSIONS.map(d => (
              <button
                key={d.id}
                type="button"
                onClick={() => setDim(d.id)}
                aria-pressed={dim === d.id}
                className={`px-3 py-1 text-sm rounded ${
                  dim === d.id
                    ? 'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 shadow-xs'
                    : 'text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100'
                }`}
              >
                {t(d.labelKey, d.fallback)}
              </button>
            ))}
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('admin.usage.promptCache.noRows', 'No usage recorded yet.')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-700 text-gray-500 dark:text-gray-400">
                  <th className="py-2 px-3 text-left font-medium">
                    {t(DIMENSIONS.find(d => d.id === dim).labelKey, dim)}
                  </th>
                  <th className="py-2 px-3 text-right font-medium">
                    {t('admin.usage.promptCache.inputTokens', 'Input tokens')}
                  </th>
                  <th className="py-2 px-3 text-right font-medium">
                    {t('admin.usage.promptCache.cachedTokens', 'Cached input tokens')}
                  </th>
                  <th className="py-2 px-3 text-left font-medium w-48">
                    {t('admin.usage.promptCache.hitRatio', 'Cache hit ratio')}
                  </th>
                  <th className="py-2 px-3 text-right font-medium">
                    {t('admin.usage.promptCache.writeTokens', 'Cache write tokens')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => (
                  <tr
                    key={row.id}
                    className="border-b border-gray-100 dark:border-gray-700/50 last:border-0 text-gray-700 dark:text-gray-300"
                  >
                    <td className="py-2 px-3 font-medium break-all">{row.id}</td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {format(row.promptTokens)}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {row.cacheReadTokens !== undefined ? format(row.cacheReadTokens) : '—'}
                    </td>
                    <td className="py-2 px-3">
                      {row.reported ? (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                            <div
                              className="bg-cyan-500 h-2 rounded-full"
                              style={{ width: `${Math.round((row.hitRatio || 0) * 100)}%` }}
                            />
                          </div>
                          <span className="tabular-nums w-12 text-right">
                            {formatRatio(row.hitRatio, locale)}
                          </span>
                        </div>
                      ) : (
                        <span className="text-gray-400 dark:text-gray-500">
                          {t('admin.usage.promptCache.notReportedShort', 'not reported')}
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">
                      {row.cacheWriteTokens !== undefined ? format(row.cacheWriteTokens) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {dim === 'perProvider' && (
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-3">
            {t(
              'admin.usage.promptCache.providerSince',
              'The provider breakdown covers usage recorded since this version.'
            )}
          </p>
        )}
      </div>
    </section>
  );
}
