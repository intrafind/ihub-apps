// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { formatTokenCount } from '../../admin/utils/tokenStats';

const BADGE = 'inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-full';

/**
 * The estimate of one item: its tokens (also for a web page, an iHub page or
 * an iFinder document, whose size is only known once it is loaded) and
 * whether it belongs in the prompt (pin it) or is left to the search.
 *
 * @param {{estimate: Object|undefined}} props - One entry of the estimate's `items`.
 * @returns {JSX.Element|null}
 */
function ItemEstimate({ estimate }) {
  const { t } = useTranslation();
  if (!estimate) return null;

  const reasons = {
    small: t('projects.estimate.item.small', 'Small enough to pin into the prompt'),
    large: t('projects.estimate.item.large', 'Large: leave it to the search'),
    dynamic: t(
      'projects.estimate.item.dynamic',
      'The search terms decide what is read; it is never loaded in full'
    ),
    partial: t('projects.estimate.item.partial', 'Only part of the text could be read'),
    unmeasured: t('projects.estimate.item.unmeasured', 'Could not be read')
  };
  const badge = {
    prompt: {
      label: t('projects.estimate.item.prompt', 'Prompt'),
      className: 'bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300'
    },
    search: {
      label: t('projects.estimate.item.search', 'Search'),
      className: 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300'
    },
    unknown: {
      label: t('projects.estimate.item.unknown', 'Unknown'),
      className: 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
    }
  }[estimate.recommendation] || { label: '', className: '' };

  return (
    <div className="min-w-0" data-testid={`item-estimate-${estimate.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        {Number.isFinite(estimate.tokens) && (
          <span className="text-sm text-gray-900 dark:text-gray-100">
            {t('projects.items.tokens', '~{{tokens}} tokens', {
              tokens: formatTokenCount(estimate.tokens)
            })}
          </span>
        )}
        <span className={`${BADGE} ${badge.className}`}>{badge.label}</span>
      </div>
      <div className="mt-0.5 text-xs text-gray-500 dark:text-gray-400 break-words">
        {estimate.ok === false ? estimate.error || reasons.unmeasured : reasons[estimate.reason]}
      </div>
    </div>
  );
}

export default ItemEstimate;
