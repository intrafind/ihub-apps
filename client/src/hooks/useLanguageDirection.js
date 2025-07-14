import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

const RTL_LANGUAGES = ['ar', 'he', 'fa', 'ur'];

export default function useLanguageDirection() {
  const { i18n } = useTranslation();

  useEffect(() => {
    const updateDir = (lng) => {
      const lang = (lng || i18n.language || '').split('-')[0];
      document.documentElement.dir = RTL_LANGUAGES.includes(lang) ? 'rtl' : 'ltr';
    };
    updateDir(i18n.language);
    i18n.on('languageChanged', updateDir);
    return () => i18n.off('languageChanged', updateDir);
  }, [i18n]);
}
