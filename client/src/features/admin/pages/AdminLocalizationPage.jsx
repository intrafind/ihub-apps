import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';

/**
 * Admin → Customization → Localization.
 *
 * Edits `defaultLanguage` in platform.json — the install-wide language. It is
 * not only a UI preference: it is the fallback for every localized lookup, and
 * for web search it is the language searched in whenever a request carries none
 * of its own. A workflow or agent run has no browser behind it, so that is
 * exactly the case this setting decides.
 *
 * Kept as its own page rather than a tab on UI Customization because that page
 * reads and writes ui.json in one Save, and mixing a second config file into it
 * would make a single button do two writes that can fail independently.
 */
function AdminLocalizationPage() {
  const { t } = useTranslation();
  const { uiConfig } = useUIConfig();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [defaultLanguage, setDefaultLanguage] = useState('en');
  // The whole platform config, so the save can post it back untouched apart
  // from the one field this page owns.
  const [platformConfig, setPlatformConfig] = useState(null);

  /**
   * The languages this install actually has, derived the same way the end-user
   * language selector derives them — from the locales `ui.header.title` is
   * translated into. Offering anything else would let an admin pick a language
   * with no translations behind it.
   */
  const availableLanguages = useMemo(() => {
    const codes = Object.keys(uiConfig?.header?.title || {});
    const known = codes.length ? codes : ['en', 'de'];
    return known.map(code => {
      const localized = t(`languages.${code}`);
      const name =
        localized === `languages.${code}`
          ? { en: 'English', de: 'Deutsch' }[code] || code
          : localized;
      return { code, name };
    });
  }, [uiConfig, t]);

  const loadConfiguration = useCallback(async () => {
    try {
      setLoading(true);
      const response = await makeAdminApiCall('/admin/configs/platform', { method: 'GET' });
      const config = response.data || {};
      setPlatformConfig(config);
      setDefaultLanguage(config.defaultLanguage || 'en');
      setMessage('');
    } catch (error) {
      console.error('Failed to load platform configuration:', error);
      setMessage({
        type: 'error',
        text: t('admin.localization.loadError', 'Failed to load the platform configuration')
      });
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadConfiguration();
  }, [loadConfiguration]);

  const handleSave = async () => {
    try {
      setSaving(true);
      setMessage('');

      await makeAdminApiCall('/admin/configs/platform', {
        method: 'POST',
        body: { ...(platformConfig || {}), defaultLanguage }
      });

      setMessage({
        type: 'success',
        text: t('admin.localization.saveSuccess', 'Default language saved')
      });
      setTimeout(() => setMessage(''), 3000);
    } catch (error) {
      console.error('Failed to save platform configuration:', error);
      setMessage({
        type: 'error',
        text:
          t('admin.localization.saveError', 'Failed to save the default language') +
          (error.message ? `: ${error.message}` : '')
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3"></div>
          <div className="h-32 bg-gray-200 dark:bg-gray-700 rounded"></div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {t('admin.localization.title', 'Localization')}
        </h1>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          {t(
            'admin.localization.subtitle',
            'The language this installation falls back to when no other language applies.'
          )}
        </p>
      </div>

      {message && (
        <div
          role="status"
          className={`mb-6 rounded-lg p-4 text-sm ${
            message.type === 'error'
              ? 'bg-red-50 text-red-800 dark:bg-red-900/30 dark:text-red-200'
              : 'bg-green-50 text-green-800 dark:bg-green-900/30 dark:text-green-200'
          }`}
        >
          {message.text}
        </div>
      )}

      <div className="bg-white dark:bg-gray-800 shadow-sm sm:rounded-lg px-4 py-5 sm:p-6">
        <div className="md:grid md:grid-cols-3 md:gap-6">
          <div className="md:col-span-1">
            <h2 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
              {t('admin.localization.defaultLanguage', 'Default Language')}
            </h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {t(
                'admin.localization.defaultLanguageDesc',
                'Used for users who have not chosen a language, and wherever no request language exists at all.'
              )}
            </p>
          </div>

          <div className="mt-5 md:mt-0 md:col-span-2 space-y-4">
            <div>
              <label
                htmlFor="default-language"
                className="block text-sm font-medium text-gray-700 dark:text-gray-300"
              >
                {t('admin.localization.defaultLanguage', 'Default Language')}
              </label>
              <select
                id="default-language"
                value={defaultLanguage}
                onChange={e => setDefaultLanguage(e.target.value)}
                className="mt-1 block w-full rounded-lg border-gray-300 shadow-xs focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
              >
                {availableLanguages.map(language => (
                  <option key={language.code} value={language.code}>
                    {language.name} ({language.code})
                  </option>
                ))}
              </select>
            </div>

            <div className="rounded-lg bg-blue-50 dark:bg-blue-900/20 p-4">
              <div className="flex gap-3">
                <Icon
                  name="information-circle"
                  className="h-5 w-5 shrink-0 text-blue-500 dark:text-blue-300"
                />
                <div className="text-sm text-blue-800 dark:text-blue-200">
                  <p className="font-medium">
                    {t('admin.localization.whereItApplies', 'Where this applies')}
                  </p>
                  <ul className="mt-2 list-disc space-y-1 ps-5">
                    <li>
                      {t(
                        'admin.localization.appliesUi',
                        'The interface language for users who have not picked one themselves.'
                      )}
                    </li>
                    <li>
                      {t(
                        'admin.localization.appliesSearch',
                        'The language web search runs in when a request carries none of its own — workflow and agent runs in particular, which have no browser behind them.'
                      )}
                    </li>
                    <li>
                      {t(
                        'admin.localization.appliesFallback',
                        'The fallback for any text that has no translation in the requested language.'
                      )}
                    </li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 flex justify-end border-t border-gray-200 dark:border-gray-700 pt-5">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center rounded-lg border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-xs hover:bg-indigo-700 focus:outline-hidden focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving
              ? t('admin.localization.saving', 'Saving...')
              : t('admin.localization.save', 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AdminLocalizationPage;
