// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { CHECKBOX_CLASS } from '../formStyles';

/** The controls users can be given in the chat: the settings key and its label. */
const USER_SETTINGS = [
  { key: 'model', labelKey: 'admin.apps.edit.enableModelSelection' },
  { key: 'outputFormat', labelKey: 'admin.apps.edit.enableOutputFormat' },
  { key: 'chatHistory', labelKey: 'admin.apps.edit.enableChatHistory' },
  { key: 'style', labelKey: 'admin.apps.edit.enableStyleControl' }
];

/**
 * SettingsConfigSection - what users can change in a chat with the app. Each
 * switch shows or hides one control in the chat.
 *
 * @param {object} props
 * @param {object} props.app - The app as the editor holds it.
 * @param {function(object): void} props.onChange - Receives the changed app.
 * @param {function} props.t - The translation function.
 * @returns {JSX.Element}
 */
function SettingsConfigSection({ app, onChange, t }) {
  const handleSettingChange = (key, enabled) => {
    onChange({
      ...app,
      settings: {
        ...app.settings,
        [key]: { enabled }
      }
    });
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:form-cols:grid md:form-cols:grid-cols-3 md:form-cols:gap-6">
        <div className="md:form-cols:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.settings')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.edit.settingsDesc')}
          </p>
        </div>
        <div className="mt-5 md:form-cols:col-span-2 md:form-cols:mt-0">
          <div className="space-y-4">
            {USER_SETTINGS.map(({ key, labelKey }) => (
              <div key={key} className="flex items-center">
                <input
                  id={`app-settings-${key}`}
                  name={`settings.${key}.enabled`}
                  type="checkbox"
                  checked={app.settings?.[key]?.enabled !== false}
                  onChange={e => handleSettingChange(key, e.target.checked)}
                  className={CHECKBOX_CLASS}
                />
                <label
                  htmlFor={`app-settings-${key}`}
                  className="ml-2 block text-sm text-gray-900 dark:text-gray-100"
                >
                  {t(labelKey)}
                </label>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default SettingsConfigSection;
