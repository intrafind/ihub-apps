import { useMemo, useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIConfig } from '../contexts/UIConfigContext';
import { i18nService } from '../../i18n/i18n';
import Icon from './Icon';

function LanguageSelector({ variant = 'header' }) {
  const { i18n, t } = useTranslation();
  const { uiConfig, isLoading } = useUIConfig();
  const [isChanging, setIsChanging] = useState(false);
  const [open, setOpen] = useState(false);
  const compactRef = useRef(null);

  // Close the compact popover when clicking outside
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = e => {
      if (compactRef.current && !compactRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  // Handle language change with error handling
  const changeLanguage = async language => {
    if (isChanging) return; // Prevent multiple changes at once

    try {
      setIsChanging(true);
      await i18nService.changeLanguage(language);
      console.log(`Language changed to: ${language}`);
    } catch (error) {
      console.error('Error changing language:', error);
    } finally {
      setIsChanging(false);
    }
  };

  // Extract available languages from UI config
  const availableLanguages = useMemo(() => {
    if (!uiConfig)
      return [
        { code: 'en', name: 'English' },
        { code: 'de', name: 'Deutsch' }
      ];

    // Look for language codes in the UI config
    const languages = [];

    // Using the title field as it's guaranteed to have language entries
    // Add null safety checks for header and title
    if (uiConfig.header?.title) {
      Object.keys(uiConfig.header.title).forEach(langCode => {
        const localizedName = t(`languages.${langCode}`);
        languages.push({
          code: langCode,
          // Use explicit language name if translation key doesn't resolve
          name:
            localizedName === `languages.${langCode}`
              ? langCode === 'en'
                ? 'English'
                : langCode === 'de'
                  ? 'Deutsch'
                  : langCode
              : localizedName
        });
      });
    }

    return languages.length
      ? languages
      : [
          { code: 'en', name: 'English' },
          { code: 'de', name: 'Deutsch' }
        ];
  }, [uiConfig, t]);

  if (isLoading) {
    return <div className="language-selector-loading">{t('common.loading', 'Loading...')}</div>;
  }

  // Compact variant for the sidebar: a small button showing just the current
  // language code (EN/DE); clicking opens a popover with the full names so it
  // never overlaps the neighbouring user button.
  if (variant === 'sidebar') {
    const current = (i18n.language || 'en').split('-')[0];
    return (
      <div className="relative flex-none" ref={compactRef}>
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          disabled={isChanging}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={t('common.selectLanguage', 'Select language')}
          className="flex items-center gap-1 rounded-lg border border-gray-200 dark:border-gray-700 px-2 py-1.5 text-xs font-semibold text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-indigo-400"
        >
          {current.toUpperCase()}
          <Icon
            name="chevron-down"
            size="xs"
            className={`transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
        {open && (
          <ul
            role="listbox"
            className="absolute bottom-full right-0 mb-2 min-w-[8rem] bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 py-1 z-50"
          >
            {availableLanguages.map(lang => (
              <li key={lang.code}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i18n.language === lang.code}
                  onClick={() => {
                    changeLanguage(lang.code);
                    setOpen(false);
                  }}
                  className={`flex items-center justify-between w-full px-3 py-2 text-sm text-left hover:bg-gray-100 dark:hover:bg-gray-700 ${
                    i18n.language === lang.code
                      ? 'text-indigo-600 dark:text-indigo-400 font-medium'
                      : 'text-gray-700 dark:text-gray-300'
                  }`}
                >
                  {lang.name}
                  {i18n.language === lang.code && <Icon name="check" size="sm" />}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const selectClassName =
    'bg-transparent text-white border border-white rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-white cursor-pointer';

  return (
    <div className="language-selector">
      <select
        value={i18n.language || 'en'}
        onChange={e => changeLanguage(e.target.value)}
        className={selectClassName}
        disabled={isChanging}
        aria-label={t('common.selectLanguage', 'Select language')}
      >
        {availableLanguages.map(lang => (
          <option key={lang.code} value={lang.code} className="text-black">
            {lang.name}
          </option>
        ))}
      </select>
    </div>
  );
}

export default LanguageSelector;
