// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import { draftModelChoices } from './app-create/createFlow';

/**
 * The model that prepares app drafts (`platform.appGenerator.modelId`), shown
 * under the switch "App Drafts with AI" on Admin → Features.
 *
 * The first option is the automatic choice (an empty value), which names the
 * model it currently picks for an administrator. A stored model that is no
 * longer an enabled chat model stays selectable, marked as unavailable, so the
 * admin sees why drafts use the automatic choice instead of a silent reset.
 *
 * The component holds no state: the page loads the setting and saves it.
 *
 * @param {object} props
 * @param {string} props.value - The selected model ID; empty for the automatic choice.
 * @param {(modelId: string) => void} props.onChange - Called with the new model ID.
 * @param {object[]} props.models - All models of the installation (`GET /api/admin/models` items).
 * @param {boolean} [props.disabled=false] - While the feature is switched off.
 * @returns {JSX.Element}
 * @example
 * <AppDraftModelSetting value={modelId} onChange={setModelId} models={models} />
 */
function AppDraftModelSetting({ value, onChange, models, disabled = false }) {
  const { t, i18n } = useTranslation();
  const { options, automatic } = draftModelChoices(models);
  const nameOf = model => getLocalizedContent(model.name, i18n.language) || model.id;
  const unavailable = !!value && !options.some(model => model.id === value);
  const helpId = 'app-draft-model-help';

  return (
    <div className="mt-3">
      <label
        htmlFor="app-draft-model"
        className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
      >
        {t('admin.features.appGeneratorModel.label', 'Model for drafts')}
      </label>
      <select
        id="app-draft-model"
        value={value}
        onChange={event => onChange(event.target.value)}
        disabled={disabled}
        aria-describedby={helpId}
        className="block w-full max-w-md rounded-md border border-admin-control-border dark:border-admin-control-border-dark bg-white dark:bg-gray-700 text-sm text-gray-900 dark:text-gray-100 px-3 py-2 disabled:opacity-60"
      >
        <option value="">
          {automatic
            ? t('admin.features.appGeneratorModel.automaticCurrent', {
                model: nameOf(automatic),
                defaultValue: 'Automatic (recommended): currently {{model}}'
              })
            : t('admin.features.appGeneratorModel.automatic', 'Automatic (recommended)')}
        </option>
        {options.map(model => (
          <option key={model.id} value={model.id}>
            {nameOf(model)}
          </option>
        ))}
        {unavailable && (
          <option value={value}>
            {t('admin.features.appGeneratorModel.unavailableOption', {
              model: value,
              defaultValue: '{{model}} (not available)'
            })}
          </option>
        )}
      </select>
      <p id={helpId} className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        {t(
          'admin.features.appGeneratorModel.help',
          'The description of a new app is sent to this model, for admin apps and personal apps. It is used only for people whose groups may use it; everyone else gets the automatic choice: the standard chat model among the models they may use.'
        )}
      </p>
      {unavailable && (
        <p role="status" className="mt-1 text-xs text-amber-700 dark:text-amber-400">
          {t('admin.features.appGeneratorModel.unavailable', {
            model: value,
            defaultValue:
              'The model {{model}} is not an enabled chat model. Drafts use the automatic choice until you pick another model.'
          })}
        </p>
      )}
    </div>
  );
}

export default AppDraftModelSetting;
