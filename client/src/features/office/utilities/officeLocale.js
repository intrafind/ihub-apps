/* global Office */

const LOCALE_STORAGE_KEY = 'office_ihub_language';

export const SUPPORTED_LANGUAGES = [
  { key: 'en', label: 'English' },
  { key: 'de', label: 'Deutsch' }
];

function detectLanguage() {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored && SUPPORTED_LANGUAGES.some(l => l.key === stored)) return stored;
  } catch {
    // localStorage unavailable
  }
  try {
    const lang =
      (typeof Office !== 'undefined' && Office?.context?.displayLanguage) ||
      navigator?.language ||
      'en';
    const prefix = String(lang).toLowerCase().split('-')[0];
    const match = SUPPORTED_LANGUAGES.find(l => l.key === prefix);
    return match ? match.key : 'en';
  } catch {
    return 'en';
  }
}

export const officeLocale = detectLanguage();

export function setOfficeLocale(lang) {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, lang);
  } catch {
    // ignore
  }
  window.location.reload();
}
