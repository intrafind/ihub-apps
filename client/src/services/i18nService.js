import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { fetchTranslations } from '../api/api';

class I18nService {
  constructor() {
    this.defaultLanguage = 'en';
    this.isInitialized = false;
    this.translationCache = new Map();
    this.pendingTranslations = new Map();
    this.platformConfig = null;
    this.languageChangeInProgress = false;

    // Initialize synchronously with minimal setup
    this.initializeSync();
  }

  initializeSync() {
    if (this.isInitialized) return;

    try {
      // Initialize i18next with minimal setup first (synchronous)
      i18n
        .use(LanguageDetector)
        .use(initReactI18next)
        .init({
          resources: {
            en: {
              translation: {}
            },
            de: {
              translation: {}
            }
          },
          fallbackLng: this.defaultLanguage,
          interpolation: {
            escapeValue: false
          },
          detection: {
            order: ['localStorage', 'navigator'],
            caches: ['localStorage']
          },
          react: {
            useSuspense: false // Disable suspense to avoid blocking
          }
        });

      // Set up language change listener with race condition protection
      i18n.on('languageChanged', newLanguage => {
        if (!this.languageChangeInProgress) {
          this.loadFullTranslations(newLanguage);
        }
      });

      this.isInitialized = true;

      // Load full setup asynchronously
      this.initializeAsync();
    } catch (error) {
      console.error('Failed to initialize i18n service synchronously:', error);
      this.isInitialized = true;
    }
  }

  async initializeAsync() {
    try {
      // Load platform configuration asynchronously
      await this.loadPlatformConfig();

      // Dynamically import core translations
      const [enCoreTranslations, deCoreTranslations] = await Promise.all([
        import('../../../shared/i18n/en.json'),
        import('../../../shared/i18n/de.json')
      ]);

      // Add core translations to existing i18n instance
      i18n.addResourceBundle('en', 'translation', enCoreTranslations.default, true, true);
      i18n.addResourceBundle('de', 'translation', deCoreTranslations.default, true, true);

      // Load full translations for the current language
      const currentLanguage = i18n.language || this.defaultLanguage;
      await this.loadFullTranslations(currentLanguage);
    } catch (error) {
      console.error('Failed to initialize i18n service asynchronously:', error);
    }
  }

  async loadPlatformConfig() {
    try {
      // Use fetch instead of synchronous XHR
      const response = await fetch('/api/configs/platform');
      if (response.ok) {
        this.platformConfig = await response.json();
        if (this.platformConfig?.defaultLanguage) {
          this.defaultLanguage = this.platformConfig.defaultLanguage;
        }
      }
    } catch (error) {
      console.warn('Failed to load platform configuration, using default language en:', error);
    }
  }

  normalizeLanguageCode(languageCode) {
    return languageCode?.split('-')[0].toLowerCase() || this.defaultLanguage;
  }

  async loadFullTranslations(language) {
    try {
      const normalizedLanguage = this.normalizeLanguageCode(language);

      // Check if translations are already cached
      if (this.translationCache.has(normalizedLanguage)) {
        const cachedTranslations = this.translationCache.get(normalizedLanguage);
        this.addTranslationsToI18n(normalizedLanguage, cachedTranslations);
        return;
      }

      // Check if translations are already being loaded
      if (this.pendingTranslations.has(normalizedLanguage)) {
        await this.pendingTranslations.get(normalizedLanguage);
        return;
      }

      // Load translations from API with retry logic
      const translationPromise = this.fetchAndCacheTranslationsWithRetry(normalizedLanguage);
      this.pendingTranslations.set(normalizedLanguage, translationPromise);

      const translations = await translationPromise;
      this.pendingTranslations.delete(normalizedLanguage);

      if (translations) {
        this.addTranslationsToI18n(normalizedLanguage, translations);

        // Handle different language variants
        if (language !== normalizedLanguage) {
          this.addTranslationsToI18n(language, translations);
        }

        // Emit loaded event
        if (typeof i18n.emit === 'function') {
          i18n.emit('loaded', true);
        }
      }
    } catch (error) {
      console.error(`Failed to load translations for language: ${language}`, error);
      this.pendingTranslations.delete(this.normalizeLanguageCode(language));

      if (typeof i18n.emit === 'function') {
        i18n.emit('loaded', false);
      }
    }
  }

  async fetchAndCacheTranslations(language) {
    try {
      const translations = await fetchTranslations(language);
      if (translations) {
        this.translationCache.set(language, translations);
        return translations;
      }
    } catch (error) {
      console.error(`Failed to fetch translations for ${language}:`, error);
    }
    return null;
  }

  async fetchAndCacheTranslationsWithRetry(language, maxRetries = 3) {
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const translations = await fetchTranslations(language);
        if (translations) {
          this.translationCache.set(language, translations);
          return translations;
        }
      } catch (error) {
        lastError = error;
        console.warn(
          `Failed to fetch translations for ${language} (attempt ${attempt}/${maxRetries}):`,
          error
        );

        if (attempt < maxRetries) {
          // Exponential backoff: wait 100ms, 200ms, 400ms
          const delay = 100 * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    console.error(
      `Failed to fetch translations for ${language} after ${maxRetries} attempts:`,
      lastError
    );
    return null;
  }

  addTranslationsToI18n(language, translations) {
    i18n.addResourceBundle(language, 'translation', translations, true, true);
  }

  async changeLanguage(language) {
    console.log(`Changing language to: ${language}`);

    // Prevent concurrent language changes
    if (this.languageChangeInProgress) {
      console.warn('Language change already in progress, skipping');
      return this.getCurrentLanguage();
    }

    try {
      this.languageChangeInProgress = true;

      // Change language and load translations
      await i18n.changeLanguage(language);
      await this.loadFullTranslations(language);

      return language;
    } finally {
      this.languageChangeInProgress = false;
    }
  }

  getCurrentLanguage() {
    return i18n.language || this.defaultLanguage;
  }

  getDefaultLanguage() {
    return this.defaultLanguage;
  }

  isReady() {
    return this.isInitialized;
  }

  clearCache() {
    this.translationCache.clear();
    this.pendingTranslations.clear();
  }
}

// Create singleton instance
const i18nService = new I18nService();

export default i18nService;
export { i18n };
