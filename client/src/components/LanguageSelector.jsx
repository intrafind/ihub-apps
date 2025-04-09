import React from 'react';
import { useTranslation } from 'react-i18next';

const LanguageSelector = () => {
  const { i18n, t } = useTranslation();
  
  const changeLanguage = (language) => {
    i18n.changeLanguage(language);
  };

  return (
    <div className="language-selector">
      <select 
        value={i18n.language} 
        onChange={(e) => changeLanguage(e.target.value)}
        className="bg-transparent text-white border border-white rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-white"
      >
        <option value="en" className="text-black">{t('languages.en')}</option>
        <option value="de" className="text-black">{t('languages.de')}</option>
      </select>
    </div>
  );
};

export default LanguageSelector;