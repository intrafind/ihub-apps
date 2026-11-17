// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';
import AdminLoadGate from './AdminLoadGate';
import { useAdminConfigLoad } from '../hooks/useAdminConfigLoad';
import { useDirtyReport } from '../hooks/useDirtyReport';

/** The limiters, in the order the server lists them (`RATE_LIMITER_KEYS`). */
export const RATE_LIMITERS = [
  'publicApi',
  'adminApi',
  'authApi',
  'oauthApi',
  'oauthTokenApi',
  'inferenceApi',
  'provenanceVerifyApi'
];

const COUNT_MODES = ['all', 'failed', 'successful'];

/** Same bounds as the server: a second to a day, one request to a million. */
const MAX_WINDOW_MINUTES = 24 * 60;
const MAX_LIMIT = 1_000_000;

const toMinutes = windowMs => Math.round((windowMs / 60000) * 100) / 100;

/** Saved limits → editable form values (the window in minutes, as text). */
function toForm(limiters) {
  return Object.fromEntries(
    RATE_LIMITERS.filter(key => limiters?.[key]).map(key => [
      key,
      {
        limit: String(limiters[key].limit),
        minutes: String(toMinutes(limiters[key].windowMs)),
        counts: limiters[key].counts
      }
    ])
  );
}

/**
 * Form values → the PUT body, or the key of the first invalid limiter.
 *
 * @returns {{ limiters?: object, invalid?: string }}
 */
export function toRequest(form) {
  const limiters = {};
  for (const [key, value] of Object.entries(form)) {
    const limit = Number(value.limit);
    const minutes = Number(value.minutes);
    const windowMs = Math.round(minutes * 60000);
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_LIMIT ||
      !Number.isFinite(minutes) ||
      windowMs < 1000 ||
      minutes > MAX_WINDOW_MINUTES
    ) {
      return { invalid: key };
    }
    limiters[key] = { windowMs, limit, counts: value.counts };
  }
  return { limiters };
}

/**
 * Admin → Security → Rate limits. Edits `rateLimit` in platform.json through
 * `/api/admin/rate-limits`; the limits apply after a restart, so the section
 * also shows what the server is running with until then.
 *
 * @param {Object} props
 * @param {(dirty: boolean) => void} [props.onDirtyChange] - Reports unsaved edits to the page.
 */
