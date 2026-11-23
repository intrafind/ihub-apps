// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import ModelPickList from '../ModelPickList';
import { FIELD, LABEL, STEP_INTRO, STEP_TITLE } from './connectStyles';

/**
 * Step 4, pick models: the import dialog's model list (context window,
 * vision, tools and the iHub id per model), with search and an id prefix.
 * The page owns the selection; see ModelPickList for the row props.
 *
 * @param {Object} props
 * @param {number} props.total - Models the endpoint listed
 * @param {number} props.selectedCount
 * @param {string} props.search
 * @param {(value: string) => void} props.onSearch
 * @param {string} props.prefix
 * @param {(value: string) => void} props.onPrefix
 * @param {boolean} props.hasAzureDeployments - Show the Azure deployment hint
 * @param {Object} props.listProps - Props passed to ModelPickList
 */
function ModelsStep({
  total,
  selectedCount,
  search,
  onSearch,
  prefix,
  onPrefix,
  hasAzureDeployments,
  listProps
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <div>
        <h2 className={STEP_TITLE}>{t('admin.providers.connect.models.title', 'Pick models')}</h2>
        <p className={STEP_INTRO}>
          {t(
            'admin.providers.connect.models.intro',
            'Each picked model is added, enabled and linked to the provider: it uses the provider’s endpoint and key, so none is stored on the model.'
          )}
        </p>
      </div>

      {hasAzureDeployments && (
        <p className="rounded-md bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-300">
          {t(
            'admin.models.import.azureHint',
            'Azure lists the models your resource offers, not your deployments. Enter the name of the deployment for each model you pick; it is sent as the model name.'
          )}
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="connect-search" className={LABEL}>
            {t('common.search', 'Search')}
          </label>
          <input
            id="connect-search"
            type="search"
            value={search}
            onChange={e => onSearch(e.target.value)}
            className={FIELD}
          />
        </div>
        <div>
          <label htmlFor="connect-prefix" className={LABEL}>
            {t('admin.models.import.idPrefix', 'ID prefix')}
          </label>
          <input
            id="connect-prefix"
            type="text"
            value={prefix}
            onChange={e => onPrefix(e.target.value)}
            className={FIELD}
          />
        </div>
      </div>

      <p className="text-sm text-gray-600 dark:text-gray-400" aria-live="polite">
        {t('admin.providers.connect.models.selected', '{{selected}} of {{total}} models picked', {
          selected: selectedCount,
          total
        })}
      </p>

      {total === 0 ? (
        <p className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
          {t('admin.models.import.noModels', 'The endpoint lists no models.')}
        </p>
      ) : (
        <ModelPickList {...listProps} />
      )}
    </div>
  );
}

export default ModelsStep;
