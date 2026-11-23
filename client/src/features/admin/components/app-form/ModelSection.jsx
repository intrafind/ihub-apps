// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import ResourceSelector from '../ResourceSelector';
import { getLocalizedContent } from '../../../../utils/localizeContent';
import { HELP_CLASS, INPUT_CLASS, LABEL_CLASS } from '../formStyles';

/**
 * ModelSection - which AI model answers in the app, which models users may
 * pick, and the format of the answer. The card of the editor's "Model" group.
 *
 * @param {object} props
 * @param {object} props.app - The app as the editor holds it.
 * @param {function(object): void} props.onChange - Receives the changed app.
 * @param {Array<{id: string, name: string|object}>} [props.availableModels]
 * @returns {JSX.Element}
 */
function ModelSection({ app, onChange, availableModels = [] }) {
  const { t, i18n } = useTranslation();
  const uiLanguage = String(i18n?.language || '').split('-')[0] || 'en';
  const set = (field, value) => onChange({ ...app, [field]: value });

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:form-cols:grid md:form-cols:grid-cols-3 md:form-cols:gap-6">
        <div className="md:form-cols:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.modelTitle')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.edit.modelDesc')}
          </p>
        </div>
        <div className="mt-5 md:form-cols:col-span-2 md:form-cols:mt-0">
          <div className="grid grid-cols-6 gap-6">
            <div className="col-span-6 sm:col-span-3">
              <label htmlFor="app-preferred-model" className={LABEL_CLASS}>
                {t('admin.apps.edit.preferredModel')}
              </label>
              <select
                id="app-preferred-model"
                name="preferredModel"
                value={app.preferredModel || ''}
                onChange={e => set('preferredModel', e.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">{t('admin.apps.edit.standardModel')}</option>
                {availableModels.map(model => (
                  <option key={model.id} value={model.id}>
                    {getLocalizedContent(model.name, uiLanguage) || model.id}
                  </option>
                ))}
              </select>
            </div>

            <div className="col-span-6 sm:col-span-3">
              <label htmlFor="app-output-format" className={LABEL_CLASS}>
                {t('admin.apps.edit.outputFormat')}
              </label>
              <select
                id="app-output-format"
                name="preferredOutputFormat"
                value={app.preferredOutputFormat || 'markdown'}
                onChange={e => set('preferredOutputFormat', e.target.value)}
                className={INPUT_CLASS}
              >
                <option value="markdown">{t('appConfig.markdown')}</option>
                <option value="text">{t('appConfig.plainText')}</option>
                <option value="json">{t('appConfig.json')}</option>
                <option value="html">{t('appConfig.html')}</option>
              </select>
            </div>

            <div className="col-span-6" data-field="allowedModels">
              <ResourceSelector
                label={t('admin.apps.edit.allowedModels')}
                resources={availableModels}
                selectedResources={app.allowedModels || []}
                onSelectionChange={selected => set('allowedModels', selected)}
                allowWildcard={false}
                placeholder={t('admin.apps.edit.searchModels')}
                emptyMessage={t('admin.apps.edit.noModelsSelected')}
              />
              <p className={HELP_CLASS}>{t('admin.apps.edit.allowedModelsHint')}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ModelSection;
