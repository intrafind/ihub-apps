// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import { makeAdminApiCall } from '../../../api/adminApi';
import { useAiAcknowledgementAdmin } from '../hooks/useAiAcknowledgementAdmin';
import EuAiActCard from './euAiAct/EuAiActCard';
import EuAiActStateNote from './euAiAct/EuAiActStateNote';

const BUTTON =
  'px-4 py-2 rounded-lg font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800 disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * Platform side of the AI-use acknowledgement (#3326): on/off, enforcement,
 * text per language, policy link, and the required version. The version is
 * server-owned: this card never sends it; "Request again" is an action of the
 * Acknowledgements card next to it.
 *
 * @param {Object} props
 * @param {Function} [props.onSaved] - Called after a save (the page re-reads its status)
 * @param {number} [props.requiredVersion] - The version from the page's status, so it
 *   follows a "Request again" made on the Acknowledgements card
 */
function AiAcknowledgementSettingsCard({ onSaved, requiredVersion }) {
  const { t } = useTranslation();
  const [form, setForm] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const admin = useAiAcknowledgementAdmin();

  useEffect(() => {
    let cancelled = false;
    makeAdminApiCall('/admin/configs/platform', { method: 'GET' })
      .then(response => {
        const block = response.data?.aiAcknowledgement || {};
        if (!cancelled) {
          setForm({
            enabled: block.enabled !== false,
            enforce: block.enforce !== false,
            text: block.text || {},
            policyUrl: block.policyUrl || ''
          });
        }
      })
      .catch(() => {
        // No default form: saving it would replace the stored text and link with empty ones.
        if (!cancelled) setLoadFailed(true);
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
      // The read is redacted (proxy JWT provider `jwkUrl` values are left out), and the route
      // keeps the stored proxyAuth when none is sent: posting the redacted one would erase them.
      delete platform.proxyAuth;
      const text = Object.fromEntries(
        Object.entries(form.text).filter(([, value]) => typeof value === 'string' && value.trim())
      );
      platform.aiAcknowledgement = {
        enabled: form.enabled,
        enforce: form.enforce,
        text,
        policyUrl: form.policyUrl.trim()
      };
      await makeAdminApiCall('/admin/configs/platform', { method: 'POST', body: platform });
      setMessage({
        type: 'success',
        text: t('admin.aiAcknowledgement.saved', 'AI acknowledgement saved')
      });
      void admin.reload();
      onSaved?.();
    } catch (error) {
      setMessage({
        type: 'error',
        text:
          t('admin.aiAcknowledgement.saveError', 'Failed to save the AI acknowledgement') +
          (error.message ? `: ${error.message}` : '')
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <EuAiActCard
      id="ai-acknowledgement"
      title={t('admin.aiAcknowledgement.title', 'AI acknowledgement')}
      description={t(
        'admin.aiAcknowledgement.description',
        'Users confirm a short AI-use notice before their first message. The confirmation is stored with the user and in the audit log. Existing confirmations stay valid when you edit the text; use "Request again" to ask everyone again.'
      )}
    >
      <EuAiActStateNote className="mb-4" />
      {loadFailed && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {t(
            'admin.aiAcknowledgement.loadError',
            'The AI acknowledgement settings could not be loaded. Reload the page to try again.'
          )}
        </p>
      )}
      {form && (
        <>
          <div className="flex items-start gap-3 mb-3">
            <input
              id="ai-ack-enabled"
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-gray-300"
              checked={form.enabled}
              onChange={e => setForm({ ...form, enabled: e.target.checked })}
            />
            <label
              htmlFor="ai-ack-enabled"
              className="block text-sm font-medium text-gray-900 dark:text-gray-100"
            >
              {t('admin.aiAcknowledgement.enabled', 'Ask users to confirm their use of AI')}
            </label>
          </div>
          <div className="flex items-start gap-3 mb-4">
            <input
              id="ai-ack-enforce"
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-gray-300"
              checked={form.enforce}
              disabled={!form.enabled}
              onChange={e => setForm({ ...form, enforce: e.target.checked })}
            />
            <label
              htmlFor="ai-ack-enforce"
              className="block text-sm font-medium text-gray-900 dark:text-gray-100"
            >
              {t(
                'admin.aiAcknowledgement.enforce',
                'Block sending until confirmed (otherwise the dialog only asks)'
              )}
            </label>
          </div>
          {form.enabled && !form.enforce && (
            <p className="mb-4 text-sm text-amber-800 dark:text-amber-300">
              {t(
                'admin.aiAcknowledgement.enforceOffWarning',
                'Users can use the AI without confirming.'
              )}
            </p>
          )}
          <DynamicLanguageEditor
            label={t(
              'admin.aiAcknowledgement.text',
              'Notice text (plain text; empty uses the built-in text)'
            )}
            value={form.text}
            onChange={text => setForm({ ...form, text })}
            type="textarea"
            maxLength={5000}
            className="mb-4"
          />
          <div className="mb-4">
            <label
              htmlFor="ai-ack-policy-url"
              className="block text-sm font-medium text-gray-900 dark:text-gray-100 mb-1"
            >
              {t('admin.aiAcknowledgement.policyUrl', 'AI policy link (https://… or /path)')}
            </label>
            <input
              id="ai-ack-policy-url"
              type="text"
              value={form.policyUrl}
              onChange={e => setForm({ ...form, policyUrl: e.target.value })}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
            />
          </div>
          <p className="mb-4 text-sm text-gray-700 dark:text-gray-300">
            {t(
              'admin.aiAcknowledgement.currentVersionHint',
              'Current version: {{version}}. To ask everyone again, use "Request again" under Acknowledgements.',
              { version: requiredVersion ?? admin.settings?.requiredVersion ?? 1 }
            )}
          </p>
          <div className="flex flex-wrap gap-3">
            <button type="button" onClick={save} disabled={saving} className={BUTTON}>
              {t('common.save', 'Save')}
            </button>
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

export default AiAcknowledgementSettingsCard;
