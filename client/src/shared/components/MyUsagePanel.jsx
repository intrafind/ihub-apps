// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import useMyUsage, { mostUrgentBucket } from '../hooks/useMyUsage';
import QuotaBar from './QuotaBar';
import { formatTokens, localizedName, windowLabel } from '../utils/usageFormat';

/**
 * "My usage" at a glance: tokens used today and this month, and the budget
 * closest to its limit with what remains and when it resets — so a refused
 * call (QUOTA_EXCEEDED) is no surprise. The full picture is Settings → Usage.
 *
 * @param {Object} [props]
 * @param {string} [props.className]
 */
export default function MyUsagePanel({ className = '' }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  const { data, error } = useMyUsage();
  if (error || !data) return null;

  const totals = data.totals || { day: 0, month: 0 };
  const urgent = mostUrgentBucket(data.buckets);
  const label = b =>
    `${
      b.scope === 'model'
        ? localizedName(b.modelName, lang, b.modelId)
        : t('usage.page.allModels', 'All models')
    } · ${windowLabel(b.window, t)}`;

  return (
    <div className={`space-y-2 ${className}`} data-testid="my-usage-panel">
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {t('usage.panel.title', 'My usage')}
      </p>
      <div className="grid grid-cols-2 gap-2 text-xs text-gray-600 dark:text-gray-300">
        <div>
          <div className="text-gray-500 dark:text-gray-400">{t('usage.panel.today', 'Today')}</div>
          <div className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
            {t('usage.panel.tokens', '{{tokens}} tokens', {
              tokens: formatTokens(totals.day || 0, lang)
            })}
          </div>
        </div>
        <div>
          <div className="text-gray-500 dark:text-gray-400">
            {t('usage.panel.month', 'This month')}
          </div>
          <div className="text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
            {t('usage.panel.tokens', '{{tokens}} tokens', {
              tokens: formatTokens(totals.month || 0, lang)
            })}
          </div>
        </div>
      </div>
      {urgent ? (
        <div>
          <QuotaBar
            size="sm"
            label={label(urgent)}
            used={urgent.used}
            limit={urgent.limit}
            resetAt={urgent.resetAt}
          />
          <p className="mt-1 text-xs text-gray-600 dark:text-gray-300">
            {urgent.exceeded
              ? t('usage.panel.exceeded', 'Limit reached — new requests wait for the reset.')
              : t('usage.panel.remaining', '{{remaining}} tokens left', {
                  remaining: formatTokens(urgent.remaining, lang)
                })}
          </p>
        </div>
      ) : (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('usage.panel.noLimits', 'No token limits apply to you.')}
        </p>
      )}
    </div>
  );
}
