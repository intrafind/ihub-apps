// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CHECKBOX_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS
} from '../people-directories/formStyles';

/** A localized definition string (`{ en, de }` or plain text). */
export function pickText(value, language, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') return value;
  return value[language] || value.en || Object.values(value)[0] || fallback;
}

/**
 * One typed install field of an integration definition (`ConfigField`),
 * rendered for the install wizard. Secrets are entered here but travel in
 * `secrets`, never in `values`.
 *
 * @param {Object} props
 * @param {Object} props.field - the ConfigField
 * @param {unknown} props.value
 * @param {(value: unknown) => void} props.onChange
 * @param {string} props.language
 * @param {string} [props.error]
 * @param {boolean} [props.secretStored] - a secret exists on the server (edit mode)
 */
function ConfigFieldInput({ field, value, onChange, language, error, secretStored = false }) {
  const { t, i18n } = useTranslation();
  const lang = language || i18n.language || 'en';
  const reactId = useId();
  const inputId = `cf-${field.key}-${reactId}`;
  const helpId = `${inputId}-help`;
  const title = pickText(field.title, lang, field.key);
  const description = pickText(field.description, lang);
  const required = field.required && !field.sensitive;

  const label = (
    <label htmlFor={inputId} className={LABEL_CLASS}>
      {title}
      {required && <span className="text-red-600 dark:text-red-400 ml-0.5">*</span>}
    </label>
  );

  const help = (
    <>
      {description && (
        <p id={helpId} className={HELP_CLASS}>
          {description}
        </p>
      )}
      {error && (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
    </>
  );

  if (field.type === 'boolean') {
    return (
      <div>
        <label className="inline-flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            id={inputId}
            type="checkbox"
            className={`${CHECKBOX_CLASS} mt-0.5`}
            checked={Boolean(value)}
            onChange={e => onChange(e.target.checked)}
            aria-describedby={description ? helpId : undefined}
          />
          <span>{title}</span>
        </label>
        {help}
      </div>
    );
  }

  if (field.type === 'enum') {
    return (
      <div>
        {label}
        <select
          id={inputId}
          className={INPUT_CLASS}
          value={value ?? ''}
          onChange={e => {
            const raw = e.target.value;
            const choice = (field.choices || []).find(c => String(c.value) === raw);
            onChange(choice ? choice.value : raw);
          }}
          aria-describedby={description ? helpId : undefined}
        >
          {!required && <option value="">{t('common.none', 'None')}</option>}
          {(field.choices || []).map(choice => (
            <option key={String(choice.value)} value={String(choice.value)}>
              {pickText(choice.label, lang, String(choice.value))}
            </option>
          ))}
        </select>
        {help}
      </div>
    );
  }

  if (field.type === 'secret') {
    return (
      <div>
        {label}
        <input
          id={inputId}
          type="password"
          autoComplete="new-password"
          className={INPUT_CLASS}
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
          placeholder={
            secretStored
              ? t('admin.integrationCatalog.wizard.secretStored', 'Stored. Leave empty to keep it.')
              : ''
          }
          aria-describedby={description ? helpId : undefined}
        />
        {help}
      </div>
    );
  }

  if (field.type === 'number') {
    return (
      <div>
        {label}
        <input
          id={inputId}
          type="number"
          className={INPUT_CLASS}
          value={value ?? ''}
          min={field.min}
          max={field.max}
          onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          aria-describedby={description ? helpId : undefined}
          aria-invalid={error ? 'true' : undefined}
        />
        {help}
      </div>
    );
  }

  const listId = field.suggestions?.length ? `${inputId}-list` : undefined;
  return (
    <div>
      {label}
      <input
        id={inputId}
        type={field.type === 'url' ? 'url' : 'text'}
        className={INPUT_CLASS}
        value={value ?? ''}
        list={listId}
        pattern={field.pattern || undefined}
        onChange={e => onChange(e.target.value)}
        placeholder={field.type === 'url' ? 'https://' : undefined}
        aria-describedby={description ? helpId : undefined}
        aria-invalid={error ? 'true' : undefined}
      />
      {listId && (
        <datalist id={listId}>
          {field.suggestions.map(s => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
      {help}
    </div>
  );
}

export default ConfigFieldInput;
