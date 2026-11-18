// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from './Icon';
import { translateText } from '../../api/adminApi';
import { useFormValidationErrors } from '../contexts/formValidationContext';

/**
 * The key format every localized field accepts on the server
 * (`localizedStringSchema`): a two-letter language, optionally a region in
 * upper case — `de`, `pt-BR`.
 */
const LANGUAGE_CODE = /^[a-z]{2}(-[A-Z]{2})?$/;

/** `PT_br`, ` pt-br ` → `pt-BR`; the language lower case, the region upper case. */
export function canonicalLanguageCode(raw) {
  const [language = '', region, ...rest] = String(raw || '')
    .trim()
    .replace(/_/g, '-')
    .split('-');
  if (rest.length) return String(raw).trim();
  return region === undefined
    ? language.toLowerCase()
    : `${language.toLowerCase()}-${region.toUpperCase()}`;
}

export const isValidLanguageCode = code => LANGUAGE_CODE.test(code);

function LanguageInput({
  lang,
  name,
  type,
  rows = 3,
  value,
  placeholder,
  required,
  onChange,
  hasError,
  ariaLabel,
  maxLength
}) {
  const inputClass = `block w-full rounded-lg border px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-admin-accent focus:border-admin-accent ${
    hasError
      ? 'border-red-500 dark:border-red-400 focus:border-red-500'
      : 'border-admin-control-border dark:border-admin-control-border-dark'
  } ${hasError ? 'admin-form-error-field' : ''}`;
  const commonProps = {
    id: name ? `${name}.${lang}` : undefined,
    'data-field': name ? `${name}.${lang}` : undefined,
    'aria-label': ariaLabel,
    value,
    onChange: e => onChange(e.target.value),
    placeholder,
    className: inputClass,
    required,
    maxLength,
    'aria-invalid': hasError || undefined,
    'aria-describedby': hasError && name ? `${name}-error` : undefined
  };
  return type === 'textarea' ? (
    <textarea rows={rows} {...commonProps} />
  ) : (
    <input type={type} {...commonProps} />
  );
}

