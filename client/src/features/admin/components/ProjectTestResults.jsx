// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { formatTokenCount } from '../utils/tokenStats';

/**
 * Result of `POST /api/admin/projects/:id/test`: whether every item could be
 * read the way a chat reads it, with size and time per item and the error of
 * each item that failed.
 *
 * @param {Object} props
 * @param {{success: boolean, duration: number, items: Array<Object>, error?: string}} props.result
 * @param {() => void} props.onDismiss
 * @returns {JSX.Element}
 */
function ProjectTestResults({ result, onDismiss }) {
  const { t } = useTranslation();
  const items = result.items || [];
  const ref = useRef(null);
  // A result that lands below the fold would look as if the button did nothing.
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [result]);

  return (
    <section
      className="bg-white dark:bg-gray-800 rounded-lg shadow-xs p-6"
      ref={ref}
      data-testid="project-test-results"
    >
      <div className="flex items-center mb-4">
        <Icon
          name={result.success ? 'check-circle' : 'x-circle'}
          className={`h-5 w-5 mr-2 ${result.success ? 'text-green-700' : 'text-red-600'}`}
        />
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
          {result.success
            ? t('admin.projects.test.success', 'Every item can be read')
            : t('admin.projects.test.failed', 'Some items cannot be read')}
        </h3>
        {Number.isFinite(result.duration) && (
          <span className="ml-3 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.projects.test.duration', '{{duration}} ms', { duration: result.duration })}
          </span>
        )}
        <button
          type="button"
          onClick={onDismiss}
          aria-label={t('common.close', 'Close')}
          className="ml-auto text-gray-500 hover:text-gray-600 dark:hover:text-gray-200"
        >
          <Icon name="x" className="h-4 w-4" />
        </button>
      </div>

      {result.error && <p className="text-sm text-red-600 dark:text-red-400">{result.error}</p>}

      {items.length === 0 && !result.error && (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('admin.projects.test.noItems', 'The project has no items to test.')}
        </p>
      )}

      {items.length > 0 && (
        <ul className="divide-y divide-gray-200 dark:divide-gray-700">
          {items.map(entry => (
            <li key={entry.id} className="py-2 flex flex-wrap items-start gap-x-3 gap-y-1 text-sm">
              <Icon
                name={entry.ok ? 'check' : 'x-circle'}
                size="sm"
                className={entry.ok ? 'text-green-700 mt-0.5' : 'text-red-600 mt-0.5'}
              />
              <span className="font-medium text-gray-900 dark:text-gray-100">{entry.name}</span>
              <span className="text-gray-500 dark:text-gray-400">{entry.kind}</span>
              {entry.ok ? (
                <span className="text-gray-600 dark:text-gray-300">
                  {t('admin.projects.test.itemOk', '{{chars}} characters, ~{{tokens}} tokens', {
                    chars: (entry.chars ?? 0).toLocaleString(),
                    tokens: formatTokenCount(entry.tokens ?? 0)
                  })}
                </span>
              ) : (
                <span className="text-red-600 dark:text-red-400 break-words">
                  {entry.error}
                  {entry.code ? ` (${entry.code})` : ''}
                </span>
              )}
              <span className="ml-auto text-xs text-gray-600 dark:text-gray-400">
                {t('admin.projects.test.duration', '{{duration}} ms', {
                  duration: entry.duration ?? 0
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default ProjectTestResults;
