// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { getLocalizedContent } from '../../../utils/localizeContent';

/**
 * Says what a change of a provider's base URL did to its linked models: how
 * many now use the new address, and which ones were left alone because their
 * API URL does not start with the old base URL (each with that URL and a link
 * to the model, so the admin can check it).
 *
 * @param {Object} props
 * @param {{ updated: string[], skipped: Array<{ id: string, url: string }> }} props.changes -
 *   From `summarizeModelUrlChanges`
 * @param {Object[]} [props.models] - The admin model list, for display names
 * @returns {JSX.Element}
 */
function ModelUrlChangeNotice({ changes, models = [] }) {
  const { t, i18n } = useTranslation();
  const nameOf = id => {
    const model = models.find(m => m.id === id);
    return (model && getLocalizedContent(model.name, i18n.language)) || id;
  };

  return (
    <div
      role="status"
      className="mb-6 p-4 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg"
    >
      <div className="flex items-start">
        <Icon
          name="information-circle"
          className="w-5 h-5 text-blue-700 dark:text-blue-300 mr-2 shrink-0"
        />
        <div className="text-sm text-blue-800 dark:text-blue-200">
          {changes.updated.length > 0 && (
            <p>
              {t(
                'admin.providers.edit.modelUrls.updated',
                '{{count}} linked models now use the new address.',
                { count: changes.updated.length }
              )}
            </p>
          )}
          {changes.skipped.length > 0 && (
            <>
              <p className={changes.updated.length > 0 ? 'mt-2' : undefined}>
                {t(
                  'admin.providers.edit.modelUrls.skipped',
                  "These linked models were not changed, because their URL does not start with the provider's previous base URL:",
                  { count: changes.skipped.length }
                )}
              </p>
              <ul className="mt-1 list-disc pl-5">
                {changes.skipped.map(entry => (
                  <li key={entry.id}>
                    <Link
                      to={`/admin/models/${encodeURIComponent(entry.id)}`}
                      className="font-medium underline"
                    >
                      {nameOf(entry.id)}
                    </Link>{' '}
                    <span className="break-all text-blue-700 dark:text-blue-300">{entry.url}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default ModelUrlChangeNotice;
