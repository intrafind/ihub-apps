// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import AppLanguageField from './AppLanguageField';

/**
 * A text of the app for reading: each language as a block that keeps its line
 * breaks, can be focused and scrolled with the keyboard, and selected. A
 * disabled field is none of that.
 *
 * @param {object} props
 * @param {string} props.label
 * @param {Object<string, string>} props.value - The text by language.
 * @param {string} props.name - For the test id.
 * @returns {JSX.Element|null}
 */
function ReadOnlyText({ label, value, name }) {
  const entries = Object.entries(value || {}).filter(
    ([, text]) => typeof text === 'string' && text.trim() !== ''
  );
  if (entries.length === 0) return null;
  return (
    <div className="mb-6">
      <p className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</p>
      {entries.map(([language, text]) => (
        <pre
          key={language}
          data-testid={`read-only-${name}`}
          lang={language}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable region must be keyboard reachable
          tabIndex={0}
          className="mb-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-gray-200 bg-gray-50 p-3 font-sans text-sm text-gray-800 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
        >
          {entries.length > 1 && (
            <span className="mb-1 block text-xs font-semibold uppercase text-gray-600 dark:text-gray-400">
              {language}
            </span>
          )}
          {text}
        </pre>
      ))}
    </div>
  );
}

/**
 * SystemInstructionsSection - the instructions of a chat app (its system
 * prompt), the hint in the message box and the message template.
 *
 * @param {object} props
 * @param {object} props.app - The app as the editor holds it.
 * @param {function(object): void} props.onChange - Receives the changed app.
 * @param {function} props.t - The translation function.
 * @param {Object<string, string>} [props.validationErrors] - Messages by field.
 * @param {string} [props.description] - The line under the heading; the admin text
 *   ("users do not see it") by default. A personal app says who can read it.
 * @param {boolean} [props.readOnly=false] - Show the texts for reading: they stay
 *   focusable and scrollable, where a disabled field is neither.
 * @returns {JSX.Element}
 */
function SystemInstructionsSection({
  app,
  onChange,
  t,
  validationErrors = {},
  description,
  readOnly = false
}) {
  const set = (field, value) => onChange({ ...app, [field]: value });

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:form-cols:grid md:form-cols:grid-cols-3 md:form-cols:gap-6">
        <div className="md:form-cols:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.systemInstructions')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {description ?? t('admin.apps.edit.systemInstructionsDesc')}
          </p>
        </div>
        {readOnly ? (
          <div className="mt-5 md:form-cols:col-span-2 md:form-cols:mt-0">
            <ReadOnlyText
              label={t('admin.apps.edit.systemInstructions')}
              value={app.system}
              name="system"
            />
            <ReadOnlyText
              label={t('admin.apps.edit.messagePlaceholder')}
              value={app.messagePlaceholder}
              name="messagePlaceholder"
            />
            <ReadOnlyText label={t('admin.apps.edit.prompt')} value={app.prompt} name="prompt" />
          </div>
        ) : (
          <div className="mt-5 md:form-cols:col-span-2 md:form-cols:mt-0">
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
        )}
      </div>
    </div>
  );
}

export default SystemInstructionsSection;
