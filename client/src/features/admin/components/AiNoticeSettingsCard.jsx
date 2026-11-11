// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import { makeAdminApiCall } from '../../../api/adminApi';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';

/**
 * Platform side of the first-turn AI notice (EU AI Act Art. 50(1)): the master
 * switch and the text per language. Empty text uses the built-in wording.
 * The guardrail prompt has no setting and is not shown here.
 */
function AiNoticeSettingsCard() {
  const { t } = useTranslation();
  const { refreshConfig } = usePlatformConfig();
  const [notice, setNotice] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    let cancelled = false;
    makeAdminApiCall('/admin/configs/platform', { method: 'GET' })
      .then(response => {
        const current = response.data?.aiDisclosure?.firstTurnNotice;
        if (!cancelled)
          setNotice({ enabled: current?.enabled !== false, text: current?.text || {} });
      })
      .catch(() => {
        if (!cancelled) setNotice({ enabled: true, text: {} });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      // Read-modify-write: platform.json carries settings this card does not show.
      const response = await makeAdminApiCall('/admin/configs/platform', { method: 'GET' });
      const platform = response.data || {};
      const text = Object.fromEntries(
        Object.entries(notice.text).filter(([, value]) => typeof value === 'string' && value.trim())
      );
      platform.aiDisclosure = {
        ...platform.aiDisclosure,
        firstTurnNotice: {
          ...platform.aiDisclosure?.firstTurnNotice,
          enabled: notice.enabled,
          text
        }
      };
      await makeAdminApiCall('/admin/configs/platform', { method: 'POST', body: platform });
      setMessage({ type: 'success', text: t('admin.aiDisclosure.saved', 'AI notice saved') });
      refreshConfig();
    } catch (error) {
      setMessage({
        type: 'error',
        text:
          t('admin.aiDisclosure.saveError', 'Failed to save the AI notice') +
          (error.message ? `: ${error.message}` : '')
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
        {t('admin.aiDisclosure.title', 'AI notice')}
      </h3>
      <p className="text-gray-600 dark:text-gray-400 mb-4">
        {t(
          'admin.aiDisclosure.description',
          'The notice is shown only in an empty chat. It is not saved and not sent to the AI. The assistants always tell users they are an AI system when asked; that rule cannot be switched off.'
        )}
      </p>
      {notice && (
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
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="px-4 py-2 rounded-lg font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {t('common.save', 'Save')}
          </button>
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
    </div>
  );
}

export default AiNoticeSettingsCard;
