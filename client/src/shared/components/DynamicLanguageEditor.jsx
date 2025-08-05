import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from './Icon';
import { translateText } from '../../api/adminApi';

const DynamicLanguageEditor = ({
  label,
  value = {},
  onChange,
  required = false,
  type = 'text',
  placeholder = {},
  className = '',
  fieldType = null // For nested objects like greeting.title, greeting.subtitle
}) => {
  const { t } = useTranslation();
  const [showAddLanguage, setShowAddLanguage] = useState(false);
  const [newLanguageCode, setNewLanguageCode] = useState('');

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

  const handleAddLanguage = () => {
    if (newLanguageCode && !languages.includes(newLanguageCode)) {
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
      handleLanguageChange(lang, result.translation);
    } catch (err) {
      console.error('Translation failed', err);
    }
  };

  const availableLanguages = commonLanguages.filter(lang => !languages.includes(lang));

  return (
    <div className={`space-y-4 ${className}`}>
      <div className="flex items-center justify-between">
        <label className="block text-sm font-medium text-gray-700">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
        <button
          type="button"
          onClick={() => setShowAddLanguage(!showAddLanguage)}
          className="inline-flex items-center px-3 py-1 border border-transparent text-xs font-medium rounded-md text-indigo-700 bg-indigo-100 hover:bg-indigo-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
        >
          <Icon name="plus-circle" className="w-3 h-3 mr-1" />
          {t('admin.apps.edit.addLanguage', 'Add Language')}
        </button>
      </div>

      {showAddLanguage && (
        <div className="bg-gray-50 rounded-lg p-4 space-y-3">
          <div className="flex items-center space-x-2">
            <select
              value={newLanguageCode}
              onChange={e => setNewLanguageCode(e.target.value)}
              className="block w-32 rounded-lg border-gray-300 px-3 py-2 focus:border-indigo-500 focus:ring-indigo-500"
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
              value={newLanguageCode}
              onChange={e => setNewLanguageCode(e.target.value.toLowerCase())}
              placeholder={t('admin.apps.edit.languageCode', 'Language code (e.g., en, de, es)')}
              className="flex-1 block rounded-lg border-gray-300 px-3 py-2 focus:border-indigo-500 focus:ring-indigo-500"
            />
            <button
              type="button"
              onClick={handleAddLanguage}
              disabled={!newLanguageCode || languages.includes(newLanguageCode)}
              className="inline-flex items-center px-3 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('admin.apps.edit.add', 'Add')}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {languages.map(lang => (
          <div key={lang} className="flex items-start space-x-2">
            <div className="flex-shrink-0 w-12 pt-2">
              <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                {lang.toUpperCase()}
              </span>
            </div>
            <div className="flex-1">
              {type === 'textarea' ? (
                <textarea
                  value={currentValue[lang] || ''}
                  onChange={e => handleLanguageChange(lang, e.target.value)}
                  placeholder={placeholder[lang] || ''}
                  rows={3}
                  className="block w-full rounded-lg border-gray-300 px-3 py-2 focus:border-indigo-500 focus:ring-indigo-500"
                  required={required && lang === 'en'}
                />
              ) : (
                <input
                  type={type}
                  value={currentValue[lang] || ''}
                  onChange={e => handleLanguageChange(lang, e.target.value)}
                  placeholder={placeholder[lang] || ''}
                  className="block w-full rounded-lg border-gray-300 px-3 py-2 focus:border-indigo-500 focus:ring-indigo-500"
                  required={required && lang === 'en'}
                />
              )}
            </div>
            <div className="flex items-center space-x-1 mt-2">
              <button
                type="button"
                onClick={() => handleTranslate(lang)}
                className="p-1 text-indigo-500 hover:text-indigo-700"
                title={t('admin.translateField', 'Translate')}
              >
                <Icon name="globe" className="w-4 h-4" />
              </button>
              <button
                type="button"
                onClick={() => handleRemoveLanguage(lang)}
                className="p-1 text-red-500 hover:text-red-700"
                disabled={lang === 'en'}
              >
                <Icon name="x" className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {languages.length === 0 && (
        <div className="text-sm text-gray-500 italic">
          {t(
            'admin.apps.edit.noLanguages',
            'No languages configured. Add a language to get started.'
          )}
        </div>
      )}
    </div>
  );
};

export default DynamicLanguageEditor;
