// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';
import { usePlatformConfig } from '../../../shared/contexts/PlatformConfigContext';
import AdminSettingsPage from '../components/AdminSettingsPage';
import { CHECKBOX_CLASS } from '../components/formStyles';
import AdminLoadGate from '../components/AdminLoadGate';
import { useAdminConfigLoad } from '../hooks/useAdminConfigLoad';
import { deepEqual } from '../hooks/useUnsavedChanges';
import { bareScriptHost, isScriptHost } from '../../../../../shared/artifactPreview.js';

const MB = 1024 * 1024;

/** The public CDNs iHub allows when nothing is configured (`shared/artifactPreview.js`). */
const DEFAULT_SCRIPT_HOSTS = ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com'];

const INPUT =
  'block w-full px-3 py-2 border border-admin-control-border dark:border-admin-control-border-dark bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-md shadow-xs focus:ring-admin-accent focus:border-admin-accent sm:text-sm';
const CARD =
  'bg-white dark:bg-gray-800 rounded-lg shadow-xs border border-gray-200 dark:border-gray-700 p-6 space-y-4';
const HINT = 'text-sm text-gray-600 dark:text-gray-400';

/** A size in bytes as megabytes for the form; a cap of zero or less is shown as 0 (no limit). */
function toMb(bytes) {
  return bytes > 0 ? String(Math.round((bytes / MB) * 100) / 100) : '0';
}

/** The form of the settings the server answered. */
function formOf(config) {
  return {
    enabled: config.enabled !== false,
    maxMb: toMb(config.maxBytes),
    maxPerBatch: String(config.maxPerBatch),
    maxZipFiles: String(config.maxZipFiles),
    maxZipMb: toMb(config.maxZipBytes),
    scriptHosts: Array.isArray(config.scriptHosts) ? config.scriptHosts : [],
    libraryKitEnabled: config.libraryKit?.enabled !== false
  };
}

/** A whole number from a form field, or null when it is not one. */
function wholeNumber(value) {
  const number = Number(value);
  return String(value).trim() !== '' && Number.isInteger(number) ? number : null;
}

/** Megabytes from a form field as bytes (0 = no limit), or null when it is not a number. */
function bytesOf(value) {
  const number = Number(value);
  if (String(value).trim() === '' || !Number.isFinite(number)) return null;
  return number <= 0 ? 0 : Math.round(number * MB);
}

/**
 * The fields of the form that differ from the saved form, as the PUT body. A
 * field left as it was is not sent, so a size that does not fall on a whole
 * megabyte is not rounded by a save of something else.
 *
 * @returns {{ body: Object, invalid: string[] }}
 */
function changesOf(form, saved) {
  const body = {};
  const invalid = [];
  if (form.enabled !== saved.enabled) body.enabled = form.enabled;
  const numbers = [
    ['maxMb', 'maxBytes', bytesOf],
    ['maxPerBatch', 'maxPerBatch', wholeNumber],
    ['maxZipFiles', 'maxZipFiles', wholeNumber],
    ['maxZipMb', 'maxZipBytes', bytesOf]
  ];
  for (const [field, key, parse] of numbers) {
    if (form[field] === saved[field]) continue;
    const value = parse(form[field]);
    if (value === null) invalid.push(field);
    else body[key] = Math.max(0, value);
  }
  if (!deepEqual(form.scriptHosts, saved.scriptHosts)) body.scriptHosts = form.scriptHosts;
  if (form.libraryKitEnabled !== saved.libraryKitEnabled) {
    body.libraryKit = { enabled: form.libraryKitEnabled };
  }
  return { body, invalid };
}

function Toggle({ id, checked, onChange, label, hint, disabled }) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        className={`mt-1 ${CHECKBOX_CLASS}`}
        checked={checked}
        disabled={disabled}
        aria-describedby={hint ? `${id}-hint` : undefined}
        onChange={event => onChange(event.target.checked)}
      />
      <div>
        <label htmlFor={id} className="block text-sm font-medium text-gray-900 dark:text-gray-100">
          {label}
        </label>
        {hint && (
          <p id={`${id}-hint`} className={HINT}>
            {hint}
          </p>
        )}
      </div>
    </div>
  );
}

