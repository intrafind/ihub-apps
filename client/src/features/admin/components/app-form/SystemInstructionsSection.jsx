// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import AppLanguageField from './AppLanguageField';

/**
 * SystemInstructionsSection - the instructions of a chat app (its system
 * prompt), the hint in the message box and the message template.
 *
 * @param {object} props
 * @param {object} props.app - The app as the editor holds it.
 * @param {function(object): void} props.onChange - Receives the changed app.
 * @param {function} props.t - The translation function.
 * @param {Object<string, string>} [props.validationErrors] - Messages by field.
 * @returns {JSX.Element}
 */
function SystemInstructionsSection({ app, onChange, t, validationErrors = {} }) {
  const set = (field, value) => onChange({ ...app, [field]: value });

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="form-cols:grid form-cols:grid-cols-3 form-cols:gap-6">
        <div className="form-cols:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.systemInstructions')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t('admin.apps.edit.systemInstructionsDesc')}
          </p>
        </div>
        <div className="mt-5 form-cols:col-span-2 form-cols:mt-0">
          <AppLanguageField
            label={t('admin.apps.edit.systemInstructions')}
            value={app.system || {}}
            onChange={value => set('system', value)}
            required={true}
            type="textarea"
            className="mb-6"
            error={validationErrors.system}
            name="system"
          />

          <AppLanguageField
            label={t('admin.apps.edit.messagePlaceholder')}
            help={t('admin.apps.edit.messagePlaceholderHelp')}
            value={app.messagePlaceholder || {}}
            onChange={value => set('messagePlaceholder', value)}
            className="mb-6"
            name="messagePlaceholder"
          />

          <AppLanguageField
            label={t('admin.apps.edit.prompt')}
            // The placeholder is text for the reader, not a value to fill in.
            help={t('admin.apps.edit.promptHelp', { content: '{{content}}' })}
            value={app.prompt || {}}
            onChange={value => set('prompt', value)}
            type="textarea"
            name="prompt"
          />
        </div>
      </div>
    </div>
  );
}

export default SystemInstructionsSection;
