// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import Switch from '../../../shared/components/Switch';
import { getAdminApiErrorMessage, makeAdminApiCall } from '../../../api/adminApi';
import AdminLoadGate from '../components/AdminLoadGate';
import AdminSaveBar from '../components/AdminSaveBar';
import UnsavedChangesDialog from '../components/UnsavedChangesDialog';
import { useAdminConfigLoad } from '../hooks/useAdminConfigLoad';
import { useSavedBaseline } from '../hooks/useSavedBaseline';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';

const CONFIG_URL = '/admin/embed-auth/config';

const CARD =
  'bg-white dark:bg-gray-800 rounded-xl shadow-xs border border-gray-200 dark:border-gray-700 p-6';
const NOTICE =
  'rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300';

/**
 * An origin the way the server accepts it (`canonicalizeOrigin` in server/utils/hostOrigins.js):
 * `http(s)`, scheme and host and an optional port, no path, query, fragment or credentials.
 *
 * @param {unknown} raw
 * @returns {string|null} The canonical origin, or null when it is not valid.
 */
export function canonicalizeOrigin(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.pathname && url.pathname !== '/') return null;
  if (url.search || url.hash) return null;
  return url.origin;
}

/** Browsers treat a `Secure` cookie on these as safe although they are not served over HTTPS. */
const isLocalHost = hostname => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

/**
 * Admin → Integrations → iHub in another site: the switch of the sign-in in a frame, and the list
 * of sites that may show iHub in a frame. See docs/embed-mode.md.
 */
