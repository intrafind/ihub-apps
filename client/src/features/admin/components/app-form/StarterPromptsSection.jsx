// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import Icon from '../../../../shared/components/Icon';
import { CHECKBOX_CLASS, SECONDARY_BUTTON_CLASS } from '../formStyles';
import AppLanguageField, { useAppFormLanguage } from './AppLanguageField';

/**
 * StarterPromptsSection - the conversation starters of an app
 * (`app.starterPrompts`): buttons in an empty chat that put a text into the
 * message box.
 *
 * @param {object} props
 * @param {object} props.app - The app as the editor holds it.
 * @param {function(object): void} props.onChange - Receives the changed app.
 * @returns {JSX.Element}
 */
function StarterPromptsSection({ app, onChange }) {
  const { t } = useTranslation();
  const newTextLanguage = useAppFormLanguage() || 'en';
  const starters = app.starterPrompts || [];

  const setStarters = next => onChange({ ...app, starterPrompts: next });

  const updateStarter = (index, field, value) =>
    setStarters(
      starters.map((starter, i) => (i === index ? { ...starter, [field]: value } : starter))
    );

  const addStarter = () =>
    setStarters([
      ...starters,
      {
        title: { [newTextLanguage]: '' },
        message: { [newTextLanguage]: '' },
        variables: {},
        autoSend: false
      }
    ]);

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:form-cols:grid md:form-cols:grid-cols-3 md:form-cols:gap-6">
        <div className="md:form-cols:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.starterPrompts')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.edit.starterPromptsDesc')}
          </p>
        </div>
        <div className="mt-5 md:form-cols:col-span-2 md:form-cols:mt-0">
          <div className="space-y-4">
            {starters.map((starter, index) => {
              const heading = `${t('admin.apps.edit.starterPrompt')} ${index + 1}`;
              const fieldId = `starterPrompts.${index}`;
              return (
                <div
                  key={index}
                  className="border border-gray-200 dark:border-gray-600 rounded-lg p-4"
                >
                  <div className="flex justify-between items-start mb-4">
                    <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {heading}
                    </h4>
                    <button
                      type="button"
                      onClick={() => setStarters(starters.filter((_, i) => i !== index))}
                      aria-label={`${t('common.delete')}: ${heading}`}
                      className="rounded-sm p-1 text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-red-500"
                    >
                      <Icon name="trash" className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="space-y-4">
                    <AppLanguageField
                      label={t('admin.apps.edit.title')}
                      value={starter.title || {}}
                      onChange={value => updateStarter(index, 'title', value)}
                      required={true}
                      name={`${fieldId}.title`}
                    />

                    <AppLanguageField
                      label={t('admin.apps.edit.message')}
                      value={starter.message || {}}
                      onChange={value => updateStarter(index, 'message', value)}
                      required={true}
                      type="textarea"
                      name={`${fieldId}.message`}
                    />

                    <div className="flex items-center">
                      <input
                        id={`${fieldId}.autoSend`}
                        type="checkbox"
                        checked={starter.autoSend || false}
                        onChange={e => updateStarter(index, 'autoSend', e.target.checked)}
                        className={CHECKBOX_CLASS}
                      />
                      <label
                        htmlFor={`${fieldId}.autoSend`}
                        className="ml-2 block text-sm text-gray-900 dark:text-gray-100"
                      >
                        {t('admin.apps.edit.autoSendPrompt')}
                      </label>
                    </div>
                  </div>
                </div>
              );
            })}

            <button type="button" onClick={addStarter} className={SECONDARY_BUTTON_CLASS}>
              <Icon name="plus" className="h-4 w-4" />
              {t('admin.apps.edit.addStarterPrompt')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default StarterPromptsSection;
