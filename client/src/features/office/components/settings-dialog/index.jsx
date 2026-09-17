import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { officeLocale, SUPPORTED_LANGUAGES, setOfficeLocale } from '../../utilities/officeLocale';
import {
  THEME_PREFERENCES,
  getStoredThemePreference,
  setThemePreference
} from '../../utilities/officeTheme';
import { useEmbeddedHost } from '../../contexts/EmbeddedHostContext';

/**
 * Per-user settings for the embedded chat shell: account, UI language and
 * appearance (light / dark / auto). Language and appearance persist in the
 * host's localStorage, so they survive Outlook restarts (issue #2366).
 *
 * The form is mounted only while the dialog is open so every open starts from
 * the persisted values — a selection abandoned with Cancel must not linger
 * until the next open.
 */
export default function SettingsDialog({ user, isOpen, onClose }) {
  if (!isOpen) return null;
  return <SettingsForm user={user} onClose={onClose} />;
}

function SettingsForm({ user, onClose }) {
  const { t } = useTranslation();
  const host = useEmbeddedHost();
  const [selectedLanguage, setSelectedLanguage] = useState(officeLocale);
  const [selectedTheme, setSelectedTheme] = useState(getStoredThemePreference);

  const themeLabels = {
    light: t('office.settingsDialog.appearanceLight', 'Light'),
    dark: t('office.settingsDialog.appearanceDark', 'Dark'),
    auto: t('office.settingsDialog.appearanceAuto', 'Automatic')
  };
  // In Outlook, auto follows the Office theme (Mailbox 1.14+) before the OS
  // setting; in the browser-extension side panel only the OS setting exists.
  const appearanceHint =
    host.kind === 'office'
      ? t(
          'office.settingsDialog.appearanceHintOffice',
          'Automatic follows the Outlook theme (or the system setting on older Outlook versions).'
        )
      : t('office.settingsDialog.appearanceHintSystem', 'Automatic follows the system setting.');

  const handleSave = () => {
    // Appearance applies immediately — no reload needed.
    setThemePreference(selectedTheme);
    if (selectedLanguage !== officeLocale) {
      // Reloads the pane; the saved appearance is re-applied on boot.
      setOfficeLocale(selectedLanguage);
    } else {
      onClose?.();
    }
  };

  const displayName =
    user?.name || user?.preferred_username || user?.username || user?.email || 'User';
  const initials = displayName
    .split(' ')
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);

  const selectClassName =
    'w-full rounded-md border border-slate-300 bg-white px-2 sm:px-3 py-1.5 sm:py-2 text-sm text-slate-900 focus:outline-hidden focus:ring-2 focus:ring-slate-400 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100 dark:focus:ring-slate-500';
  const sectionLabelClassName =
    'text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 dark:text-slate-400';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-2 sm:p-4 dark:bg-black/60"
      onClick={e => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-sm sm:max-w-md max-h-[90vh] overflow-y-auto dark:bg-slate-800">
        <div className="flex items-center justify-between px-3 py-2 sm:px-4 sm:py-3 border-b border-slate-200 dark:border-slate-700">
          <h2 className="text-sm sm:text-base font-semibold text-slate-900 dark:text-slate-100">
            {t('office.settingsDialog.title', 'Settings')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-1 text-slate-500 hover:text-slate-900 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-700"
          >
            <XMarkIcon className="h-5 w-5" aria-hidden />
          </button>
        </div>

        <div className="p-3 sm:p-4 flex flex-col gap-4 sm:gap-5">
          <div>
            <p className={sectionLabelClassName}>{t('office.settingsDialog.account', 'Account')}</p>
            <div className="flex items-center gap-2 sm:gap-3 px-2 py-2 sm:px-3 sm:py-2.5 bg-slate-50 rounded-lg border border-slate-200 dark:bg-slate-900/60 dark:border-slate-700">
              <div className="shrink-0 w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-slate-800 flex items-center justify-center text-white text-xs sm:text-sm font-semibold dark:bg-slate-600">
                {initials}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-slate-900 truncate dark:text-slate-100">
                  {displayName}
                </p>
                {user?.email && (
                  <p className="text-xs text-slate-500 truncate dark:text-slate-400">
                    {user.email}
                  </p>
                )}
              </div>
            </div>
          </div>

          <div>
            <label htmlFor="office-settings-language" className={`block ${sectionLabelClassName}`}>
              {t('office.settingsDialog.language', 'Language')}
            </label>
            <select
              id="office-settings-language"
              value={selectedLanguage}
              onChange={e => setSelectedLanguage(e.target.value)}
              className={selectClassName}
            >
              {SUPPORTED_LANGUAGES.map(({ key, label }) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label
              htmlFor="office-settings-appearance"
              className={`block ${sectionLabelClassName}`}
            >
              {t('office.settingsDialog.appearance', 'Appearance')}
            </label>
            <select
              id="office-settings-appearance"
              value={selectedTheme}
              onChange={e => setSelectedTheme(e.target.value)}
              className={selectClassName}
            >
              {THEME_PREFERENCES.map(preference => (
                <option key={preference} value={preference}>
                  {themeLabels[preference]}
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">{appearanceHint}</p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-3 py-2 sm:px-4 sm:py-3 border-t border-slate-200 dark:border-slate-700">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-3 sm:px-4 py-1.5 sm:py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700"
          >
            {t('office.settingsDialog.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            onClick={handleSave}
            className="rounded-lg px-3 sm:px-4 py-1.5 sm:py-2 text-sm font-medium bg-slate-900 text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            {t('office.settingsDialog.save', 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
}