function RateLimitConfig({ onDirtyChange }) {
  const { t } = useTranslation();
  const [form, setForm] = useState({});
  const [saved, setSaved] = useState({});
  // The form as last loaded or saved; null until it loaded.
  const [savedForm, setSavedForm] = useState(null);
  useDirtyReport(savedForm, form, onDirtyChange);
  const [running, setRunning] = useState({});
  const [restartRequired, setRestartRequired] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  const apply = data => {
    const loadedForm = toForm(data?.limiters);
    setForm(loadedForm);
    setSavedForm(loadedForm);
    setSaved(data?.limiters || {});
    setRunning(data?.running || {});
    setRestartRequired(Boolean(data?.restartRequired));
  };

  // No form and no Save until the limits loaded: saving the empty form after a
  // failed load would send no limiters at all.
  const load = useAdminConfigLoad({
    sources: {
      limits: {
        load: async () => (await makeAdminApiCall('/admin/rate-limits', { method: 'GET' })).data,
        onLoad: apply
      }
    }
  });
  const ready = load.status === 'ready';

  const update = (key, field, value) => {
    setForm(prev => ({ ...prev, [key]: { ...prev[key], [field]: value } }));
  };

  const countsLabel = counts => t(`admin.security.rateLimits.counts.${counts}`);

  const handleSave = async () => {
    if (!ready) return;
    const { limiters, invalid } = toRequest(form);
    if (invalid) {
      setMessage({
        type: 'error',
        text: t('admin.security.rateLimits.invalid', {
          name: t(`admin.security.rateLimits.limiters.${invalid}.name`)
        })
      });
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      const response = await makeAdminApiCall('/admin/rate-limits', {
        method: 'PUT',
        body: { limiters }
      });
      apply(response.data);
      setMessage({ type: 'success', text: t('admin.security.rateLimits.saved') });
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.message || t('admin.security.rateLimits.saveError')
      });
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'w-full px-3 py-2 border border-admin-control-border dark:border-admin-control-border-dark rounded-md shadow-xs focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:text-gray-100 text-sm';

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6">
      <div className="flex items-start mb-4">
        <Icon name="ClockIcon" className="w-6 h-6 mr-2 text-blue-500 shrink-0" />
        <div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            {t('admin.security.rateLimits.title')}
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            {t('admin.security.rateLimits.description')}
          </p>
        </div>
      </div>

      {!ready ? (
        <AdminLoadGate
          load={load}
          resourceLabel={t('admin.security.rateLimits.title')}
          loadingFallback={
            <p className="text-gray-600 dark:text-gray-400">{t('common.loading', 'Loading...')}</p>
          }
        />
      ) : (
        <>
          {restartRequired && (
            <div
              className="mb-4 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg flex"
              data-testid="rate-limits-restart"
            >
              <Icon
                name="ExclamationTriangleIcon"
                className="w-5 h-5 text-yellow-700 dark:text-yellow-400 mt-0.5 mr-3 shrink-0"
              />
              <p className="text-sm text-yellow-800 dark:text-yellow-300">
                {t('admin.security.rateLimits.restartRequired')}
              </p>
            </div>
          )}

          {message && (
            <div
              role={message.type === 'error' ? 'alert' : 'status'}
              className={`mb-4 p-4 rounded-md text-sm ${
                message.type === 'success'
                  ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-300'
                  : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
              }`}
            >
              {message.text}
            </div>
          )}

          <div className="space-y-4">
            {RATE_LIMITERS.filter(key => form[key]).map(key => {
              const value = form[key];
              // What the server runs with, when that is not what is saved.
              const now = running[key];
              const pending =
                restartRequired &&
                now &&
                saved[key] &&
                (now.limit !== saved[key].limit ||
                  now.windowMs !== saved[key].windowMs ||
                  now.counts !== saved[key].counts);
              const id = `rate-limit-${key}`;
              return (
                <fieldset
                  key={key}
                  className="p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg"
                  data-testid={id}
                >
                  <legend className="sr-only">
                    {t(`admin.security.rateLimits.limiters.${key}.name`)}
                  </legend>
                  <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {t(`admin.security.rateLimits.limiters.${key}.name`)}
                  </h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 mb-3">
                    {t(`admin.security.rateLimits.limiters.${key}.description`)}
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label
                        htmlFor={`${id}-limit`}
                        className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1"
                      >
                        {t('admin.security.rateLimits.limit')}
                      </label>
                      <input
                        id={`${id}-limit`}
                        type="number"
                        min="1"
                        max={MAX_LIMIT}
                        step="1"
                        value={value.limit}
                        onChange={e => update(key, 'limit', e.target.value)}
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`${id}-window`}
                        className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1"
                      >
                        {t('admin.security.rateLimits.window')}
                      </label>
                      <input
                        id={`${id}-window`}
                        type="number"
                        min="0.1"
                        max={MAX_WINDOW_MINUTES}
                        step="any"
                        value={value.minutes}
                        onChange={e => update(key, 'minutes', e.target.value)}
                        className={inputClass}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor={`${id}-counts`}
                        className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1"
                      >
                        {t('admin.security.rateLimits.countsLabel')}
                      </label>
                      <select
                        id={`${id}-counts`}
                        value={value.counts}
                        onChange={e => update(key, 'counts', e.target.value)}
                        className={inputClass}
                      >
                        {COUNT_MODES.map(mode => (
                          <option key={mode} value={mode}>
                            {countsLabel(mode)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {pending && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                      {t('admin.security.rateLimits.runningNow', {
                        limit: now.limit,
                        minutes: toMinutes(now.windowMs),
                        counts: countsLabel(now.counts)
                      })}
                    </p>
                  )}
                </fieldset>
              );
            })}
          </div>

          <p className="text-xs text-gray-500 dark:text-gray-400 mt-4">
            {t('admin.security.rateLimits.perAddress')}
          </p>

          <div className="flex justify-end mt-4">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-xs text-white bg-blue-600 hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:bg-gray-400 disabled:cursor-not-allowed"
            >
              <Icon name="CheckIcon" className="w-4 h-4 mr-2" />
              {saving ? t('admin.security.rateLimits.saving') : t('admin.security.rateLimits.save')}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export default RateLimitConfig;
