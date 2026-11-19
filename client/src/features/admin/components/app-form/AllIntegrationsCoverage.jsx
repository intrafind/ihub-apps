// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { CHECKBOX_CLASS } from '../formStyles';

/**
 * What the app's "All integrations" binding (`"*"`) does to one integration
 * the app does not bind by itself: it is included, or left out by the
 * binding's `exclude`, with a switch that adds or removes the integration's
 * own key there. Excluded through a broader key (its definition or type), the
 * switch is read-only and names that key.
 *
 * @param {Object} props
 * @param {string} props.idPrefix - unique prefix for the input's id
 * @param {string} props.itemKey - the integration's own binding key
 * @param {string|null} props.excludedBy - the `exclude` entry that leaves it out, null when covered
 * @param {(excluded: boolean) => void} props.onExcludeChange
 * @param {string} [props.className]
 */
function AllIntegrationsCoverage({ idPrefix, itemKey, excludedBy, onExcludeChange, className }) {
  const { t } = useTranslation();
  const inputId = `${idPrefix}-exclude-all`;
  const byOtherKey = Boolean(excludedBy) && excludedBy !== itemKey;
  return (
    <div className={className} data-testid={`all-integrations-coverage-${itemKey}`}>
      <p className="text-xs text-gray-600 dark:text-gray-400">
        {excludedBy
          ? t('admin.apps.edit.integrations.allExcluded', 'Left out of "All integrations".')
          : t(
              'admin.apps.edit.integrations.allIncluded',
              'Included through "All integrations". Tick it to give it settings of its own.'
            )}
      </p>
      <label
        htmlFor={inputId}
        className="mt-1 inline-flex items-start gap-2 text-sm text-gray-800 dark:text-gray-200"
      >
        <input
          id={inputId}
          type="checkbox"
          className={`${CHECKBOX_CLASS} mt-0.5`}
          checked={Boolean(excludedBy)}
          disabled={byOtherKey}
          onChange={e => onExcludeChange(e.target.checked)}
        />
        <span>
          {t('admin.apps.edit.integrations.excludeFromAll', 'Exclude from "All integrations"')}
          {byOtherKey && (
            <span className="ml-1 font-mono text-xs text-gray-500 dark:text-gray-400">
              ({excludedBy})
            </span>
          )}
        </span>
      </label>
    </div>
  );
}

export default AllIntegrationsCoverage;
