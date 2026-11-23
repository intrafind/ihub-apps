// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getAdminApiErrorMessage, makeAdminApiCall } from '../../../api/adminApi';
import AdminLoadGate from './AdminLoadGate';
import { useAdminConfigLoad } from '../hooks/useAdminConfigLoad';
import { LLM_TIMEOUT_KEYS, LLM_TIMEOUT_MAX_MS } from '../../../../../shared/llmProviders.js';
import Icon from '../../../shared/components/Icon';
import { INPUT_CLASS, LABEL_CLASS } from './formStyles';
import ImplicitSubmit from '../../../shared/components/ImplicitSubmit';
import { useSaveSection } from './SaveSections';

/** 30000 → "30 s", 1500 → "1500 ms", 0 → null (no ceiling). */
function formatMs(ms, t) {
  if (ms === 0) return t('admin.providers.timeouts.off', 'off');
  return ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`;
}

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
  const [form, setForm] = useState(() => toForm());
  const [saved, setSaved] = useState({});
  const [defaults, setDefaults] = useState({});
  const [effective, setEffective] = useState({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [open, setOpen] = useState(false);

  const apply = useCallback(data => {
    setSaved(data?.saved || {});
    setDefaults(data?.defaults || {});
    setEffective(data?.effective || {});
    setForm(toForm(data?.saved));
  }, []);

  // No form and no Save until the timeouts loaded: a save sends both fields,
  // so editing one after a failed load would reset the other to its default.
  const load = useAdminConfigLoad({
    sources: {
      timeouts: {
        load: async () => (await makeAdminApiCall('/admin/llm-timeouts')).data,
        onLoad: apply
      }
    }
  });
  const loading = load.status === 'loading';
  const ready = load.status === 'ready';
  // A failed load has nothing to edit or summarise: its error panel, with Retry,
  // replaces the Edit toggle and the (collapsed) body, so it shows once and is
  // always visible.
  const failed = load.status === 'failed';

  const dirty = LLM_TIMEOUT_KEYS.some(key => String(saved[key] ?? '') !== String(form[key]));

  const save = async () => {
    if (!ready) return false;
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
      return true;
    } catch (error) {
      setMessage({ type: 'error', text: getAdminApiErrorMessage(error) });
      return false;
    } finally {
      setSaving(false);
    }
  };

  // Save and Discard are the page's bar; Enter in a field still saves through the form.
  useSaveSection('llm-timeouts', {
    dirty: ready && dirty,
    saving,
    error: message?.type === 'error' ? message.text : null,
    save,
    discard: () => {
      setForm(toForm(saved));
      setMessage(null);
    }
  });

  const handleSubmit = event => {
    event.preventDefault();
    void save();
  };

  const fields = [
    {
      key: 'connectTimeoutMs',
      label: t('admin.providers.timeouts.connect', 'Connect timeout (ms)'),
      hint: t(
        'admin.providers.timeouts.connectHint',
        'Longest wait for the connection to the provider (DNS, TCP, TLS) before a call fails as unreachable. Time the model spends before its first answer chunk does not count. 0 turns it off.'
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
      onSubmit={handleSubmit}
      className="mb-6 bg-white dark:bg-gray-800 shadow-sm rounded-lg p-4"
      aria-labelledby="llm-timeouts-title"
      data-testid="llm-timeouts-card"
    >
      <ImplicitSubmit disabled={saving || !dirty} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Icon name="ClockIcon" className="w-5 h-5 text-blue-500 shrink-0" />
        <h2
          id="llm-timeouts-title"
          className="text-base font-semibold text-gray-900 dark:text-white"
        >
          {t('admin.providers.timeouts.title', 'Timeouts for all providers')}
        </h2>
        {!loading && Number.isFinite(effective.connectTimeoutMs ?? defaults.connectTimeoutMs) && (
          <p
            className="text-sm text-gray-600 dark:text-gray-400"
            data-testid="llm-timeouts-summary"
          >
            {t('admin.providers.timeouts.summary', 'connect {{connect}} · stream idle {{idle}}', {
              connect: formatMs(effective.connectTimeoutMs ?? defaults.connectTimeoutMs, t),
              idle: formatMs(effective.streamIdleTimeoutMs ?? defaults.streamIdleTimeoutMs, t)
            })}
          </p>
        )}
        {!failed && (
          <button
            type="button"
            aria-expanded={open}
            aria-controls="llm-timeouts-body"
            onClick={() => setOpen(prev => !prev)}
            className="ml-auto rounded-md px-3 py-1 text-sm font-medium text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 focus:outline-hidden focus:ring-2 focus:ring-blue-500"
          >
            {open
              ? t('admin.providers.timeouts.hide', 'Hide')
              : t('admin.providers.timeouts.edit', 'Edit')}
          </button>
        )}
      </div>

      {failed && (
        <AdminLoadGate
          load={load}
          resourceLabel={t('admin.providers.timeouts.title', 'Timeouts for all providers')}
          className="mt-4"
        />
      )}

      <div id="llm-timeouts-body" hidden={!open || failed} className="mt-4">
        <p className="mb-4 text-sm text-gray-600 dark:text-gray-400">
          {t(
            'admin.providers.timeouts.description',
            'Apply to every model unless its provider or the model sets its own. Changes take effect on the next request; no restart is needed. Leave a field empty to use the default.'
          )}
        </p>
        {loading && (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('common.loading', 'Loading...')}
          </p>
        )}
        {ready && (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {fields.map(({ key, label, hint }) => (
                <div key={key}>
                  <label htmlFor={`llm-timeout-${key}`} className={LABEL_CLASS}>
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
                    className={INPUT_CLASS}
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

            {message?.type === 'success' && (
              <p role="status" className="mt-4 text-sm text-green-700 dark:text-green-300">
                {message.text}
              </p>
            )}
          </>
        )}
      </div>
    </form>
  );
}

export default LlmTimeoutsCard;
