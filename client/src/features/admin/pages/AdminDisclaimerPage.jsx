// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import AdminLoadError from '../components/AdminLoadError';
import AdminSaveBar from '../components/AdminSaveBar';
import EuAiActCard from '../components/euAiAct/EuAiActCard';
import {
  CALLOUT_CLASS,
  HELP_CLASS,
  INPUT_CLASS,
  LABEL_CLASS,
  SECONDARY_BUTTON_CLASS
} from '../components/formStyles';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import { makeAdminApiCall } from '../../../api/adminApi';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import Switch from '../../../shared/components/Switch';
import { DisclaimerCard } from '../../../shared/components/DisclaimerPopup';
import AIDisclaimerBanner from '../../chat/components/AIDisclaimerBanner';
import { useUIConfig } from '../../../shared/contexts/UIConfigContext';
import { nextDisclaimerVersion } from '../../../utils/disclaimerAcknowledgement';

const EMPTY = Object.freeze({});

const today = () => new Date().toISOString().slice(0, 10);

/**
 * `/admin/disclaimer`: the notice shown to visitors on their first visit (a popup)
 * and the one-line hint under the chat input. It has its own page because it is
 * a notice to the people using the site, not a look of the site; the AI notice and
 * the AI-use acknowledgement of the EU AI Act page are its neighbours.
 *
 * Saved on its own (`PUT /api/admin/ui/disclaimer`), so a stale UI Customization
 * tab cannot overwrite it and saving it cannot overwrite the rest of ui.json.
 */
