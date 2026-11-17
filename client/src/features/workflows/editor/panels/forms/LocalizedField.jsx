// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

const COMMON_LANGS = ['en', 'de', 'fr', 'es', 'it', 'ja', 'zh'];

/**
 * A text that is either a plain string or one text per language
 * (`{ en, de }`), edited one language at a time.
 *
 * The visible label names the field; `ariaLabel` overrides the accessible name
 * where several fields share one visible label (the options of an Ask a Person
 * step). With `singleLine` the field is a one-line input, so Enter cannot put
 * a line break into a short text such as a button label.
 *
 * @param {object} props
 * @param {string} props.label - Visible label.
 * @param {string|object} props.value - Plain text or `{ [lang]: text }`.
 * @param {(value: string|object) => void} props.onChange - Receives the new value.
 * @param {string} [props.placeholder] - Placeholder of the text field.
 * @param {number} [props.rows=4] - Rows of the text area.
 * @param {string} [props.ariaLabel] - Accessible name instead of the label.
 * @param {boolean} [props.singleLine=false] - Render a one-line input.
 */
function LocalizedField({
  label,
  value,
  onChange,
  placeholder,
  rows = 4,
  ariaLabel,
  singleLine = false
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  const langs = isObject ? Object.keys(value) : [];
  const [activeLang, setActiveLang] = useState(langs[0] || 'en');

  const inputClass =
    'w-full text-sm border border-gray-300 dark:border-gray-600 rounded-sm px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 font-mono';
  const labelClass = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1';

  /** The text field itself: a one-line input or a text area. */
  const renderField = (text, onText) =>
    singleLine ? (
      <input
        id={fieldId}
        type="text"
        value={text}
        onChange={e => onText(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={inputClass}
      />
    ) : (
      <textarea
        id={fieldId}
        value={text}
        onChange={e => onText(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={inputClass}
      />
    );

  if (!isObject) {
    return (
      <div>
        <div className="flex items-center justify-between mb-1">
          <label htmlFor={fieldId} className="text-xs font-medium text-gray-600 dark:text-gray-400">
            {label}
          </label>
          <button
            type="button"
            onClick={() => onChange({ en: value || '' })}
            className="text-xs text-blue-500 hover:text-blue-600"
            title={t(
              'workflows.editor.localizedField.addLanguagesTitle',
              'Enter this text per language'
            )}
          >
            + {t('workflows.editor.localizedField.addLanguages', 'Add languages')}
          </button>
        </div>
        {renderField(value ?? '', text => onChange(text))}
      </div>
    );
  }

  const currentLang = langs.includes(activeLang) ? activeLang : langs[0] || 'en';
  const availableToAdd = COMMON_LANGS.filter(l => !langs.includes(l));

  const handleLangChange = newText => {
    onChange({ ...value, [currentLang]: newText });
  };

  const addLang = lang => {
    onChange({ ...value, [lang]: '' });
    setActiveLang(lang);
  };

  const removeLang = lang => {
    if (langs.length <= 1) return;
    const next = { ...value };
    delete next[lang];
    onChange(next);
    if (currentLang === lang) setActiveLang(Object.keys(next)[0]);
  };

  return (
    <div>
      <label htmlFor={fieldId} className={labelClass}>
        {label}
      </label>
      <div className="flex items-center gap-1 mb-1 flex-wrap">
        {langs.map(lang => (
          <button
            key={lang}
            type="button"
            onClick={() => setActiveLang(lang)}
            aria-pressed={currentLang === lang}
            className={`px-2 py-0.5 text-xs rounded transition-colors ${
              currentLang === lang
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 font-medium'
                : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
          >
            {lang}
          </button>
        ))}
        {availableToAdd.length > 0 && (
          <select
            value=""
            onChange={e => {
              if (e.target.value) addLang(e.target.value);
            }}
            aria-label={t('workflows.editor.localizedField.addLanguage', 'Add a language')}
            className="text-xs border border-dashed border-gray-300 dark:border-gray-600 rounded-sm px-1 py-0.5 bg-transparent text-gray-500"
          >
            <option value="">+</option>
            {availableToAdd.map(l => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        )}
        {langs.length > 1 && (
          <button
            type="button"
            onClick={() => removeLang(currentLang)}
            className="text-xs text-red-400 hover:text-red-600 ml-1"
            title={t('workflows.editor.localizedField.removeLanguage', 'Remove {{lang}}', {
              lang: currentLang
            })}
            aria-label={t('workflows.editor.localizedField.removeLanguage', 'Remove {{lang}}', {
              lang: currentLang
            })}
          >
            &#x2715;
          </button>
        )}
      </div>
      {renderField(value[currentLang] ?? '', handleLangChange)}
    </div>
  );
}

export default LocalizedField;