function AdminEmbedAuthPage() {
  const { t } = useTranslation();
  const originInputId = useId();
  const originErrorId = useId();

  const [enabled, setEnabled] = useState(false);
  const [origins, setOrigins] = useState([]);
  const [newOrigin, setNewOrigin] = useState('');
  const [originError, setOriginError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  // Why the last save failed, shown next to the save bar (the banner above may be off screen).
  const [saveError, setSaveError] = useState(null);

  // The unsaved-changes guard: the baseline is captured after every successful load and save, so
  // a page that was just loaded is never dirty. An origin typed but not yet added counts as an edit.
  const editedValues = useMemo(
    () => ({ enabled, origins, newOrigin }),
    [enabled, origins, newOrigin]
  );
  const { baseline, captureBaseline } = useSavedBaseline(editedValues);
  const { isDirty, blocker } = useUnsavedChanges(baseline, editedValues);

  const fetchConfig = async () => (await makeAdminApiCall(CONFIG_URL, { method: 'GET' })).data;

  /** Put loaded or saved settings into the form; they are the new baseline. */
  const applyConfig = data => {
    setEnabled(data?.enabled === true);
    setOrigins(Array.isArray(data?.allowedHostOrigins) ? data.allowedHostOrigins.slice() : []);
    setNewOrigin('');
    setOriginError(null);
    captureBaseline();
  };

  // No form and no Save until the settings loaded: saving after a failed load would store an
  // empty list over the real one.
  const load = useAdminConfigLoad({
    sources: { config: { load: fetchConfig, onLoad: applyConfig } }
  });
  const ready = load.status === 'ready';

  const invalidOriginText = t(
    'admin.embedAuth.originInvalid',
    'Enter an origin such as https://ifinder.example.com: scheme and host, without a path.'
  );

  const addOrigin = () => {
    const canonical = canonicalizeOrigin(newOrigin);
    if (!canonical) {
      setOriginError(invalidOriginText);
      return;
    }
    setOrigins(previous => (previous.includes(canonical) ? previous : [...previous, canonical]));
    setNewOrigin('');
    setOriginError(null);
  };

  const removeOrigin = origin => setOrigins(previous => previous.filter(entry => entry !== origin));

  const handleSave = async () => {
    if (!ready) return;
    // An origin that is typed but not added yet is part of what the person means to save.
    let toSave = origins;
    if (newOrigin.trim()) {
      const canonical = canonicalizeOrigin(newOrigin);
      if (!canonical) {
        setOriginError(invalidOriginText);
        return;
      }
      toSave = origins.includes(canonical) ? origins : [...origins, canonical];
    }
    try {
      setSaving(true);
      setMessage(null);
      setSaveError(null);
      const response = await makeAdminApiCall(CONFIG_URL, {
        method: 'PUT',
        body: { enabled, allowedHostOrigins: toSave }
      });
      applyConfig(response.data);
      setMessage({
        type: 'success',
        text: t('admin.embedAuth.saved', 'Settings saved. They apply at once.')
      });
      setTimeout(() => setMessage(null), 4000);
    } catch (err) {
      console.error('[embed-auth] save failed', err);
      const text = `${t('admin.embedAuth.saveError', 'The settings could not be saved.')} ${getAdminApiErrorMessage(err)}`;
      setMessage({ type: 'error', text });
      setSaveError(text);
    } finally {
      setSaving(false);
    }
  };

  // Back to the loaded values, the half-typed origin included.
  const handleDiscard = () => {
    if (!baseline) return;
    setEnabled(baseline.enabled);
    setOrigins(baseline.origins);
    setNewOrigin('');
    setOriginError(null);
    setMessage(null);
    setSaveError(null);
  };

  // What the person would have after saving, for the notices: a typed origin counts.
  const pendingCanonical = canonicalizeOrigin(newOrigin);
  const effectiveOrigins =
    pendingCanonical && !origins.includes(pendingCanonical)
      ? [...origins, pendingCanonical]
      : origins;
  const insecureOrigins = effectiveOrigins.filter(origin => {
    const url = new URL(origin);
    return url.protocol === 'http:' && !isLocalHost(url.hostname);
  });
  const pageIsInsecure =
    window.location.protocol === 'http:' && !isLocalHost(window.location.hostname);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="bg-white dark:bg-gray-800 shadow-xs border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <Link
            to="/admin/integrations"
            className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            ← {t('admin.integrations.backToIntegrations', 'Back to Integrations')}
          </Link>
          <h1 className="mt-2 text-3xl font-bold text-gray-900 dark:text-gray-100">
            {t('admin.embedAuth.title', 'iHub in another site')}
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mt-2">
            {t(
              'admin.embedAuth.description',
              'Show iHub in an iframe of another product, such as iFinder or a portal, and let people sign in there through your identity provider.'
            )}
          </p>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        {message && (
          <div
            role={message.type === 'error' ? 'alert' : 'status'}
            className={`rounded-lg px-4 py-3 text-sm ${
              message.type === 'error'
                ? 'bg-red-50 text-red-700 border border-red-200 dark:bg-red-900/20 dark:text-red-400'
                : 'bg-green-50 text-green-700 border border-green-200 dark:bg-green-900/20 dark:text-green-400'
            }`}
          >
            {message.text}
          </div>
        )}

        {!ready ? (
          <AdminLoadGate
            load={load}
            resourceLabel={t('admin.embedAuth.resource', 'settings for iHub in another site')}
          />
        ) : (
          <>
            <div className={CARD}>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                {t('admin.embedAuth.statusTitle', 'Sign-in in a frame')}
              </h2>
              <Switch
                size="md"
                checked={enabled}
                onChange={setEnabled}
                label={t(
                  'admin.embedAuth.enabledLabel',
                  'Allow sign-in when iHub is shown in another site'
                )}
                description={t(
                  'admin.embedAuth.enabledHint',
                  'Identity providers such as Microsoft Entra ID do not allow their login page in a frame. With this on, the sign-in opens in a pop-up window and the frame continues when it is done.'
                )}
              />
              {enabled && effectiveOrigins.length === 0 && (
                <p role="note" className={`${NOTICE} mt-4`}>
                  {t(
                    'admin.embedAuth.noSiteWarning',
                    'The switch is on, but no site is allowed yet, so nothing changes. Add the site that shows iHub below.'
                  )}
                </p>
              )}
              {!enabled && effectiveOrigins.length > 0 && (
                <p role="note" className={`${NOTICE} mt-4`}>
                  {t(
                    'admin.embedAuth.offWithSitesNote',
                    'The switch is off. The list is kept but not in force: the sign-in in a frame is not available, and iHub is not limited to these sites.'
                  )}
                </p>
              )}
              {enabled && pageIsInsecure && (
                <p role="note" className={`${NOTICE} mt-4`}>
                  {t(
                    'admin.embedAuth.insecurePage',
                    'iHub is not served over HTTPS here. The session cookie of the frame needs HTTPS, so the sign-in in a frame will not work.'
                  )}
                </p>
              )}
            </div>

            <div className={CARD}>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
                {t('admin.embedAuth.originsTitle', 'Sites that may show iHub')}
              </h2>
              <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                {t(
                  'admin.embedAuth.originsDesc',
                  'While the switch is on, only these sites, and iHub itself, can show iHub in a frame. Add every site that does so, for example iFinder, an intranet portal or a Teams tab: a site that is not listed can no longer show iHub.'
                )}
              </p>
              <label
                htmlFor={originInputId}
                className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
              >
                {t('admin.embedAuth.originLabel', 'Site address')}
              </label>
              <div className="flex items-start gap-3 mb-4">
                <div className="flex-1">
                  <input
                    id={originInputId}
                    type="url"
                    value={newOrigin}
                    onChange={event => {
                      setNewOrigin(event.target.value);
                      setOriginError(null);
                    }}
                    onKeyDown={event => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        addOrigin();
                      }
                    }}
                    placeholder="https://ifinder.example.com"
                    aria-invalid={originError ? 'true' : undefined}
                    aria-describedby={originError ? originErrorId : undefined}
                    className="w-full rounded-lg border border-admin-control-border dark:border-admin-control-border-dark bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                  {originError && (
                    <p
                      id={originErrorId}
                      role="alert"
                      className="mt-1 text-sm text-red-600 dark:text-red-400"
                    >
                      {originError}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={addOrigin}
                  className="shrink-0 rounded-lg bg-indigo-600 text-white px-3 py-2 text-sm font-medium hover:bg-indigo-700"
                >
                  {t('admin.embedAuth.addOrigin', 'Add')}
                </button>
              </div>

              {origins.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400 italic">
                  {t('admin.embedAuth.noOrigins', 'No site added yet.')}
                </p>
              ) : (
                <ul className="space-y-2">
                  {origins.map(origin => (
                    <li
                      key={origin}
                      className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 bg-gray-50/60 dark:bg-gray-900/40"
                    >
                      <code className="text-sm font-mono text-gray-800 dark:text-gray-200 break-all">
                        {origin}
                      </code>
                      <button
                        type="button"
                        onClick={() => removeOrigin(origin)}
                        aria-label={t('admin.embedAuth.removeOrigin', 'Remove {{origin}}', {
                          origin
                        })}
                        className="shrink-0 rounded-sm px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
                      >
                        {t('admin.embedAuth.remove', 'Remove')}
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {insecureOrigins.map(origin => (
                <p key={origin} role="note" className={`${NOTICE} mt-4`}>
                  {t(
                    'admin.embedAuth.httpOrigin',
                    '{{origin}} is not served over HTTPS. The session cookie of the frame needs HTTPS, so signing in from that site will not work.',
                    { origin }
                  )}
                </p>
              ))}
            </div>

            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800 p-6">
              <h2 className="text-base font-semibold text-blue-900 dark:text-blue-300 mb-3">
                {t('admin.embedAuth.howTitle', 'What people see, and what to know')}
              </h2>
              <ul className="text-sm text-blue-800 dark:text-blue-300 space-y-1.5 list-disc list-inside">
                <li>
                  {t(
                    'admin.embedAuth.how1',
                    'People click Sign in in the frame and allow the pop-up if their browser asks. If they are already signed in at the identity provider, the window closes by itself.'
                  )}
                </li>
                <li>
                  {t(
                    'admin.embedAuth.how2',
                    'Both sites need HTTPS. The session of the frame is a cookie that scripts cannot read, and it is sent only while iHub is shown by the site it was made for.'
                  )}
                </li>
                <li>
                  {t(
                    'admin.embedAuth.how3',
                    'Saved settings apply at once, without a restart. Signing out in the frame ends the frame’s session only.'
                  )}
                </li>
              </ul>
            </div>
          </>
        )}
      </div>
      <AdminSaveBar
        dirty={ready && (isDirty || Boolean(saveError))}
        saving={saving}
        onSave={() => void handleSave()}
        onDiscard={handleDiscard}
        message={saveError}
      />
      <UnsavedChangesDialog blocker={blocker} />
    </div>
  );
}

export default AdminEmbedAuthPage;