const DynamicLanguageEditor = ({
  label,
  value = {},
  onChange,
  required = false,
  type = 'text',
  rows = 3, // Height of a `textarea`
  placeholder = {},
  className = '',
  fieldType = null, // For nested objects like greeting.title, greeting.subtitle
  error = null, // Error message to display
  name = null, // Field name used for aria-describedby linkage to error messages
  errors = null, // Optional `{ [lang]: 'message' }` for per-language errors
  validationErrors = null, // Optional full validation-errors map; picks `${name}.${lang}` keys
  maxLength = undefined // Longest text per language; the field stops accepting more
}) => {
  const { t } = useTranslation();
  const labelId = useId();
  const contextErrors = useFormValidationErrors();
  const effectiveValidationErrors = validationErrors ?? contextErrors;
  const [showAddLanguage, setShowAddLanguage] = useState(false);
  const [newLanguageCode, setNewLanguageCode] = useState('');
  // The value and handler of the latest render: a translation answers after an
  // `await`, by which time other languages may have been edited or the target
  // language removed. The answer is applied to what the field holds then.
  const latestRef = useRef({ value, onChange });
  latestRef.current = { value, onChange };

  // If fieldType is provided, we're working with nested objects
  const currentValue = fieldType
    ? Object.keys(value).reduce((acc, lang) => {
        if (value[lang] && typeof value[lang] === 'object' && value[lang][fieldType]) {
          acc[lang] = value[lang][fieldType];
        }
        return acc;
      }, {})
    : value;

  const languages = Object.keys(currentValue);
  const commonLanguages = [
    'en',
    'de',
    'es',
    'fr',
    'it',
    'pt',
    'nl',
    'sv',
    'no',
    'da',
    'fi',
    'pl',
    'cs',
    'hu',
    'ro',
    'bg',
    'hr',
    'sk',
    'sl',
    'et',
    'lv',
    'lt',
    'ru',
    'uk',
    'zh',
    'ja',
    'ko',
    'ar',
    'he',
    'th',
    'vi',
    'hi',
    'bn',
    'ta',
    'te',
    'ml',
    'kn',
    'gu',
    'pa',
    'or',
    'as',
    'sa',
    'ne',
    'si',
    'my',
    'km',
    'lo',
    'ka',
    'am',
    'ti',
    'so',
    'sw',
    'zu',
    'xh',
    'af',
    'tr',
    'az',
    'kk',
    'ky',
    'uz',
    'tg',
    'mn',
    'bo',
    'dz',
    'mk',
    'al',
    'sq',
    'sr',
    'bs',
    'mt',
    'cy',
    'ga',
    'gd',
    'br',
    'co',
    'eu',
    'ca',
    'gl',
    'oc',
    'ast',
    'an',
    'ia',
    'ie',
    'io',
    'eo',
    'vo',
    'la',
    'grc',
    'got',
    'non',
    'ang',
    'enm',
    'gmh',
    'goh',
    'gem',
    'cel',
    'ine',
    'sla',
    'bat',
    'fin',
    'hun',
    'baq',
    'kar',
    'cau',
    'sem',
    'cus',
    'ber',
    'egy',
    'cop',
    'akk',
    'sux',
    'elx',
    'peo',
    'ave',
    'pal',
    'xpr',
    'sog',
    'xco',
    'kho',
    'zza',
    'ku',
    'ckb',
    'lrc',
    'prs',
    'tly',
    'glk',
    'mzn',
    'ryu',
    'wuu',
    'yue',
    'hak',
    'nan',
    'cdo',
    'gan',
    'hsn',
    'xiang',
    'cmn',
    'lzh',
    'och',
    'ltc',
    'mkh',
    'hmn',
    'tai',
    'aav',
    'map',
    'poz',
    'phi',
    'pqe',
    'pqw',
    'pow',
    'mp',
    'cmp',
    'emp',
    'wmp',
    'plf'
  ];

  // What "Add" would add: the typed or picked code in the server's format.
  const candidateCode = canonicalLanguageCode(newLanguageCode);
  const candidateInvalid = candidateCode !== '' && !isValidLanguageCode(candidateCode);
  const candidateTaken = languages.includes(candidateCode);

  const handleAddLanguage = () => {
    if (candidateCode && !candidateInvalid && !candidateTaken) {
      const newLanguageCode = candidateCode;
      if (fieldType) {
        // Handle nested object update
        onChange({
          ...value,
          [newLanguageCode]: {
            ...value[newLanguageCode],
            [fieldType]: ''
          }
        });
      } else {
        onChange({
          ...value,
          [newLanguageCode]: ''
        });
      }
      setNewLanguageCode('');
      setShowAddLanguage(false);
    }
  };

  const handleRemoveLanguage = lang => {
    if (fieldType) {
      const newValue = { ...value };
      if (newValue[lang] && typeof newValue[lang] === 'object') {
        delete newValue[lang][fieldType];
        // If this was the last field in the language object, remove the language entirely
        if (Object.keys(newValue[lang]).length === 0) {
          delete newValue[lang];
        }
      }
      onChange(newValue);
    } else {
      const newValue = { ...value };
      delete newValue[lang];
      onChange(newValue);
    }
  };

  const handleLanguageChange = (lang, newValue) => {
    if (fieldType) {
      onChange({
        ...value,
        [lang]: {
          ...value[lang],
          [fieldType]: newValue
        }
      });
    } else {
      onChange({
        ...value,
        [lang]: newValue
      });
    }
  };

  const handleTranslate = async lang => {
    const sourceLang = languages.find(l => l !== lang && currentValue[l]);
    if (!sourceLang) return;
    const text = fieldType ? value[sourceLang]?.[fieldType] || '' : value[sourceLang] || '';
    if (!text) return;
    try {
      const result = await translateText({ text, from: sourceLang, to: lang });
      const { value: latest, onChange: change } = latestRef.current;
      if (!Object.hasOwn(latest, lang)) return;
      change(
        fieldType
          ? { ...latest, [lang]: { ...latest[lang], [fieldType]: result.translation } }
          : { ...latest, [lang]: result.translation }
      );
    } catch (err) {
      console.error('Translation failed', err);
    }
  };

  // Only codes the server accepts (the list also holds three-letter codes).
  const availableLanguages = commonLanguages.filter(
    lang => isValidLanguageCode(lang) && !languages.includes(lang)
  );

  return (
    <div
      className={`space-y-4 ${className}`}
      data-field={name || undefined}
      role="group"
      aria-labelledby={labelId}
    >
      <div className="flex items-center justify-between">
        <span id={labelId} className="block text-sm font-medium text-gray-700 dark:text-gray-300">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </span>
        <button
          type="button"
          onClick={() => setShowAddLanguage(!showAddLanguage)}
          className="inline-flex items-center px-3 py-1 border border-transparent text-xs font-medium rounded-md text-indigo-700 dark:text-indigo-300 bg-indigo-100 dark:bg-indigo-900/50 hover:bg-indigo-200 dark:hover:bg-indigo-900 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
        >
          <Icon name="plus-circle" className="w-3 h-3 mr-1" />
          {t('admin.apps.edit.addLanguage', 'Add Language')}
        </button>
      </div>

      {showAddLanguage && (
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 space-y-3">
          <div className="flex items-center space-x-2">
            <select
              aria-label={t('admin.apps.edit.selectLanguage', 'Select...')}
              value={newLanguageCode}
              onChange={e => setNewLanguageCode(e.target.value)}
              className="block w-32 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 py-2 focus:border-indigo-500 focus:ring-indigo-500"
            >
              <option value="">{t('admin.apps.edit.selectLanguage', 'Select...')}</option>
              {availableLanguages.map(lang => (
                <option key={lang} value={lang}>
                  {lang.toUpperCase()}
                </option>
              ))}
            </select>
            <input
              type="text"
              aria-label={t('admin.apps.edit.languageCode', 'Language code (e.g., en, de, es)')}
              value={newLanguageCode}
              onChange={e => setNewLanguageCode(e.target.value)}
              aria-invalid={candidateInvalid || undefined}
              aria-describedby={candidateInvalid ? `${labelId}-code-error` : undefined}
              placeholder={t('admin.apps.edit.languageCode', 'Language code (e.g., en, de, es)')}
              className="flex-1 block rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 px-3 py-2 focus:border-indigo-500 focus:ring-indigo-500"
            />
            <button
              type="button"
              onClick={handleAddLanguage}
              disabled={!candidateCode || candidateInvalid || candidateTaken}
              className="inline-flex items-center px-3 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('admin.apps.edit.add', 'Add')}
            </button>
          </div>
          {candidateInvalid && (
            <p id={`${labelId}-code-error`} className="text-sm text-red-600 dark:text-red-400">
              {t(
                'admin.apps.edit.invalidLanguageCode',
                'Use a two-letter language code, optionally with a region: "de", "pt-BR".'
              )}
            </p>
          )}
        </div>
      )}

      <div className="space-y-3">
        {languages.map(lang => (
          <div key={lang} className="flex items-start space-x-2">
            <div className="shrink-0 w-12 pt-2">
              <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200">
                {lang.toUpperCase()}
              </span>
            </div>
            <div className="flex-1">
              <LanguageInput
                lang={lang}
                ariaLabel={
                  typeof label === 'string'
                    ? `${label} (${lang.toUpperCase()})`
                    : lang.toUpperCase()
                }
                name={name}
                type={type}
                rows={rows}
                maxLength={maxLength}
                value={currentValue[lang] || ''}
                placeholder={placeholder[lang] || ''}
                required={required && lang === 'en'}
                onChange={val => handleLanguageChange(lang, val)}
                hasError={
                  !!(
                    error ||
                    errors?.[lang] ||
                    (name &&
                      effectiveValidationErrors &&
                      effectiveValidationErrors[`${name}.${lang}`])
                  )
                }
              />
            </div>
            <div className="flex items-center space-x-1 mt-2">
              <button
                type="button"
                onClick={() => handleTranslate(lang)}
                className="p-1 text-indigo-500 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
                title={t('admin.translateField', 'Translate')}
              >
                <Icon name="globe" className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => handleRemoveLanguage(lang)}
                className="p-1 text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                aria-label={t('admin.apps.edit.removeLanguage', 'Remove language {{lang}}', {
                  lang: lang.toUpperCase()
                })}
                disabled={lang === 'en'}
              >
                <Icon name="x" className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {languages.length === 0 && (
        <div className="text-sm text-gray-500 dark:text-gray-400 italic">
          {t(
            'admin.apps.edit.noLanguages',
            'No languages configured. Add a language to get started.'
          )}
        </div>
      )}

      {error && (
        <div
          id={name ? `${name}-error` : undefined}
          role="alert"
          className="mt-1 text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </div>
      )}
    </div>
  );
};

export default DynamicLanguageEditor;
