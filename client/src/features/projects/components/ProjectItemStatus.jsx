// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { formatTokenCount } from '../../admin/utils/tokenStats';
import { itemErrorMessage } from '../utils/projectErrors';

const BADGE = 'inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full';

/**
 * Status of one project item (spec 3 §9): `pending` grey "waiting",
 * `extracting` with a spinner, `ready` green with its token count, `failed`
 * red with the error message, `stale` amber with "newer version at the
 * source".
 *
 * @param {{item: Object}} props
 * @returns {JSX.Element}
 */
function ProjectItemStatus({ item }) {
  const { t } = useTranslation();
  switch (item.status) {
    case 'pending':
      return (
        <span className={`${BADGE} bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300`}>
          <span className="h-1.5 w-1.5 rounded-full bg-gray-400" aria-hidden="true" />
          {t('projects.items.status.pending', 'Waiting')}
        </span>
      );
    case 'extracting':
      return (
        <span
          className={`${BADGE} bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300`}
        >
          <Icon name="arrow-path" size="xs" className="animate-spin" />
          {t('projects.items.status.extracting', 'Extracting')}
        </span>
      );
    case 'failed': {
      const message = itemErrorMessage(item, t);
      return (
        <div className="min-w-0">
          <span className={`${BADGE} bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300`}>
            {t('projects.items.status.failed', 'Failed')}
          </span>
          {message && (
            <div className="mt-1 text-xs text-red-600 dark:text-red-400 break-words">{message}</div>
          )}
        </div>
      );
    }
    case 'stale':
      return (
        <div className="min-w-0">
          <span
            className={`${BADGE} bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300`}
            title={t(
              'projects.items.status.staleHint',
              'The content changed at its origin; refresh to read it again.'
            )}
          >
            {t('projects.items.status.stale', 'Outdated')}
          </span>
          <div className="mt-1 text-xs text-amber-700 dark:text-amber-400 break-words">
            {itemErrorMessage(item, t) ||
              t('projects.items.status.staleNewer', 'Newer version at the source')}
          </div>
        </div>
      );
    case 'ready':
    default:
      return (
        <span
          className={`${BADGE} bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300`}
        >
          {t('projects.items.status.ready', 'Ready')}
          {Number.isFinite(item.text?.tokens) && (
            <span className="font-normal">
              ·{' '}
              {t('projects.items.tokens', '~{{tokens}} tokens', {
                tokens: formatTokenCount(item.text.tokens)
              })}
            </span>
          )}
        </span>
      );
  }
}

export default ProjectItemStatus;
