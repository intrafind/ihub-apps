// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import useMyUsage, { mostUrgentBucket } from '../../../shared/hooks/useMyUsage';
import { formatReset, formatTokens, windowLabel } from '../../../shared/utils/usageFormat';

/**
 * A notice above the chat input once the selected model's token budget (or
 * the budget across all models) is 80 % used, and a blocking one when it is
 * used up — with when it resets and a link to the usage page.
 *
 * @param {Object} props
 * @param {string|null} props.modelId - The selected model
 */
function ModelUsageNotice({ modelId }) {
  const { t, i18n } = useTranslation();
  const { bucketsForModel } = useMyUsage();
  if (!modelId) return null;
  const bucket = mostUrgentBucket(bucketsForModel(modelId));
  if (!bucket || (!bucket.exceeded && !bucket.warning)) return null;

  const params = {
    window: windowLabel(bucket.window, t),
    windowLower: windowLabel(bucket.window, t).toLowerCase(),
    model: bucket.modelName || bucket.modelId,
    percent: Math.round(bucket.percent),
    used: formatTokens(bucket.used, i18n.language),
    limit: formatTokens(bucket.limit, i18n.language),
    reset: formatReset(bucket.resetAt, t, i18n.language)
  };
  const text = bucket.exceeded
    ? bucket.scope === 'model'
      ? t(
          'usage.chat.exceededModel',
          '{{window}} limit for {{model}} reached ({{used}} of {{limit}} tokens). {{reset}}. Choose another model to continue.',
          params
        )
      : t(
          'usage.chat.exceededAll',
          '{{window}} limit across all models reached ({{used}} of {{limit}} tokens). {{reset}}.',
          params
        )
    : bucket.scope === 'model'
      ? t(
          'usage.chat.warningModel',
          "You've used {{percent}}% of your {{windowLower}} limit for {{model}}. {{reset}}.",
          params
        )
      : t(
          'usage.chat.warningAll',
          "You've used {{percent}}% of your {{windowLower}} limit across all models. {{reset}}.",
          params
        );

  return (
    <div
      role={bucket.exceeded ? 'alert' : 'status'}
      data-testid="model-usage-notice"
      className={`mx-2 mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border p-2 text-sm ${
        bucket.exceeded
          ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-200'
          : 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200'
      }`}
    >
      <span>{text}</span>
      <Link to="/settings/usage" className="shrink-0 text-xs font-medium underline">
        {t('usage.chat.viewUsage', 'View usage')}
      </Link>
    </div>
  );
}

export default ModelUsageNotice;
