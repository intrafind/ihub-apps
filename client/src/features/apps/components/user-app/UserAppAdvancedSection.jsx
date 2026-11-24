// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import AppLanguageField from '../../../admin/components/app-form/AppLanguageField';
import {
  CHECKBOX_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS
} from '../../../admin/components/formStyles';
import { USER_APP_LIMITS } from '../../../../../../shared/userAppContent.js';

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The texts of one part of the greeting, one per language: `{ en: 'Hello' }`. */
function greetingTexts(greeting, part) {
  const texts = {};
  for (const [language, entry] of Object.entries(isPlainObject(greeting) ? greeting : {})) {
    texts[language] = typeof entry?.[part] === 'string' ? entry[part] : '';
  }
  return texts;
}

/**
 * The greeting after one part of it changed: every language that has a text in
 * either part stays, so a language the author has only started is not lost
 * while they type.
 */
function withGreetingTexts(greeting, part, texts) {
  const other = part === 'title' ? 'subtitle' : 'title';
  const next = {};
  for (const language of new Set([...Object.keys(greeting || {}), ...Object.keys(texts || {})])) {
    if (!Object.hasOwn(texts || {}, language)) continue;
    next[language] = {
      title: '',
      subtitle: '',
      ...(greeting?.[language] || {}),
      [part]: texts[language] ?? '',
      [other]: greeting?.[language]?.[other] ?? ''
    };
  }
  return next;
}

/**
 * One checkbox with its label and a line of help under it.
 *
 * @param {object} props
 * @param {boolean} props.checked
 * @param {(checked: boolean) => void} props.onChange
 * @param {string} props.label
 * @param {string} [props.help]
 * @returns {JSX.Element}
 */
function Switch({ checked, onChange, label, help }) {
  const id = useId();
  return (
    <div>
      <div className="flex items-center">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={event => onChange(event.target.checked)}
          aria-describedby={help ? `${id}-help` : undefined}
          className={CHECKBOX_CLASS}
        />
        <label htmlFor={id} className="ml-2 block text-sm text-gray-900 dark:text-gray-100">
          {label}
        </label>
      </div>
      {help && (
        <p id={`${id}-help`} className={`${HELP_CLASS} ml-6`}>
          {help}
        </p>
      )}
    </div>
  );
}

/**
 * "Advanced" of a personal app: how the chat looks and starts. The greeting on
 * the empty chat, the input line, the answer format, a form to start with, the
 * input panel and "Auto-start". None of it gives the app a tool or a reach, so
 * no administrator switch is behind it.
 *
 * @param {object} props
 * @param {object} props.form - The form state (`userAppForm.js`).
 * @param {(form: object) => void} props.onChange - Receives the changed form state.
 * @returns {JSX.Element}
 */
function UserAppAdvancedSection({ form, onChange }) {
  const { t } = useTranslation();
  const typeId = useId();
  const rowsId = useId();
  const formatId = useId();
  const set = (key, value) => onChange({ ...form, [key]: value });

  const inputMode = isPlainObject(form.inputMode) ? form.inputMode : {};
  const startForm = isPlainObject(form.startForm) ? form.startForm : {};
  const variablesPanel = isPlainObject(form.variablesPanel) ? form.variablesPanel : {};

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6 space-y-6">
      <p className="text-sm text-gray-600 dark:text-gray-400">
        {t('userApps.edit.advanced.intro')}
      </p>

      <div className="space-y-4">
        <AppLanguageField
          label={t('userApps.edit.advanced.greetingTitle')}
          help={t('userApps.edit.advanced.greetingHelp')}
          value={greetingTexts(form.greeting, 'title')}
          onChange={texts => set('greeting', withGreetingTexts(form.greeting, 'title', texts))}
          maxLength={USER_APP_LIMITS.greetingTitle}
          name="greetingTitle"
        />
        <AppLanguageField
          label={t('userApps.edit.advanced.greetingSubtitle')}
          value={greetingTexts(form.greeting, 'subtitle')}
          onChange={texts => set('greeting', withGreetingTexts(form.greeting, 'subtitle', texts))}
          maxLength={USER_APP_LIMITS.greetingSubtitle}
          name="greetingSubtitle"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label htmlFor={typeId} className={LABEL_CLASS}>
            {t('admin.apps.edit.inputType')}
          </label>
          <select
            id={typeId}
            value={inputMode.type || 'singleline'}
            onChange={event => set('inputMode', { ...inputMode, type: event.target.value })}
            className={INPUT_CLASS}
          >
            <option value="singleline">{t('admin.apps.edit.singleLine')}</option>
            <option value="multiline">{t('admin.apps.edit.multiLine')}</option>
          </select>
        </div>
        <div>
          <label htmlFor={rowsId} className={LABEL_CLASS}>
            {t('admin.apps.edit.initialRows')}
          </label>
          <input
            id={rowsId}
            type="number"
            min={1}
            max={USER_APP_LIMITS.inputRows}
            value={inputMode.rows ?? 5}
            onChange={event => set('inputMode', { ...inputMode, rows: event.target.value })}
            aria-describedby={`${rowsId}-help`}
            className={INPUT_CLASS}
          />
          <p id={`${rowsId}-help`} className={HELP_CLASS}>
            {t('admin.apps.edit.initialRowsHint')}
          </p>
        </div>
        <div>
          <label htmlFor={formatId} className={LABEL_CLASS}>
            {t('admin.apps.edit.outputFormat')}
          </label>
          <select
            id={formatId}
            value={form.preferredOutputFormat || 'markdown'}
            onChange={event =>
              set(
                'preferredOutputFormat',
                event.target.value === 'markdown' ? '' : event.target.value
              )
            }
            className={INPUT_CLASS}
          >
            <option value="markdown">{t('userApps.edit.advanced.formatMarkdown')}</option>
            <option value="text">{t('userApps.edit.advanced.formatText')}</option>
          </select>
        </div>
      </div>

      <div className="space-y-4">
        <Switch
          checked={startForm.enabled === true}
          onChange={enabled => set('startForm', { ...startForm, enabled })}
          label={t('admin.apps.edit.startForm')}
          help={t('admin.apps.edit.startFormHelp')}
        />
        {startForm.enabled === true && (
          <AppLanguageField
            label={t('admin.apps.edit.startFormSubmitLabel')}
            value={isPlainObject(startForm.submitLabel) ? startForm.submitLabel : {}}
            onChange={submitLabel => set('startForm', { ...startForm, submitLabel })}
            maxLength={USER_APP_LIMITS.submitLabel}
            name="startFormSubmitLabel"
          />
        )}
        <Switch
          checked={variablesPanel.pinned !== false}
          onChange={pinned => set('variablesPanel', { pinned })}
          label={t('admin.apps.edit.variablesPanelPinned')}
          help={t('admin.apps.edit.variablesPanelPinnedHelp')}
        />
        <Switch
          checked={form.autoStart === true}
          onChange={autoStart => set('autoStart', autoStart)}
          label={t('admin.apps.edit.autoStart')}
          help={t('userApps.edit.advanced.autoStartHelp')}
        />
      </div>
    </div>
  );
}

export default UserAppAdvancedSection;
