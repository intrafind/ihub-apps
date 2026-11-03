// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import QuotaBar from '../../../shared/components/QuotaBar';
import useMyUsage from '../../../shared/hooks/useMyUsage';
import { formatBytes } from '../../admin/utils/systemResourcesFormat';
import {
  formatResetMoment,
  formatTokens,
  localizedName,
  sourceLabel,
  windowLabel
} from '../../../shared/utils/usageFormat';

const WINDOW_ORDER = { day: 0, week: 1, month: 2 };

function Card({ title, description, icon, children, testId }) {
  return (
    <section
      className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800"
      data-testid={testId}
    >
      <div className="mb-4 flex items-start gap-3">
        {icon && (
          <Icon name={icon} size="md" className="mt-0.5 text-indigo-500 dark:text-indigo-400" />
        )}
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
          {description && (
            <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">{description}</p>
          )}
        </div>
      </div>
      {children}
    </section>
  );
}

/**
 * Settings → Usage: the user's token budgets — across all models and per
 * model — with what is used in the current window and when each resets,
 * this month's usage of every model they may use, and their file storage.
 */
export default function UsagePage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { data, error, loading, refresh } = useMyUsage();

  const buckets = data?.buckets || [];
  const allModelBuckets = buckets
    .filter(b => b.scope === 'allModels')
    .sort((a, b) => WINDOW_ORDER[a.window] - WINDOW_ORDER[b.window]);
  const limitedModels = (data?.models || []).filter(m => m.limited);
  const otherModels = (data?.models || []).filter(m => !m.limited);
  const modelLabel = m => localizedName(m.name, lang, m.modelId);
  const hint = b =>
    b.source ? t('usage.limitedBy', 'Limit {{source}}', { source: sourceLabel(b.source, t) }) : '';

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {t('usage.page.title', 'Usage')}
          </h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {t(
              'usage.page.subtitle',
              'How much of your token budgets you have used, and when they reset.'
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          <Icon name="refresh" size="sm" className={loading ? 'animate-spin' : ''} />
          {t('usage.page.refresh', 'Refresh')}
        </button>
      </div>

      {error && !data && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300"
        >
          {t('usage.page.loadFailed', 'Your usage could not be loaded.')}
        </div>
      )}

      {!data && loading && (
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {t('common.loading', 'Loading...')}
        </div>
      )}

      {data && (
        <div className="space-y-6">
          {data.resets && (
            <p className="text-xs text-gray-500 dark:text-gray-400" data-testid="usage-resets">
              {t(
                'usage.page.schedule',
                'Daily limits reset {{day}}, weekly limits {{week}}, monthly limits {{month}}.',
                {
                  day: formatResetMoment(data.resets.day, t, lang),
                  week: formatResetMoment(data.resets.week, t, lang),
                  month: formatResetMoment(data.resets.month, t, lang)
                }
              )}
            </p>
          )}

          {allModelBuckets.length > 0 && (
            <Card
              title={t('usage.page.allModels', 'All models')}
              description={t(
                'usage.page.allModelsHint',
                'Your budget across every model together.'
              )}
              icon="chart-bar"
              testId="usage-all-models"
            >
              <div className="space-y-4">
                {allModelBuckets.map(b => (
                  <QuotaBar
                    key={b.id}
                    label={windowLabel(b.window, t)}
                    used={b.used}
                    limit={b.limit}
                    resetAt={b.resetAt}
                    hint={hint(b)}
                  />
                ))}
              </div>
            </Card>
          )}

          {limitedModels.map(model => {
            const modelBuckets = buckets
              .filter(b => b.scope === 'model' && b.modelId === model.modelId)
              .sort((a, b) => WINDOW_ORDER[a.window] - WINDOW_ORDER[b.window]);
            return (
              <Card
                key={model.modelId}
                title={modelLabel(model)}
                description={
                  model.exceeded
                    ? t(
                        'usage.page.modelExhausted',
                        'Limit reached — choose another model until it resets.'
                      )
                    : null
                }
                icon="cpu-chip"
                testId={`usage-model-${model.modelId}`}
              >
                <div className="space-y-4">
                  {modelBuckets.map(b => (
                    <QuotaBar
                      key={b.id}
                      label={windowLabel(b.window, t)}
                      used={b.used}
                      limit={b.limit}
                      resetAt={b.resetAt}
                      hint={hint(b)}
                    />
                  ))}
                </div>
              </Card>
            );
          })}

          {buckets.length === 0 && (
            <div className="rounded-md border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600 dark:border-gray-700 dark:bg-gray-800/50 dark:text-gray-300">
              {t('usage.page.noLimits', 'No token limits apply to you.')}
            </div>
          )}

          {otherModels.length > 0 && (
            <Card
              title={t('usage.page.otherModels', 'Models without a limit')}
              description={t('usage.page.otherModelsHint', 'Tokens used this month.')}
              icon="chart-bar"
              testId="usage-other-models"
            >
              <ul className="divide-y divide-gray-100 dark:divide-gray-700">
                {otherModels.map(m => (
                  <li key={m.modelId} className="flex justify-between gap-3 py-2 text-sm">
                    <span className="truncate text-gray-800 dark:text-gray-200">
                      {modelLabel(m)}
                      {m.unavailable && (
                        <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                          {t('usage.page.noLongerAvailable', '(no longer available to you)')}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 tabular-nums text-gray-600 dark:text-gray-400">
                      {t('usage.tokens', '{{count}} tokens', {
                        count: formatTokens(m.usage?.month || 0, lang)
                      })}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card
            title={t('usage.page.files', 'File storage')}
            description={t(
              'usage.page.filesHint',
              'Files you uploaded to chats and tasks. The oldest originals may be removed when the storage is full.'
            )}
            icon="document"
            testId="usage-files"
          >
            {data.files?.usedBytes === null || data.files?.usedBytes === undefined ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('usage.page.filesUnavailable', 'File storage is not available.')}
              </p>
            ) : (
              <QuotaBar
                label={t('usage.page.filesCount', '{{count}} files', {
                  count: data.files.fileCount || 0
                })}
                used={data.files.usedBytes}
                limit={data.files.limit}
                format={formatBytes}
              />
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
