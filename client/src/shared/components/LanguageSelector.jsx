import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIConfig } from '../contexts/UIConfigContext';
import { i18nService } from '../../i18n/i18n';

function LanguageSelector({ variant = 'header' }) {
  const { i18n, t } = useTranslation();
  const { uiConfig, isLoading } = useUIConfig();
  const [isChanging, setIsChanging] = useState(false);

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

  const selectClassName =
    variant === 'sidebar'
      ? 'bg-transparent text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-400 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800'
      : 'bg-transparent text-white border border-white rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-white cursor-pointer';

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
