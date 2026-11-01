// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CHECKBOX_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS
} from '../people-directories/formStyles';
import { CredentialRefSelect } from '../OpenApiToolEditor';
import { fetchInstalledIntegrations } from '../../../../api/integrationsAdminApi';

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

  if (field.type === 'credential') {
    return (
      <div>
        <CredentialRefSelect
          id={inputId}
          value={value ?? ''}
          onChange={onChange}
          types={field.credentialTypes}
          label={title}
          help={description}
          required={required}
        />
        {error && (
          <p className="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (field.type === 'instance') {
    return (
      <div>
        {label}
        <InstanceSelect
          id={inputId}
          value={value ?? ''}
          onChange={onChange}
          definitionId={field.definition}
          required={required}
          describedBy={description ? helpId : undefined}
        />
        {help}
      </div>
    );
  }

  if (field.type === 'list') {
    return (
      <ListFieldTextarea
        id={inputId}
        value={value}
        onChange={onChange}
        label={label}
        help={help}
        placeholder={t('admin.integrationCatalog.wizard.onePerLine', 'One entry per line')}
        describedBy={description ? helpId : undefined}
        invalid={Boolean(error)}
      />
    );
  }

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

/** The entries of a `list` value: one per line, trimmed, blanks dropped. */
function parseListText(text) {
  return text
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * The textarea of a `list` field. The text the admin types stays as typed
 * (Enter opens a new line, spaces survive) while the value emitted is the
 * normalized list; the text is re-seeded only when the value changes from
 * outside, e.g. when the dialog loads an installation.
 */
function ListFieldTextarea({
  id,
  value,
  onChange,
  label,
  help,
  placeholder,
  describedBy,
  invalid
}) {
  const lines = Array.isArray(value) ? value : [];
  const [text, setText] = useState(() => lines.join('\n'));
  // Re-seed on an outside change only (state derived from a prop, no effect):
  // the value this text emits parses back to the same list, so typing never
  // resets the textarea.
  const [seenValue, setSeenValue] = useState(value);
  if (value !== seenValue) {
    setSeenValue(value);
    if (!sameList(parseListText(text), lines)) setText(lines.join('\n'));
  }

  return (
    <div>
      {label}
      <textarea
        id={id}
        className={`${INPUT_CLASS} font-mono`}
        rows={Math.min(8, Math.max(3, text.split('\n').length + 1))}
        value={text}
        onChange={e => {
          const raw = e.target.value;
          setText(raw);
          const next = parseListText(raw);
          onChange(next.length ? next : '');
        }}
        placeholder={placeholder}
        aria-describedby={describedBy}
        aria-invalid={invalid ? 'true' : undefined}
      />
      {help}
    </div>
  );
}

function sameList(a, b) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * Picks an installed integration of one definition (`instance` fields), e.g.
 * the iFinder installation an iAssistant installation runs on.
 */
function InstanceSelect({ id, value, onChange, definitionId, required, describedBy }) {
  const { t } = useTranslation();
  const [instances, setInstances] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetchInstalledIntegrations()
      .then(res => {
        if (cancelled) return;
        const items = (res.items || []).filter(
          item => !definitionId || item.definition === definitionId
        );
        setInstances(items);
      })
      .catch(() => {
        if (!cancelled) setInstances([]);
      });
    return () => {
      cancelled = true;
    };
  }, [definitionId]);
  const known = (instances || []).some(item => item.id === value);
  return (
    <select
      id={id}
      className={INPUT_CLASS}
      value={value}
      onChange={e => onChange(e.target.value)}
      aria-describedby={describedBy}
    >
      {!required && <option value="">{t('common.none', 'None')}</option>}
      {value && !known && <option value={value}>{value}</option>}
      {(instances || []).map(item => (
        <option key={item.id} value={item.id}>
          {item.label ? `${item.label} (${item.id})` : item.id}
        </option>
      ))}
    </select>
  );
}

export default ConfigFieldInput;
