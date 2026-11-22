// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useTranslation } from 'react-i18next';
import { CHECKBOX_CLASS, HELP_CLASS } from '../formStyles';

/** The switches of the section: the app field and the keys of label and help. */
const SWITCHES = [
  {
    field: 'autoStart',
    labelKey: 'admin.apps.edit.autoStart',
    helpKey: 'admin.apps.edit.autoStartHelp'
  },
  {
    field: 'ephemeral',
    labelKey: 'admin.apps.edit.ephemeral',
    helpKey: 'admin.apps.edit.ephemeralHelp'
  }
];

/**
 * ChatBehaviourSection - how a chat with the app starts and whether it is
 * stored: "Auto-start conversation" and "Ephemeral chat". A card of the
 * editor's "Chat features" group.
 *
 * @param {object} props
 * @param {object} props.app - The app as the editor holds it.
 * @param {function(object): void} props.onChange - Receives the changed app.
 * @returns {JSX.Element}
 */
function ChatBehaviourSection({ app, onChange }) {
  const { t } = useTranslation();

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:form-cols:grid md:form-cols:grid-cols-3 md:form-cols:gap-6">
        <div className="md:form-cols:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.chatBehaviour')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.edit.chatBehaviourDesc')}
          </p>
        </div>
        <div className="mt-5 space-y-4 md:form-cols:col-span-2 md:form-cols:mt-0">
          {SWITCHES.map(({ field, labelKey, helpKey }) => (
            <div key={field}>
              <div className="flex items-center">
                <input
                  id={`app-${field}`}
                  name={field}
                  type="checkbox"
                  checked={app[field] === true}
                  onChange={e => onChange({ ...app, [field]: e.target.checked })}
                  aria-describedby={`app-${field}-help`}
                  className={CHECKBOX_CLASS}
                />
                <label
                  htmlFor={`app-${field}`}
                  className="ml-2 block text-sm text-gray-900 dark:text-gray-100"
                >
                  {t(labelKey)}
                </label>
              </div>
              <p id={`app-${field}-help`} className={`${HELP_CLASS} ml-6`}>
                {t(helpKey)}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default ChatBehaviourSection;
