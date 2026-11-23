// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import IconPicker from '../../../../shared/components/IconPicker';
import { getLocalizedContent } from '../../../../utils/localizeContent';
import { DEFAULT_APP_COLOR } from '../../../../../../shared/appDefaults.js';
import { appCategoryOptions } from '../../utils/appDraft';
import { HELP_CLASS, INPUT_CLASS, LABEL_CLASS } from '../formStyles';
import AppLanguageField from './AppLanguageField';

const ERROR_CLASS = 'mt-1 text-sm text-red-600 dark:text-red-400';

/**
 * BasicInfoSection - what users see of the app in the app list: name, short
 * description, icon, colour and category. App type and position in the list
 * sit in a collapsed "More details".
 *
 * The app ID is not edited here: it is fixed when the app is created and the
 * editor's header shows it. Whether the app is published is set with the
 * header's Publish action, not in the form.
 *
 * @param {object} props
 * @param {object} props.app - The app as the editor holds it.
 * @param {function(object): void} props.onChange - Receives the changed app.
 * @param {function} props.t - The translation function.
 * @param {string} props.currentLanguage - The UI language, for category names.
 * @param {object|null} props.uiConfig - The UI configuration (categories).
 * @param {Object<string, string>} [props.validationErrors] - Messages by field.
 * @returns {JSX.Element}
 */
function BasicInfoSection({ app, onChange, t, currentLanguage, uiConfig, validationErrors = {} }) {
  const set = (field, value) => onChange({ ...app, [field]: value });
  const uiLanguage = String(currentLanguage || '').split('-')[0] || 'en';
  const categories = appCategoryOptions(uiConfig, app.category);

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:form-cols:grid md:form-cols:grid-cols-3 md:form-cols:gap-6">
        <div className="md:form-cols:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.basicInfo')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.edit.basicInfoDesc')}
          </p>
          <p className={HELP_CLASS}>{t('admin.apps.create.requiredHint')}</p>
        </div>
        <div className="mt-5 md:form-cols:col-span-2 md:form-cols:mt-0">
          <div className="grid grid-cols-6 gap-6">
            <div className="col-span-6">
              <AppLanguageField
                label={t('admin.apps.edit.name')}
                value={app.name || {}}
                onChange={value => set('name', value)}
                required={true}
                error={validationErrors.name}
                name="name"
              />
            </div>

            <div className="col-span-6">
              <AppLanguageField
                label={t('admin.apps.edit.description')}
                value={app.description || {}}
                onChange={value => set('description', value)}
                required={true}
                type="textarea"
                error={validationErrors.description}
                name="description"
              />
            </div>

            <div className="col-span-6 sm:col-span-3">
              <span id="app-icon-label" className={LABEL_CLASS}>
                {t('admin.apps.edit.icon')}
                <span className="text-red-500 ml-1" aria-hidden="true">
                  *
                </span>
              </span>
              <div data-field="icon">
                <IconPicker
                  value={app.icon || ''}
                  onChange={value => set('icon', value)}
                  error={validationErrors.icon}
                  labelledBy="app-icon-label"
                />
              </div>
            </div>

            <div className="col-span-6 sm:col-span-3">
              <label htmlFor="color" className={LABEL_CLASS}>
                {t('admin.apps.edit.color')}
                <span className="text-red-500 ml-1" aria-hidden="true">
                  *
                </span>
              </label>
              <input
                id="color"
                type="color"
                required
                value={app.color || DEFAULT_APP_COLOR}
                onChange={e => set('color', e.target.value)}
                className={`block w-full h-10 rounded-md border border-admin-control-border dark:border-admin-control-border-dark shadow-xs focus:border-admin-accent focus:ring-admin-accent sm:text-sm ${
                  validationErrors.color ? 'border-red-500 dark:border-red-400' : ''
                }`}
                aria-invalid={!!validationErrors.color || undefined}
                aria-describedby={validationErrors.color ? 'color-error' : undefined}
              />
              {validationErrors.color && (
                <p id="color-error" role="alert" className={ERROR_CLASS}>
                  {validationErrors.color}
                </p>
              )}
            </div>

            <div className="col-span-6 sm:col-span-3">
              <label htmlFor="app-category" className={LABEL_CLASS}>
                {t('admin.apps.edit.category')}
              </label>
              <select
                id="app-category"
                name="category"
                value={app.category || ''}
                onChange={e => set('category', e.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">{t('admin.apps.edit.selectCategory')}</option>
                {categories.map(category => (
                  <option key={category.id} value={category.id}>
                    {getLocalizedContent(category.name, uiLanguage) || category.id}
                  </option>
                ))}
              </select>
            </div>

            <details className="col-span-6" data-testid="app-more-details">
              <summary className="cursor-pointer text-sm font-medium text-gray-700 dark:text-gray-300 rounded-sm focus:outline-hidden focus-visible:ring-2 focus-visible:ring-admin-accent dark:focus-visible:ring-admin-accent-fg-dark">
                {t('admin.apps.edit.moreDetails')}
              </summary>
              <div className="mt-4 grid grid-cols-6 gap-6">
                <div className="col-span-6 sm:col-span-3">
                  <label htmlFor="app-type" className={LABEL_CLASS}>
                    {t('admin.apps.edit.appType')}
                  </label>
                  <select
                    id="app-type"
                    name="type"
                    value={app.type || 'chat'}
                    onChange={e => set('type', e.target.value)}
                    aria-describedby="app-type-help"
                    className={INPUT_CLASS}
                  >
                    <option value="chat">{t('admin.apps.edit.typeChat')}</option>
                    <option value="iframe">{t('admin.apps.edit.typeIframe')}</option>
                    <option value="redirect">{t('admin.apps.edit.typeRedirect')}</option>
                  </select>
                  <p id="app-type-help" className={HELP_CLASS}>
                    {t('admin.apps.edit.appTypeHint')}
                  </p>
                </div>

                <div className="col-span-6 sm:col-span-3">
                  <label htmlFor="app-order" className={LABEL_CLASS}>
                    {t('admin.apps.edit.order')}
                  </label>
                  <input
                    id="app-order"
                    name="order"
                    type="number"
                    value={app.order || 0}
                    onChange={e => set('order', Number.parseInt(e.target.value) || 0)}
                    className={INPUT_CLASS}
                  />
                </div>
              </div>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
}

export default BasicInfoSection;
