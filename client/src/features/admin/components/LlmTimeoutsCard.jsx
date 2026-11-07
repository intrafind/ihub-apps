// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getAdminApiErrorMessage, makeAdminApiCall } from '../../../api/adminApi';
import { LLM_TIMEOUT_KEYS, LLM_TIMEOUT_MAX_MS } from '../../../../../shared/llmProviders.js';
import Icon from '../../../shared/components/Icon';

const INPUT =
  'mt-1 w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm';

/** Saved values → the form's text values (an unset key is an empty field). */
function toForm(saved) {
  return Object.fromEntries(LLM_TIMEOUT_KEYS.map(key => [key, saved?.[key] ?? '']));
}

/** Form text → PUT body: a number, or `null` to remove the saved value. */
function toRequest(form) {
  return Object.fromEntries(
    LLM_TIMEOUT_KEYS.map(key => [key, form[key] === '' ? null : Number(form[key])])
  );
}

/**
 * Admin → Providers → "Timeouts for all providers". Edits `llm.connectTimeoutMs`
 * and `llm.streamIdleTimeoutMs` of platform.json through `/api/admin/llm-timeouts`.
 * A provider or a model can override either value; the change applies to the
 * next request, no restart.
 */
function LlmTimeoutsCard() {
  const { t } = useTranslation();
  const [form, setForm] = useState(toForm());
  const [saved, setSaved] = useState({});
  const [defaults, setDefaults] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const apply = useCallback(data => {
    setSaved(data?.saved || {});
    setDefaults(data?.defaults || {});
    setForm(toForm(data?.saved));
  }, []);

  useEffect(() => {
    let cancelled = false;
    makeAdminApiCall('/admin/llm-timeouts')
      .then(response => {
        if (!cancelled) apply(response.data);
      })
      .catch(error => {
        if (!cancelled) setMessage({ type: 'error', text: getAdminApiErrorMessage(error) });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apply]);

  const dirty = LLM_TIMEOUT_KEYS.some(key => String(saved[key] ?? '') !== String(form[key]));

  const handleSave = async event => {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const response = await makeAdminApiCall('/admin/llm-timeouts', {
        method: 'PUT',
        body: toRequest(form)
      });
      apply(response.data);
      setMessage({
        type: 'success',
        text: t('admin.providers.timeouts.saved', 'Timeouts saved. They apply to the next request.')
      });
    } catch (error) {
      setMessage({ type: 'error', text: getAdminApiErrorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const fields = [
    {
      key: 'connectTimeoutMs',
      label: t('admin.providers.timeouts.connect', 'Connect timeout (ms)'),
      hint: t(
        'admin.providers.timeouts.connectHint',
        'Longest wait for the provider’s response headers before a call fails as unreachable. 0 turns it off.'
      )
    },
    {
      key: 'streamIdleTimeoutMs',
      label: t('admin.providers.timeouts.streamIdle', 'Stream idle timeout (ms)'),
      hint: t(
        'admin.providers.timeouts.streamIdleHint',
        'Longest silence between two chunks of a stream that is already running. Raise it for thinking models. 0 turns it off.'
      )
    }
  ];

  return (
    <form
      onSubmit={handleSave}
      className="mb-6 bg-white dark:bg-gray-800 shadow-sm rounded-lg p-6"
      aria-labelledby="llm-timeouts-title"
      data-testid="llm-timeouts-card"
    >
      <div className="flex items-start gap-2 mb-4">
        <Icon name="ClockIcon" className="w-6 h-6 text-blue-500 shrink-0" />
        <div>
          <h2
            id="llm-timeouts-title"
            className="text-lg font-semibold text-gray-900 dark:text-white"
          >
            {t('admin.providers.timeouts.title', 'Timeouts for all providers')}
          </h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {t(
              'admin.providers.timeouts.description',
              'Apply to every model unless its provider or the model sets its own. Changes take effect on the next request; no restart is needed. Leave a field empty to use the default.'
            )}
          </p>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {t('common.loading', 'Loading...')}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {fields.map(({ key, label, hint }) => (
              <div key={key}>
                <label
                  htmlFor={`llm-timeout-${key}`}
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  {label}
                </label>
                <input
                  id={`llm-timeout-${key}`}
                  type="number"
                  min="0"
                  max={LLM_TIMEOUT_MAX_MS}
                  step="1"
                  value={form[key]}
                  placeholder={defaults[key] === undefined ? '' : String(defaults[key])}
                  onChange={e => setForm(prev => ({ ...prev, [key]: e.target.value }))}
                  aria-describedby={`llm-timeout-${key}-hint`}
                  className={INPUT}
                />
                <p
                  id={`llm-timeout-${key}-hint`}
                  className="mt-1 text-xs text-gray-500 dark:text-gray-400"
                >
                  {hint}
                </p>
              </div>
            ))}
          </div>

          {message && (
            <p
              role={message.type === 'error' ? 'alert' : 'status'}
              className={`mt-4 text-sm ${
                message.type === 'success'
                  ? 'text-green-700 dark:text-green-300'
                  : 'text-red-700 dark:text-red-300'
              }`}
            >
              {message.text}
            </p>
          )}

          <div className="mt-4 flex justify-end gap-3">
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => setForm(toForm(saved))}
              className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t('admin.providers.timeouts.reset', 'Reset')}
            </button>
            <button
              type="submit"
              disabled={!dirty || saving}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving
                ? t('admin.providers.edit.saving', 'Saving...')
                : t('admin.providers.timeouts.save', 'Save timeouts')}
            </button>
          </div>
        </>
      )}
    </form>
  );
}

export default LlmTimeoutsCard;
