import { useState } from 'react';

const COMMON_LANGS = ['en', 'de', 'fr', 'es', 'it', 'ja', 'zh'];

function LocalizedField({ label, value, onChange, placeholder, rows = 4 }) {
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  const langs = isObject ? Object.keys(value) : [];
  const [activeLang, setActiveLang] = useState(langs[0] || 'en');

  const inputClass =
    'w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 font-mono';
  const labelClass = 'block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1';

  if (!isObject) {
    return (
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs font-medium text-gray-600 dark:text-gray-400">{label}</label>
          <button
            type="button"
            onClick={() => onChange({ en: value || '' })}
            className="text-xs text-blue-500 hover:text-blue-600"
            title="Convert to multilingual"
          >
            + i18n
          </button>
        </div>
        <textarea
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
          rows={rows}
          placeholder={placeholder}
          className={inputClass}
        />
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
      <label className={labelClass}>{label}</label>
      <div className="flex items-center gap-1 mb-1 flex-wrap">
        {langs.map(lang => (
          <button
            key={lang}
            type="button"
            onClick={() => setActiveLang(lang)}
            className={`px-2 py-0.5 text-xs rounded transition-colors ${
              currentLang === lang
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 font-medium'
                : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600'
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
            className="text-xs border border-dashed border-gray-300 dark:border-gray-600 rounded px-1 py-0.5 bg-transparent text-gray-500"
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
            title={`Remove ${currentLang}`}
          >
            &#x2715;
          </button>
        )}
      </div>
      <textarea
        value={value[currentLang] ?? ''}
        onChange={e => handleLangChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className={inputClass}
      />
    </div>
  );
}

export default LocalizedField;
