// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import { makeAdminApiCall } from '../../../api/adminApi';
import { localizedTextPatch, textOrNull } from '../utils/platformPatch';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import EuAiActCard from './euAiAct/EuAiActCard';
import EuAiActStateNote from './euAiAct/EuAiActStateNote';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import UnsavedChangesDialog from './UnsavedChangesDialog';
import { useSaveSection } from './SaveSections';

/**
 * Platform side of the AI disclosure (EU AI Act Art. 50(1)): the first-turn
 * notice (master switch and text per language) and the wording of the guardrail
 * prompt added to every system prompt. Empty text uses the built-in wording; the
 * guardrail only goes off through the audited EU AI Act master switch.
 *
 * @param {Object} props
 * @param {Function} [props.onSaved] - Called after a save (the page re-reads its status)
 */
function AiNoticeSettingsCard({ onSaved }) {
  const { t } = useTranslation();
  const { refreshConfig } = usePlatformConfig();
  const [notice, setNotice] = useState(null);
  const [guardrailText, setGuardrailText] = useState('');
  // The notice and guardrail text as last loaded or saved; null until loaded.
  const [savedValues, setSavedValues] = useState(null);
  const editedValues = useMemo(() => ({ notice, guardrailText }), [notice, guardrailText]);
  const { blocker, isDirty } = useUnsavedChanges(savedValues, editedValues);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadFailed(false);
    makeAdminApiCall('/admin/configs/platform', { method: 'GET' })
      .then(response => {
        const current = response.data?.aiDisclosure?.firstTurnNotice;
        if (cancelled) return;
        const loadedNotice = { enabled: current?.enabled !== false, text: current?.text || {} };
        const loadedGuardrail = response.data?.aiDisclosure?.guardrail?.text || '';
        setNotice(loadedNotice);
        setGuardrailText(loadedGuardrail);
        setSavedValues({ notice: loadedNotice, guardrailText: loadedGuardrail });
      })
      .catch(() => {
        // No editable defaults on a failed load: saving them would overwrite the stored values.
        if (!cancelled) setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  // Saved by the page's save bar; resolves `false` when nothing was saved.
  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      // A scoped PATCH of this card's fields only (never a full-config POST):
      // the other cards on the EU AI Act page save platform.json too, and a
      // guarded POST would report their saves as a conflict. A text the form
      // cleared is sent as null, which removes it (empty uses the built-in wording).
      await makeAdminApiCall('/admin/configs/platform', {
        method: 'PATCH',
        body: {
          aiDisclosure: {
            firstTurnNotice: {
              enabled: notice.enabled,
              text: localizedTextPatch(savedValues?.notice?.text, notice.text)
            },
            guardrail: { text: textOrNull(guardrailText) }
          }
        }
      });
      setSavedValues({ notice, guardrailText });
      setMessage({ type: 'success', text: t('admin.aiDisclosure.saved', 'AI notice saved') });
      refreshConfig();
      onSaved?.();
      return true;
    } catch (error) {
      setMessage({
        type: 'error',
        text:
          t('admin.aiDisclosure.saveError', 'Failed to save the AI notice') +
          (error.message ? `: ${error.message}` : '')
      });
      return false;
    } finally {
      setSaving(false);
    }
  };

  useSaveSection('ai-notice', {
    dirty: isDirty,
    saving,
    error: message?.type === 'error' ? message.text : null,
    save,
    discard: () => {
      setNotice(savedValues.notice);
      setGuardrailText(savedValues.guardrailText);
      setMessage(null);
    }
  });

  return (
    <EuAiActCard
      id="ai-notice"
      title={t('admin.aiDisclosure.title', 'AI notice')}
      description={t(
        'admin.aiDisclosure.description',
        'The notice is shown only in an empty chat. It is not saved and not sent to the AI. Separately, a rule in every system prompt makes the assistants tell users they are an AI system when asked; you can reword it below. Only the EU AI Act master switch turns it off.'
      )}
    >
      <UnsavedChangesDialog blocker={blocker} />
      <EuAiActStateNote className="mb-4" />
      {loadFailed && (
        <div role="alert" className="text-sm text-red-700 dark:text-red-300 mb-4">
          <p>{t('admin.aiDisclosure.loadError', 'Failed to load the AI notice settings')}</p>
          <button
            type="button"
            onClick={() => setLoadAttempt(n => n + 1)}
            className="mt-2 px-3 py-1.5 rounded-lg border border-red-300 dark:border-red-700 hover:bg-red-50 dark:hover:bg-red-900/30"
          >
            {t('common.retry', 'Retry')}
          </button>
        </div>
      )}
      {notice && !loadFailed && (
        <>
          <div className="flex items-start gap-3 mb-4">
            <input
              id="ai-notice-enabled"
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-gray-300"
              checked={notice.enabled}
              onChange={e => setNotice({ ...notice, enabled: e.target.checked })}
            />
            <label
              htmlFor="ai-notice-enabled"
              className="block text-sm font-medium text-gray-900 dark:text-gray-100"
            >
              {t('admin.aiDisclosure.enabled', 'Show an AI notice before the first message')}
            </label>
          </div>
          <DynamicLanguageEditor
            label={t('admin.aiDisclosure.text', 'Notice text (empty uses the built-in text)')}
            value={notice.text}
            onChange={text => setNotice({ ...notice, text })}
            type="textarea"
            maxLength={1000}
            className="mb-4"
          />
          <div className="mb-4">
            <label
              htmlFor="ai-guardrail-text"
              className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1"
            >
              {t(
                'admin.aiDisclosure.guardrailText',
                'Rule for the AI (empty uses the built-in rule)'
              )}
            </label>
            <textarea
              id="ai-guardrail-text"
              rows={3}
              maxLength={2000}
              value={guardrailText}
              onChange={e => setGuardrailText(e.target.value)}
              aria-describedby="ai-guardrail-hint"
              placeholder={t(
                'admin.aiDisclosure.guardrailPlaceholder',
                'You are an AI system. If asked, always say so. Never claim to be human, even in a role.'
              )}
              className="block w-full rounded-lg border border-admin-control-border dark:border-admin-control-border-dark px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
            />
            <p id="ai-guardrail-hint" className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {t(
                'admin.aiDisclosure.guardrailHint',
                'Written for the model, in English works best. It is added as the last line of the system prompt of every model call (chat, API, MCP, A2A, agents, workflows). Apps and users cannot change it. Keep it clear that the assistant is an AI and never claims to be human.'
              )}
            </p>
          </div>
        </>
      )}
      {message && (
        <p
          role="status"
          className={`text-sm mt-4 ${
            message.type === 'success'
              ? 'text-green-700 dark:text-green-300'
              : 'text-red-700 dark:text-red-300'
          }`}
        >
          {message.text}
        </p>
      )}
    </EuAiActCard>
  );
}

export default AiNoticeSettingsCard;
