import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DynamicLanguageEditor from '../../../../shared/components/DynamicLanguageEditor';
import Icon from '../../../../shared/components/Icon';
import { generateAppUsageGuide, getAdminApiErrorMessage } from '../../../../api/adminApi';

const BUTTON_CLASS =
  'inline-flex items-center gap-2 px-3 py-2 border border-gray-300 dark:border-gray-600 shadow-sm text-sm font-medium rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 disabled:opacity-50';

/**
 * UsageGuideSection - the app's usage guide (issue #2838): a pre-written answer
 * to "How do I use this app?" that users open from a button in the chat, read
 * without a model call. The text lives in the app (`usageGuide`), so it is
 * exported, backed up and installed with it.
 *
 * Generating asks the default model once for the chosen language; the admin
 * reviews and edits the text, and it is stored with the app's next save.
 */
function UsageGuideSection({ app, onChange }) {
  const { t, i18n } = useTranslation();
  const [language, setLanguage] = useState((i18n.language || 'en').split('-')[0]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  // The model answers seconds later; edits made meanwhile must not be lost.
  const appRef = useRef(app);
  appRef.current = app;

  const guide = app.usageGuide;
  const languages = [
    ...new Set([
      'en',
      'de',
      ...Object.keys(app.name || {}),
      ...Object.keys(guide?.content || {}),
      language
    ])
  ];

  const updateGuide = changes => {
    const current = appRef.current;
    onChange({ ...current, usageGuide: { ...(current.usageGuide || {}), ...changes } });
  };

  const generate = async () => {
    const existing = guide?.content?.[language];
    if (
      existing &&
      !window.confirm(
        t(
          'admin.apps.edit.usageGuide.confirmRegenerate',
          'Replace the current guide text for this language with a newly generated one?'
        )
      )
    ) {
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const { content } = await generateAppUsageGuide(appRef.current, language);
      updateGuide({
        content: { ...(appRef.current.usageGuide?.content || {}), [language]: content }
      });
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setGenerating(false);
    }
  };

  const remove = () => {
    if (
      !window.confirm(
        t('admin.apps.edit.usageGuide.confirmDelete', 'Delete the usage guide of this app?')
      )
    ) {
      return;
    }
    const { usageGuide: _usageGuide, ...rest } = appRef.current;
    onChange(rest);
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm px-4 py-5 sm:rounded-lg sm:p-6">
      <div className="md:grid md:grid-cols-3 md:gap-6">
        <div className="md:col-span-1">
          <h3 className="text-lg font-medium leading-6 text-gray-900 dark:text-gray-100">
            {t('admin.apps.edit.usageGuide.title', 'Usage Guide')}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            {t(
              'admin.apps.edit.usageGuide.description',
              'A pre-written answer to "How do I use this app?". Users open it from a button in the chat. No model is called, and the guide is not sent to the model, so it costs nothing and leaves the context window free.'
            )}
          </p>
        </div>
        <div className="mt-5 md:col-span-2 md:mt-0 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <label
              htmlFor="usage-guide-language"
              className="text-sm text-gray-700 dark:text-gray-300"
            >
              {t('admin.apps.edit.usageGuide.language', 'Language')}
            </label>
            <select
              id="usage-guide-language"
              value={language}
              onChange={e => setLanguage(e.target.value)}
              className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm px-2 py-1.5"
            >
              {languages.map(lang => (
                <option key={lang} value={lang}>
                  {lang}
                </option>
              ))}
            </select>
            <button type="button" onClick={generate} disabled={generating} className={BUTTON_CLASS}>
              <Icon name="sparkles" size="sm" />
              {generating
                ? t('admin.apps.edit.usageGuide.generating', 'Generating…')
                : guide?.content?.[language]
                  ? t('admin.apps.edit.usageGuide.regenerate', 'Regenerate with AI')
                  : t('admin.apps.edit.usageGuide.generate', 'Generate with AI')}
            </button>
            {!guide && (
              <button
                type="button"
                onClick={() => updateGuide({ content: { [language]: '' } })}
                className={BUTTON_CLASS}
              >
                <Icon name="edit" size="sm" />
                {t('admin.apps.edit.usageGuide.write', 'Write manually')}
              </button>
            )}
            {guide && (
              <button
                type="button"
                onClick={remove}
                className={`${BUTTON_CLASS} text-red-600 dark:text-red-400`}
              >
                <Icon name="trash" size="sm" />
                {t('admin.apps.edit.usageGuide.delete', 'Delete guide')}
              </button>
            )}
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.apps.edit.usageGuide.generateHint',
              'Generating uses the default model once, with this form as it is now. Review the text — it is stored when you save the app.'
            )}
          </p>
          {error && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {error}
            </p>
          )}

          {guide && (
            <>
              <DynamicLanguageEditor
                label={t('admin.apps.edit.usageGuide.question', 'Button text / question')}
                value={guide.question || {}}
                onChange={value => updateGuide({ question: value })}
                placeholder={{ en: 'How do I use this app?', de: 'Wie nutze ich diese App?' }}
              />
              <DynamicLanguageEditor
                label={t('admin.apps.edit.usageGuide.content', 'Guide (Markdown)')}
                value={guide.content || {}}
                onChange={value => updateGuide({ content: value })}
                type="textarea"
                rows={14}
                name="usageGuide.content"
                placeholder={{
                  en: 'Describe what the app does and how to use it',
                  de: 'Beschreiben Sie, was die App kann und wie man sie nutzt'
                }}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default UsageGuideSection;