function AdminDisclaimerPage() {
  const { t, i18n } = useTranslation();
  const { refreshUIConfig } = useUIConfig();
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState('');
  const [previewLanguage, setPreviewLanguage] = useState(i18n.language?.split('-')[0] || 'en');
  const { isDirty, blocker, markSaved } = useUnsavedChanges(saved, draft);

  useEffect(() => {
    let cancelled = false;
    makeAdminApiCall('/admin/ui/config')
      .then(response => {
        if (cancelled) return;
        const disclaimer = response.data?.disclaimer || {};
        setSaved(disclaimer);
        setDraft(disclaimer);
      })
      .catch(err => {
        if (!cancelled) setError(err.message || 'Failed to load the disclaimer');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const languages = useMemo(() => {
    const found = new Set([i18n.language?.split('-')[0] || 'en', 'en']);
    for (const field of ['title', 'text', 'hint']) {
      Object.keys(draft?.[field] || EMPTY).forEach(lang => found.add(lang));
    }
    return [...found];
  }, [draft, i18n.language]);

  if (loading) {
    return (
      <div className="p-8 text-sm text-gray-600 dark:text-gray-400" role="status">
        {t('admin.disclaimer.loading', 'Loading the disclaimer…')}
      </div>
    );
  }
  if (!draft) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <AdminLoadError message={error || t('admin.ui.error', 'Failed to load configuration')} />
      </div>
    );
  }

  const update = updates => setDraft(prev => ({ ...prev, ...updates }));
  const textChanged = ['title', 'text', 'hint'].some(
    field => JSON.stringify(draft[field] ?? null) !== JSON.stringify(saved[field] ?? null)
  );

  const handleSave = async () => {
    // "Last updated" follows the wording: set when a text or the version changed.
    const versionChanged = (draft.version ?? '') !== (saved.version ?? '');
    const toSave = textChanged || versionChanged ? { ...draft, updated: today() } : draft;
    try {
      setSaving(true);
      setError(null);
      const response = await makeAdminApiCall('/admin/ui/disclaimer', {
        method: 'PUT',
        body: toSave
      });
      const stored = response.data || toSave;
      markSaved();
      setSaved(stored);
      setDraft(stored);
      setMessage(t('admin.disclaimer.saved', 'Disclaimer saved'));
      await refreshUIConfig();
      setTimeout(() => setMessage(''), 4000);
    } catch (err) {
      setError(err.message || 'Failed to save the disclaimer');
    } finally {
      setSaving(false);
    }
  };

  const enabled = draft.enabled !== false;
  const versionBumped = (draft.version ?? '') !== (saved.version ?? '');

  return (
    <div>
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
            {t('admin.disclaimer.title', 'Disclaimer')}
          </h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {t(
              'admin.disclaimer.description',
              'The notice visitors see on their first visit and the hint under the chat input.'
            )}
          </p>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6 pb-28">
        {error && (
          <div role="alert">
            <AdminLoadError
              message={error}
              framed={false}
              action={{ label: t('common.dismiss', 'Dismiss'), onClick: () => setError(null) }}
            />
          </div>
        )}
        {message && (
          <p role="status" className={CALLOUT_CLASS.success}>
            {message}
          </p>
        )}

        <p className={CALLOUT_CLASS.info}>
          {t(
            'admin.disclaimer.euAiActNote',
            'The AI notice in the empty chat and the AI-use acknowledgement before the first message are set on the'
          )}{' '}
          <Link to="/admin/eu-ai-act" className="font-medium underline">
            {t('admin.nav.euAiAct', 'EU AI Act')}
          </Link>{' '}
          {t('admin.disclaimer.euAiActNoteEnd', 'page.')}
        </p>

        <EuAiActCard
          id="welcome-popup"
          title={t('admin.disclaimer.popupTitle', 'Welcome popup')}
          description={t(
            'admin.disclaimer.popupDescription',
            'Shown once to each visitor, before anything else. They confirm it with a button.'
          )}
        >
          <div className="space-y-6">
            <Switch
              size="md"
              checked={enabled}
              onChange={value => update({ enabled: value })}
              label={t('admin.ui.content.disclaimerEnabled', 'Enable Disclaimer Popup')}
              description={t(
                'admin.ui.content.disclaimerEnabledHint',
                'Show disclaimer popup to first-time visitors'
              )}
            />

            {enabled && (
              <>
                <DynamicLanguageEditor
                  label={t('admin.ui.content.disclaimerTitle', 'Disclaimer Title')}
                  value={draft.title || {}}
                  onChange={title => update({ title })}
                  type="text"
                  placeholder={{ en: 'Disclaimer', de: 'Haftungsausschluss' }}
                />
                <div>
                  <DynamicLanguageEditor
                    label={t('admin.ui.content.disclaimerText', 'Disclaimer Text')}
                    value={draft.text || {}}
                    onChange={text => update({ text })}
                    type="textarea"
                    rows={5}
                    placeholder={{ en: 'Disclaimer content (en)', de: 'Disclaimer content (de)' }}
                  />
                  <p className={HELP_CLASS}>
                    {t(
                      'admin.disclaimer.textHint',
                      'Plain text. The popup shows it as written; line breaks are not kept.'
                    )}
                  </p>
                </div>

                <div className="rounded-md border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900/40 p-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-medium text-gray-600 dark:text-gray-400">
                      {t('admin.disclaimer.preview', 'Preview')}
                    </p>
                    <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                      {t('admin.disclaimer.previewLanguage', 'Language')}
                      <select
                        value={previewLanguage}
                        onChange={e => setPreviewLanguage(e.target.value)}
                        className={`${INPUT_CLASS} w-auto`}
                      >
                        {languages.map(lang => (
                          <option key={lang} value={lang}>
                            {lang}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div
                    role="group"
                    aria-label={t('admin.disclaimer.popupPreview', 'Popup preview')}
                    className="flex justify-center max-h-96 overflow-y-auto"
                  >
                    <DisclaimerCard
                      disclaimer={draft}
                      currentLanguage={previewLanguage}
                      preview
                      onAccept={() => {}}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        </EuAiActCard>

        <EuAiActCard
          id="chat-hint"
          title={t('admin.disclaimer.hintTitle', 'Chat hint')}
          description={t(
            'admin.disclaimer.hintDescription',
            'One line under the chat input, once a conversation has started. It stays even when the popup is off.'
          )}
        >
          <div className="space-y-6">
            <DynamicLanguageEditor
              label={t('admin.disclaimer.hintLabel', 'Hint')}
              value={draft.hint || {}}
              onChange={hint => update({ hint })}
              type="text"
              placeholder={{
                en: 'iHub uses AI and can make mistakes. Please verify results carefully.',
                de: 'iHub nutzt KI und kann Fehler machen. Bitte überprüfe die Ergebnisse sorgfältig.'
              }}
            />
            <p className={HELP_CLASS}>
              {t(
                'admin.disclaimer.hintEmpty',
                'Empty uses the built-in text in the visitor’s language.'
              )}
            </p>

            <div>
              <label htmlFor="disclaimer-link" className={LABEL_CLASS}>
                {t('admin.disclaimer.link', 'Link')}
              </label>
              <input
                id="disclaimer-link"
                type="text"
                value={draft.link || ''}
                onChange={e => update({ link: e.target.value })}
                placeholder="/pages/terms"
                aria-describedby="disclaimer-link-hint"
                className={INPUT_CLASS}
              />
              <p id="disclaimer-link-hint" className={HELP_CLASS}>
                {t(
                  'admin.disclaimer.linkHint',
                  'Opened in a new tab when a visitor selects the hint: an https:// address or a path such as /pages/terms. Empty makes the hint plain text.'
                )}
              </p>
            </div>

            <div className="rounded-md border border-dashed border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-900/40 p-4">
              <p className="mb-2 text-xs font-medium text-gray-600 dark:text-gray-400">
                {t('admin.disclaimer.preview', 'Preview')}
              </p>
              <div role="group" aria-label={t('admin.disclaimer.hintPreview', 'Hint preview')}>
                <AIDisclaimerBanner disclaimer={{ hint: draft.hint, link: draft.link }} />
              </div>
            </div>
          </div>
        </EuAiActCard>

        <EuAiActCard
          id="versioning"
          title={t('admin.disclaimer.versionTitle', 'Version')}
          description={t(
            'admin.disclaimer.versionDescription',
            'Visitors who confirmed an older version see the popup again.'
          )}
        >
          <div className="space-y-4">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label htmlFor="disclaimer-version" className={LABEL_CLASS}>
                  {t('admin.ui.content.disclaimerVersion', 'Disclaimer Version')}
                </label>
                <input
                  id="disclaimer-version"
                  type="text"
                  value={draft.version || ''}
                  onChange={e => update({ version: e.target.value })}
                  placeholder="1.0"
                  className={`${INPUT_CLASS} max-w-xs`}
                />
              </div>
              <button
                type="button"
                className={SECONDARY_BUTTON_CLASS}
                onClick={() => update({ version: nextDisclaimerVersion(draft.version) })}
              >
                {t('admin.disclaimer.showAgain', 'Show again to everyone')}
              </button>
            </div>
            {versionBumped && (
              <p role="status" className={CALLOUT_CLASS.info}>
                {t(
                  'admin.disclaimer.showAgainNote',
                  'Version {{version}} is saved with the next save. Everyone sees the popup again at their next visit.',
                  { version: draft.version }
                )}
              </p>
            )}
            <p className="text-sm text-gray-600 dark:text-gray-400">
              {t('admin.ui.content.disclaimerUpdated', 'Last Updated')}:{' '}
              {saved.updated || t('admin.disclaimer.never', 'not set')}{' '}
              {t(
                'admin.disclaimer.updatedAuto',
                '(set automatically when the wording or the version changes)'
              )}
            </p>
          </div>
        </EuAiActCard>

        <EuAiActCard
          id="related"
          title={t('admin.disclaimer.relatedTitle', 'Related settings')}
          description={t(
            'admin.disclaimer.relatedDescription',
            'These belong to the EU AI Act duties and are set on their own page.'
          )}
        >
          <ul className="list-disc pl-5 space-y-1 text-sm text-gray-700 dark:text-gray-300">
            <li>
              <Link
                to="/admin/eu-ai-act#ai-notice"
                className="font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                {t('admin.disclaimer.relatedNotice', 'AI notice')}
              </Link>{' '}
              {t(
                'admin.disclaimer.relatedNoticeText',
                '— the notice in the empty chat and the guardrail wording'
              )}
            </li>
            <li>
              <Link
                to="/admin/eu-ai-act#ai-acknowledgement"
                className="font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
              >
                {t('admin.disclaimer.relatedAck', 'AI acknowledgement')}
              </Link>{' '}
              {t(
                'admin.disclaimer.relatedAckText',
                '— the confirmation before the first message, stored with the user'
              )}
            </li>
          </ul>
        </EuAiActCard>
      </div>

      <AdminSaveBar
        dirty={isDirty}
        saving={saving}
        onSave={handleSave}
        onDiscard={() => {
          setDraft(saved);
          setError(null);
        }}
      />

      <ConfirmDialog
        isOpen={blocker.state === 'blocked'}
        title={t('admin.ui.unsaved.title', 'Unsaved changes')}
        message={t('admin.ui.unsaved.message', 'You have unsaved changes. Leave anyway?')}
        confirmLabel={t('admin.ui.unsaved.leave', 'Leave')}
        denyLabel={t('admin.ui.unsaved.stay', 'Stay')}
        danger={false}
        onConfirm={() => blocker.proceed?.()}
        onDeny={() => blocker.reset?.()}
      />
    </div>
  );
}

export default AdminDisclaimerPage;
