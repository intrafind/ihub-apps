import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { fetchTranslations } from '../api/api';

// Import core translation files (minimal set for initial rendering)
import enCoreTranslations from './core/en.json';
import deCoreTranslations from './core/de.json';

// Initialize i18next instance
const i18nInstance = i18n
  // Detect user language
  .use(LanguageDetector)
  // Pass i18n instance to react-i18next
  .use(initReactI18next)
  // Init i18next with core translations
  .init({
    resources: {
      en: {
        translation: enCoreTranslations
      },
      de: {
        translation: deCoreTranslations
      }
    },
    fallbackLng: 'en',
    //debug: process.env.NODE_ENV === 'development',
    
    interpolation: {
      escapeValue: false, // React already escapes values
    },
    
    // Detection options
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },

    react: {
      useSuspense: true,
    }
  });

// Helper to normalize language codes (e.g., 'en-GB' -> 'en')
const normalizeLanguageCode = (languageCode) => {
  // Extract the base language code
  return languageCode?.split('-')[0].toLowerCase() || 'en';
};

// Function to load full translations from the backend
const loadFullTranslations = async (language) => {
  try {
    // Normalize the language code to simple format
    const normalizedLanguage = normalizeLanguageCode(language);
    console.log(`Loading full translations for language: ${normalizedLanguage} (from ${language})`);
    
    const translations = await fetchTranslations(normalizedLanguage);
    
    if (translations) {
      // Add the full translations, merging with core translations
      i18n.addResourceBundle(normalizedLanguage, 'translation', translations, true, true);
      console.log(`Successfully loaded translations for: ${normalizedLanguage}`);
      
      // Make sure we use the normalized language code for consistency
      if (language !== normalizedLanguage) {
        i18n.addResourceBundle(language, 'translation', translations, true, true);
      }
      
      // Emit an event that translations are loaded
      if (typeof i18n.emit === 'function') {
        i18n.emit('loaded', true);
      }
    }
  } catch (error) {
    console.error(`Failed to load translations for language: ${language}`, error);
    // Continue with core translations on error
    if (typeof i18n.emit === 'function') {
      i18n.emit('loaded', false);
    }
  }
};

// Make sure we have the changeLanguage method properly available
if (typeof i18n.changeLanguage === 'function') {
  // Store original method
  const originalChangeLanguage = i18n.changeLanguage;
  
  // Override with our enhanced version
  i18n.changeLanguage = async (lng) => {
    console.log(`Changing language to: ${lng}`);
    // First change the language using the original method
    const result = await originalChangeLanguage.call(i18n, lng);
    
    // Then load the full translations for this language
    await loadFullTranslations(lng);
    
    return result;
  };
}

// Load full translations for the current language on initialization
const currentLanguage = i18n.language || 'en';
console.log(`Initial language detected: ${currentLanguage}`);
loadFullTranslations(currentLanguage);

// Listen for language changes to load appropriate translations
if (typeof i18n.on === 'function') {
  i18n.on('languageChanged', (newLanguage) => {
    console.log(`Language changed to: ${newLanguage}`);
    loadFullTranslations(newLanguage);
  });
}

export default i18n;