function NumberField({ id, label, hint, value, onChange, step = '1', invalid, unit }) {
  return (
    <div>
      <label
        htmlFor={id}
        className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
      >
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          min="0"
          step={step}
          inputMode="decimal"
          className={`${INPUT} max-w-[12rem]`}
          value={value}
          aria-invalid={invalid ? 'true' : undefined}
          aria-describedby={`${id}-hint`}
          onChange={event => onChange(event.target.value)}
        />
        {unit && <span className="text-sm text-gray-600 dark:text-gray-400">{unit}</span>}
      </div>
      <p id={`${id}-hint`} className={`mt-1 ${HINT}`}>
        {hint}
      </p>
    </div>
  );
}

/**
 * Admin → Artifacts (#3822): everything under `platform.artifacts` — whether
 * runs keep what they produce, the size limits, the CDN hosts an HTML
 * artifact's preview may load scripts from, and the library kit that makes
 * charts work without any CDN. Saved through `PUT /api/admin/artifacts/config`;
 * every change takes effect without a restart.
 */
function AdminArtifactsPage() {
  const { t } = useTranslation();
  const { refreshConfig } = usePlatformConfig();
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(null);
  const [libraries, setLibraries] = useState([]);
  const [newHost, setNewHost] = useState('');
  const [hostError, setHostError] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [invalid, setInvalid] = useState([]);
  // The ETag of the settings the form was loaded from (or last saved as): sent
  // as If-Match, so a save over someone else's newer change is refused.
  const revisionRef = useRef(null);

  const apply = config => {
    const loaded = formOf(config);
    setForm(loaded);
    setSaved(loaded);
    setLibraries(Array.isArray(config.libraries) ? config.libraries : []);
  };

  const fetchConfig = async () => {
    const response = await makeAdminApiCall('/admin/artifacts/config', { method: 'GET' });
    revisionRef.current = response.headers?.etag || null;
    return response.data;
  };

  // No form and no Save until the settings loaded: saving the empty form after
  // a failed load would overwrite the stored settings.
  const load = useAdminConfigLoad({
    sources: {
      artifacts: {
        load: fetchConfig,
        onLoad: apply
      }
    }
  });
  const ready = load.status === 'ready' && form !== null && saved !== null;
  const dirty = ready && !deepEqual(form, saved);
  const set = key => value => {
    setForm(prev => ({ ...prev, [key]: value }));
    setInvalid(prev => prev.filter(field => field !== key));
  };

  const addHost = () => {
    const host = bareScriptHost(newHost);
    if (!host) return;
    if (!isScriptHost(host)) {
      setHostError(
        t(
          'admin.artifacts.hosts.invalid',
          'Not a plain host name. Use a host such as cdn.example.com, without wildcard, path, port or http:.'
        )
      );
      return;
    }
    setHostError('');
    if (!form.scriptHosts.includes(host)) set('scriptHosts')([...form.scriptHosts, host]);
    setNewHost('');
  };

  const save = async () => {
    if (!ready) return;
    const { body, invalid: wrong } = changesOf(form, saved);
    if (wrong.length) {
      setInvalid(wrong);
      setMessage({
        type: 'error',
        text: t('admin.artifacts.invalidNumbers', 'Enter a number of zero or more in every field.')
      });
      return;
    }
    setSaving(true);
    setMessage(null);
    const submitted = form;
    try {
      const response = await makeAdminApiCall('/admin/artifacts/config', {
        method: 'PUT',
        body,
        headers: revisionRef.current ? { 'If-Match': revisionRef.current } : {}
      });
      revisionRef.current = response.headers?.etag || null;
      // The answer is the new saved state. Edits made while the save was on
      // its way stay in the form (and keep it dirty).
      const nowSaved = formOf(response.data);
      setSaved(nowSaved);
      setForm(current => (deepEqual(current, submitted) ? nowSaved : current));
      setLibraries(Array.isArray(response.data.libraries) ? response.data.libraries : []);
      setMessage({
        type: 'success',
        text: t('admin.artifacts.saved', 'Artifact settings saved. They apply right away.')
      });
      refreshConfig();
    } catch (error) {
      const status = error?.response?.status ?? error?.status;
      setMessage(
        status === 412
          ? {
              type: 'error',
              conflict: true,
              text: t(
                'admin.artifacts.conflict',
                'Someone else changed the artifact settings after you opened this page, so nothing was saved. Your edits are still here: load the current settings, then make your change again.'
              )
            }
          : {
              type: 'error',
              text:
                error.message ||
                t('admin.artifacts.saveError', 'The artifact settings could not be saved.')
            }
      );
    } finally {
      setSaving(false);
    }
  };

  const reloadCurrent = async () => {
    try {
      apply(await fetchConfig());
      setInvalid([]);
      setMessage(null);
    } catch (error) {
      setMessage({
        type: 'error',
        conflict: true,
        text:
          error.message ||
          t('admin.artifacts.reloadError', 'The current settings could not be loaded.')
      });
    }
  };

  const discard = () => {
    setForm(saved);
    setInvalid([]);
    setMessage(null);
  };

  // Until the settings loaded, the page shows one section with the load state
  // (loading, or the error with a retry) instead of four empty forms.
  const gate = children => (ready ? children() : null);

  const kitOn = form?.libraryKitEnabled;
  const offline = form?.scriptHosts.length === 0;

  const loadingSections = [
    {
      id: 'storage',
      label: t('admin.artifacts.sections.storage', 'Storage'),
      children: (
        <AdminLoadGate
          load={load}
          resourceLabel={t('admin.artifacts.resource', 'artifact settings')}
          loadingFallback={<p className={HINT}>{t('common.loading', 'Loading...')}</p>}
        >
          {() => null}
        </AdminLoadGate>
      )
    }
  ];

  const sections = [
    {
      id: 'storage',
      label: t('admin.artifacts.sections.storage', 'Storage'),
      children: gate(() => (
        <div className={CARD}>
          <Toggle
            id="artifacts-enabled"
            checked={form.enabled}
            onChange={set('enabled')}
            label={t('admin.artifacts.enabled', 'Keep generated files')}
            hint={t(
              'admin.artifacts.enabledHint',
              'Images, documents, web artifacts and other files that chats, workflows and agents produce are stored with them. Off: a file is visible while it is shown and gone afterwards.'
            )}
          />
          <NumberField
            id="artifacts-max-bytes"
            label={t('admin.artifacts.maxBytes', 'Largest file')}
            unit="MB"
            step="0.5"
            value={form.maxMb}
            invalid={invalid.includes('maxMb')}
            onChange={set('maxMb')}
            hint={t('admin.artifacts.maxBytesHint', 'Per file. 0 = no limit.')}
          />
          <NumberField
            id="artifacts-max-per-batch"
            label={t('admin.artifacts.maxPerBatch', 'Files per step')}
            value={form.maxPerBatch}
            invalid={invalid.includes('maxPerBatch')}
            onChange={set('maxPerBatch')}
            hint={t(
              'admin.artifacts.maxPerBatchHint',
              'How many files one answer or step may store at once. 0 = no limit.'
            )}
          />
        </div>
      ))
    },
    {
      id: 'downloads',
      label: t('admin.artifacts.sections.downloads', 'ZIP downloads'),
      children: gate(() => (
        <div className={CARD}>
          <p className={HINT}>
            {t(
              'admin.artifacts.downloadsHint',
              'Limits of one ZIP archive: "Download all" in a chat or a share, and archives the create_zip tool builds.'
            )}
          </p>
          <NumberField
            id="artifacts-max-zip-files"
            label={t('admin.artifacts.maxZipFiles', 'Files per archive')}
            value={form.maxZipFiles}
            invalid={invalid.includes('maxZipFiles')}
            onChange={set('maxZipFiles')}
            hint={t('admin.artifacts.zeroNoLimit', '0 = no limit.')}
          />
          <NumberField
            id="artifacts-max-zip-bytes"
            label={t('admin.artifacts.maxZipBytes', 'Archive size')}
            unit="MB"
            step="1"
            value={form.maxZipMb}
            invalid={invalid.includes('maxZipMb')}
            onChange={set('maxZipMb')}
            hint={t('admin.artifacts.maxZipBytesHint', 'Content before compression. 0 = no limit.')}
          />
        </div>
      ))
    },
    {
      id: 'libraryKit',
      label: t('admin.artifacts.sections.libraryKit', 'Library kit'),
      children: gate(() => (
        <div className={CARD}>
          <Toggle
            id="artifacts-library-kit"
            checked={form.libraryKitEnabled}
            onChange={set('libraryKitEnabled')}
            label={t(
              'admin.artifacts.kit.enabled',
              'Offer the built-in libraries to HTML artifacts'
            )}
            hint={t(
              'admin.artifacts.kit.enabledHint',
              'Charts and interactive pages work without internet access: iHub inlines these vetted libraries into the preview, the embed page and every download. The assistant uses them by default and a public CDN only when a user asks for one.'
            )}
          />
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm" data-testid="artifact-library-kit">
              <caption className="sr-only">
                {t('admin.artifacts.kit.tableCaption', 'Libraries in the kit')}
              </caption>
              <thead>
                <tr className="text-left text-gray-600 dark:text-gray-400">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t('admin.artifacts.kit.library', 'Library')}
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t('admin.artifacts.kit.version', 'Version')}
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t('admin.artifacts.kit.marker', 'Marker')}
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t('admin.artifacts.kit.license', 'License')}
                  </th>
                  <th scope="col" className="py-2 pr-4 font-medium">
                    {t('admin.artifacts.kit.size', 'Size')}
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    {t('admin.artifacts.kit.status', 'Status')}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {libraries.map(library => (
                  <tr key={library.id} className="text-gray-900 dark:text-gray-100">
                    <td className="py-2 pr-4 font-medium">{library.name}</td>
                    <td className="py-2 pr-4 font-mono">{library.version}</td>
                    <td className="py-2 pr-4 whitespace-nowrap">
                      <code className="text-xs">{`data-ihub-lib="${library.id}"`}</code>
                    </td>
                    <td className="py-2 pr-4">{library.license}</td>
                    <td className="py-2 pr-4 tabular-nums whitespace-nowrap">
                      {Math.round(library.bytes / 1024)} KB
                    </td>
                    <td className="py-2 whitespace-nowrap">
                      {library.available ? (
                        <span className="inline-flex items-center gap-1 text-green-700 dark:text-green-300">
                          <Icon name="check" size="sm" />
                          {t('admin.artifacts.kit.available', 'Verified')}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-300">
                          <Icon name="warning" size="sm" />
                          {t('admin.artifacts.kit.missing', 'File missing or changed')}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={HINT}>
            {t(
              'admin.artifacts.kit.supplyChain',
              'The files ship with iHub, copied unchanged from npm at exactly these versions and checked against their recorded SHA-256 before they are used.'
            )}
          </p>
        </div>
      ))
    },
    {
      id: 'scriptHosts',
      label: t('admin.artifacts.sections.scriptHosts', 'CDN hosts'),
      children: gate(() => (
        <div className={CARD}>
          <p className={HINT}>
            {t(
              'admin.artifacts.hosts.description',
              'Hosts the preview of an HTML artifact may load scripts and stylesheets from over https. Everything else stays blocked: no fetch, no remote images or fonts. Remove every host to keep previews fully offline; with the library kit on, charts still work.'
            )}
          </p>
          {offline && (
            <p
              role="status"
              className="rounded-md bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 p-3 text-sm text-green-800 dark:text-green-200"
            >
              {kitOn
                ? t(
                    'admin.artifacts.hosts.offlineWithKit',
                    'Offline: previews load nothing from the internet. Chart.js, D3 and Alpine.js come from the library kit.'
                  )
                : t(
                    'admin.artifacts.hosts.offlineNoKit',
                    'Offline: previews load nothing from the internet, and with the library kit off no library is available at all.'
                  )}
            </p>
          )}
          <div>
            <label
              htmlFor="artifacts-new-host"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
            >
              {t('admin.artifacts.hosts.add', 'Add a host')}
            </label>
            <div className="flex gap-2">
              <input
                id="artifacts-new-host"
                type="text"
                className={`${INPUT} flex-1`}
                value={newHost}
                placeholder="cdn.example.com"
                aria-invalid={hostError ? 'true' : undefined}
                aria-describedby={hostError ? 'artifacts-new-host-error' : undefined}
                onChange={event => {
                  setNewHost(event.target.value);
                  setHostError('');
                }}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addHost();
                  }
                }}
              />
              <button
                type="button"
                onClick={addHost}
                disabled={!newHost.trim()}
                className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-xs text-white bg-blue-600 hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
              >
                <Icon name="PlusIcon" className="w-4 h-4 mr-1" />
                {t('admin.artifacts.hosts.addButton', 'Add')}
              </button>
            </div>
            {hostError && (
              <p
                id="artifacts-new-host-error"
                className="mt-1 text-sm text-red-700 dark:text-red-300"
              >
                {hostError}
              </p>
            )}
          </div>
          {form.scriptHosts.length > 0 ? (
            <ul className="space-y-2" aria-label={t('admin.artifacts.hosts.list', 'Allowed hosts')}>
              {form.scriptHosts.map(host => (
                <li
                  key={host}
                  className="flex items-center justify-between p-3 bg-gray-50 dark:bg-gray-700 rounded-md"
                >
                  <span className="text-sm font-mono text-gray-900 dark:text-gray-100">{host}</span>
                  <button
                    type="button"
                    onClick={() => set('scriptHosts')(form.scriptHosts.filter(h => h !== host))}
                    className="text-sm font-medium text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
                    aria-label={t('admin.artifacts.hosts.removeNamed', 'Remove {{host}}', { host })}
                  >
                    {t('admin.artifacts.hosts.remove', 'Remove')}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => set('scriptHosts')([])}
              disabled={offline}
              className="px-3 py-1.5 text-sm rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              {t('admin.artifacts.hosts.goOffline', 'Remove all (offline)')}
            </button>
            <button
              type="button"
              onClick={() => set('scriptHosts')([...DEFAULT_SCRIPT_HOSTS])}
              disabled={deepEqual(form.scriptHosts, DEFAULT_SCRIPT_HOSTS)}
              className="px-3 py-1.5 text-sm rounded-md border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
            >
              {t('admin.artifacts.hosts.restoreDefaults', 'Use the public defaults')}
            </button>
          </div>
        </div>
      ))
    }
  ];

  return (
    <AdminSettingsPage
      title={t('admin.nav.artifacts', 'Artifacts')}
      description={t(
        'admin.artifacts.description',
        'Generated files: storage, size limits, and what HTML artifacts may load'
      )}
      banner={
        message ? (
          <p
            role={message.type === 'error' ? 'alert' : 'status'}
            className={`rounded-md p-3 text-sm ${
              message.type === 'success'
                ? 'bg-green-50 dark:bg-green-900/30 text-green-800 dark:text-green-200'
                : 'bg-red-50 dark:bg-red-900/30 text-red-800 dark:text-red-200'
            }`}
          >
            {message.text}
            {message.conflict && (
              <button
                type="button"
                onClick={reloadCurrent}
                className="ml-2 font-medium underline hover:no-underline"
              >
                {t('admin.artifacts.reload', 'Load the current settings')}
              </button>
            )}
          </p>
        ) : null
      }
      sections={ready ? sections : loadingSections}
      dirty={dirty}
      saving={saving}
      onSave={save}
      onDiscard={discard}
    />
  );
}

export default AdminArtifactsPage;
