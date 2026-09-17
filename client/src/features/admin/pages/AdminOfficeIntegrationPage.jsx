import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import Icon from '../../../shared/components/Icon';
import ReorderableList from '../components/ReorderableList';
import { makeAdminApiCall } from '../../../api/adminApi';
import { fetchAdminApps } from '../../../api';
import { buildApiUrl } from '../../../utils/runtimeBasePath';
import { getLocalizedContent } from '../../../utils/localizeContent';

/** The values the task pane's landing view accepts; mirrored in server/utils/officeStartPage.js. */
const START_PAGE_CHOICES = ['start', 'apps'];

const DEFAULT_START_PAGE = { defaultPage: 'start', defaultAppId: '', featuredAppIds: [] };

// Only the known fields, each well-formed, whatever the server sent.
const readStartPage = value => ({
  defaultPage: START_PAGE_CHOICES.includes(value?.defaultPage) ? value.defaultPage : 'start',
  defaultAppId: typeof value?.defaultAppId === 'string' ? value.defaultAppId : '',
  featuredAppIds: Array.isArray(value?.featuredAppIds)
    ? value.featuredAppIds.filter(id => typeof id === 'string' && id.length > 0)
    : []
});

function AdminOfficeIntegrationPage() {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [message, setMessage] = useState(null);
  const [status, setStatus] = useState(null);

  const [displayName, setDisplayName] = useState({});
  const [description, setDescription] = useState({});
  const [starterPrompts, setStarterPrompts] = useState([]);
  const [useLocalOfficejs, setUseLocalOfficejs] = useState(false);
  // The task pane's landing view: which view opens after sign-in, the app
  // whose chat input the start page shows, and the curated app shortcuts.
  const [startPage, setStartPage] = useState(DEFAULT_START_PAGE);
  // Every configured app (admin endpoint), for the two app pickers below.
  const [apps, setApps] = useState([]);
  const [appsLoading, setAppsLoading] = useState(true);

  // Stable client-side ids are used as React keys while the prompt list is edited.
  // They are stripped before persisting so the server never sees them.
  const emptyPrompt = () => ({
    _id: crypto.randomUUID(),
    title: {},
    message: {}
  });

  // Keep only `{ [lang]: string }` entries so corrupted server data can't break
  // React rendering further down the tree.
  const sanitizeLocalized = (value = {}) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out = {};
    for (const [lang, val] of Object.entries(value)) {
      if (typeof val === 'string') out[lang] = val;
    }
    return out;
  };

  const loadStatus = async () => {
    try {
      setLoading(true);
      const res = await makeAdminApiCall('/admin/office-integration/status', { method: 'GET' });
      const data = res.data;
      setStatus(data);
      setDisplayName(sanitizeLocalized(data.displayName));
      setDescription(sanitizeLocalized(data.description));
      setUseLocalOfficejs(data.useLocalOfficejs === true);
      setStartPage(readStartPage(data.startPage));
      setStarterPrompts(
        Array.isArray(data.starterPrompts)
          ? data.starterPrompts.map(p => ({
              _id: crypto.randomUUID(),
              title: sanitizeLocalized(p?.title),
              message: sanitizeLocalized(p?.message)
            }))
          : []
      );
    } catch (_err) {
      setMessage({
        type: 'error',
        text: t('admin.officeIntegration.loadError', 'Failed to load Office Integration status')
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStatus();
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  useEffect(() => {
    let mounted = true;
    fetchAdminApps()
      .then(data => {
        const list = Array.isArray(data) ? data : Array.isArray(data?.apps) ? data.apps : [];
        if (mounted) setApps(list);
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setAppsLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // The start page needs a chat to send the message to — iframe/redirect
  // apps cannot be its default app. Any app may be a shortcut.
  const chatApps = useMemo(() => apps.filter(app => (app.type || 'chat') === 'chat'), [apps]);

  const appLabel = app =>
    `${getLocalizedContent(app.name, currentLanguage) || app.id}${
      app.enabled === false ? ` (${t('admin.officeIntegration.disabledApp', 'disabled')})` : ''
    }`;

  const updateStartPage = patch => setStartPage(prev => ({ ...prev, ...patch }));

  // Keep ids that no longer resolve to an app in the list so they stay
  // removable instead of silently occupying a slot.
  const featuredItems = startPage.featuredAppIds.map(id => ({
    id,
    app: apps.find(app => app.id === id) || null
  }));
  const addableApps = apps.filter(app => !startPage.featuredAppIds.includes(app.id));
  const featuredLabel = item =>
    item.app ? getLocalizedContent(item.app.name, currentLanguage) || item.id : item.id;
  const addFeaturedApp = id => {
    if (!id || startPage.featuredAppIds.includes(id)) return;
    updateStartPage({ featuredAppIds: [...startPage.featuredAppIds, id] });
  };
  const removeFeaturedApp = id => {
    updateStartPage({ featuredAppIds: startPage.featuredAppIds.filter(entry => entry !== id) });
  };

  const handleToggle = async () => {
    if (!status) return;
    const action = status.enabled ? 'disable' : 'enable';
    try {
      setToggling(true);
      setMessage(null);
      await makeAdminApiCall(`/admin/office-integration/${action}`, { method: 'POST' });
      await loadStatus();
      setMessage({
        type: 'success',
        text: status.enabled
          ? t('admin.officeIntegration.disabled', 'Office Integration disabled')
          : t(
              'admin.officeIntegration.enabled',
              'Office Integration enabled successfully. OAuth client has been created.'
            )
      });
    } catch (_err) {
      setMessage({
        type: 'error',
        text: t('admin.officeIntegration.toggleError', 'Failed to update Office Integration')
      });
    } finally {
      setToggling(false);
    }
  };

  // Drop empty/whitespace-only locales and ensure only string values are sent.
  const trimLocalized = (value = {}) => {
    const out = {};
    for (const [lang, val] of Object.entries(value || {})) {
      if (typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed.length > 0) out[lang] = trimmed;
      }
    }
    return out;
  };

  const handleSaveConfig = async () => {
    try {
      setSaving(true);
      setMessage(null);

      // Strip the client-only `_id` — the server must never see or persist it.
      const cleanedPrompts = starterPrompts
        .map(p => ({
          title: trimLocalized(p?.title),
          message: trimLocalized(p?.message)
        }))
        .filter(p => Object.keys(p.title).length > 0 && Object.keys(p.message).length > 0);

      await makeAdminApiCall('/admin/office-integration/config', {
        method: 'PUT',
        body: {
          displayName: trimLocalized(displayName),
          description: trimLocalized(description),
          starterPrompts: cleanedPrompts,
          useLocalOfficejs,
          startPage: {
            defaultPage: startPage.defaultPage,
            // '' means "automatic"; the server stores no id for it.
            defaultAppId: startPage.defaultAppId || '',
            featuredAppIds: startPage.featuredAppIds
          }
        }
      });
      await loadStatus();
      setMessage({
        type: 'success',
        text: t('admin.officeIntegration.saved', 'Configuration saved')
      });
      setTimeout(() => setMessage(null), 3000);
    } catch (_err) {
      setMessage({
        type: 'error',
        text: t('admin.officeIntegration.saveError', 'Failed to save configuration')
      });
    } finally {
      setSaving(false);
    }
  };

  const handlePromptChange = (index, field, value) => {
    setStarterPrompts(prev => {
      const next = [...prev];
      const current = next[index] || emptyPrompt();
      next[index] = {
        ...current,
        [field]: value
      };
      return next;
    });
  };

  const handleAddPrompt = () => {
    setStarterPrompts(prev => [...prev, emptyPrompt()]);
  };

  const handleRemovePrompt = index => {
    setStarterPrompts(prev => prev.filter((_, i) => i !== index));
  };

  const handleMovePrompt = (index, direction) => {
    setStarterPrompts(prev => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const selectClass =
    'block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 dark:text-gray-100 px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed';
  const labelClass = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';
  const helpClass = 'mt-2 text-xs text-gray-500 dark:text-gray-400';

  const manifestUrl = status?.manifestUrl || buildApiUrl('integrations/office-addin/manifest.xml');
  const manifestApiPath = buildApiUrl('integrations/office-addin/manifest.xml');

  const handleDownloadManifest = async () => {
    try {
      const res = await fetch(manifestApiPath);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'manifest.xml';
      a.click();
      URL.revokeObjectURL(url);
    } catch (_err) {
      setMessage({
        type: 'error',
        text: t('admin.officeIntegration.downloadError', 'Failed to download manifest')
      });
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 shadow-xs border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
            {t('admin.officeIntegration.title', 'Office Integration')}
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mt-2">
            {t(
              'admin.officeIntegration.description',
              'Configure the Outlook add-in and manage manifest deployment'
            )}
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        {message && (
          <div
            className={`rounded-lg px-4 py-3 text-sm ${
              message.type === 'error'
                ? 'bg-red-50 text-red-700 border border-red-200 dark:bg-red-900/20 dark:text-red-400'
                : 'bg-green-50 text-green-700 border border-green-200 dark:bg-green-900/20 dark:text-green-400'
            }`}
          >
            {message.text}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-8 h-8 border-4 border-gray-200 border-t-indigo-600 rounded-full animate-spin" />
          </div>
        ) : (
          <>
            {/* Enable / Disable */}
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xs border border-gray-200 dark:border-gray-700 p-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    {t('admin.officeIntegration.statusTitle', 'Integration Status')}
                  </h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    {status?.enabled
                      ? t(
                          'admin.officeIntegration.statusEnabled',
                          'The Outlook add-in is enabled and available to users.'
                        )
                      : t(
                          'admin.officeIntegration.statusDisabled',
                          'Enable to auto-create an OAuth client and activate the add-in.'
                        )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleToggle}
                  disabled={toggling}
                  className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-60 ${
                    status?.enabled
                      ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400'
                      : 'bg-indigo-600 text-white hover:bg-indigo-700'
                  }`}
                >
                  {toggling
                    ? '…'
                    : status?.enabled
                      ? t('admin.officeIntegration.disable', 'Disable')
                      : t('admin.officeIntegration.enable', 'Enable')}
                </button>
              </div>

              {status?.enabled && status?.oauthClientId && (
                <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700 text-sm text-gray-600 dark:text-gray-400">
                  <span className="font-medium text-gray-700 dark:text-gray-300">
                    OAuth Client ID:
                  </span>{' '}
                  <code className="font-mono text-xs bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded-sm">
                    {status.oauthClientId}
                  </code>
                  {' — '}
                  <Link
                    to={`/admin/oauth/clients/${status.oauthClientId}`}
                    className="text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    {t('admin.officeIntegration.viewClient', 'View OAuth Client')}
                  </Link>
                </div>
              )}
            </div>

            {/* Manifest */}
            {status?.enabled && (
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xs border border-gray-200 dark:border-gray-700 p-6">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                  {t('admin.officeIntegration.manifestTitle', 'Office Manifest')}
                </h2>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                  {t(
                    'admin.officeIntegration.manifestDesc',
                    'Deploy this manifest in Microsoft 365 Admin Center to make the add-in available to your organization.'
                  )}
                </p>
                <div className="flex items-center gap-3">
                  <input
                    type="text"
                    readOnly
                    value={manifestUrl}
                    className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 px-3 py-2 text-sm font-mono text-gray-700 dark:text-gray-300 focus:outline-hidden"
                    onClick={e => e.target.select()}
                  />
                  <button
                    type="button"
                    onClick={() => navigator.clipboard?.writeText(manifestUrl)}
                    className="shrink-0 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                  >
                    {t('admin.officeIntegration.copy', 'Copy')}
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadManifest}
                    className="shrink-0 rounded-lg bg-indigo-600 text-white px-3 py-2 text-sm font-medium hover:bg-indigo-700"
                  >
                    {t('admin.officeIntegration.download', 'Download')}
                  </button>
                </div>
              </div>
            )}

            {/* Display Settings */}
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xs border border-gray-200 dark:border-gray-700 p-6">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                {t('admin.officeIntegration.displayTitle', 'Display Settings')}
              </h2>
              <div className="space-y-4">
                <DynamicLanguageEditor
                  label={t('admin.officeIntegration.displayName', 'Display Name')}
                  value={displayName}
                  onChange={setDisplayName}
                  type="text"
                />
                <DynamicLanguageEditor
                  label={t('admin.officeIntegration.description', 'Description')}
                  value={description}
                  onChange={setDescription}
                  type="textarea"
                />
              </div>
            </div>

            {/* Offline / Local Office.js */}
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xs border border-gray-200 dark:border-gray-700 p-6">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
                {t('admin.officeIntegration.offlineTitle', 'Offline Mode (Local Office.js)')}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                {t(
                  'admin.officeIntegration.offlineDesc',
                  'Enable this if your environment blocks access to appsforoffice.microsoft.com. The add-in will then load the Office JavaScript library from this server instead of the Microsoft CDN.'
                )}
              </p>
              <label className="flex items-center gap-3 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useLocalOfficejs}
                  onChange={e => setUseLocalOfficejs(e.target.checked)}
                  className="h-4 w-4 rounded-sm border-gray-300 text-indigo-600 focus:ring-indigo-500"
                />
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t(
                    'admin.officeIntegration.offlineLabel',
                    'Serve Office.js from this server (offline mode)'
                  )}
                </span>
              </label>
              {useLocalOfficejs && (
                <div className="mt-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
                  {t(
                    'admin.officeIntegration.offlineWarning',
                    'Offline mode is active. The add-in will load Office.js from /office/office-js/office.js on this server. Note: Microsoft AppSource will reject add-ins that do not use the official CDN URL — this mode is intended for internal enterprise deployments only.'
                  )}
                </div>
              )}
            </div>

            {/* Start page: the pane's landing view */}
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xs border border-gray-200 dark:border-gray-700 p-6">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
                {t('admin.officeIntegration.startPageTitle', 'Start Page')}
              </h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                {t(
                  'admin.officeIntegration.startPageDesc',
                  'What the task pane shows after sign-in — and which app answers there. Messages typed on the start page open that app and are sent right away, with the open email and any collected emails as context.'
                )}
              </p>

              <div className="max-w-lg space-y-5">
                <div>
                  <label htmlFor="office-startPage-defaultPage" className={labelClass}>
                    {t('admin.officeIntegration.defaultPage', 'Landing view')}
                  </label>
                  <select
                    id="office-startPage-defaultPage"
                    value={startPage.defaultPage}
                    onChange={e => updateStartPage({ defaultPage: e.target.value })}
                    className={selectClass}
                  >
                    <option value="start">
                      {t(
                        'admin.officeIntegration.defaultPageStart',
                        'Start page (greeting, chat input and app shortcuts)'
                      )}
                    </option>
                    <option value="apps">
                      {t('admin.officeIntegration.defaultPageApps', 'All apps (the app list)')}
                    </option>
                  </select>
                  <p className={helpClass}>
                    {t(
                      'admin.officeIntegration.defaultPageHelp',
                      'Where the pane lands after sign-in and where the back button in a chat leads. The app list stays one tap away from the start page either way.'
                    )}
                  </p>
                </div>

                <div>
                  <label htmlFor="office-startPage-defaultAppId" className={labelClass}>
                    {t('admin.officeIntegration.defaultApp', 'Default chat app')}
                  </label>
                  <select
                    id="office-startPage-defaultAppId"
                    value={startPage.defaultAppId}
                    disabled={appsLoading || startPage.defaultPage !== 'start'}
                    onChange={e => updateStartPage({ defaultAppId: e.target.value })}
                    className={selectClass}
                  >
                    <option value="">
                      {t(
                        'admin.officeIntegration.defaultAppAutomatic',
                        'First available app (automatic)'
                      )}
                    </option>
                    {chatApps.map(app => (
                      <option key={app.id} value={app.id}>
                        {appLabel(app)}
                      </option>
                    ))}
                    {/* Keep a stored id visible even if the app no longer exists. */}
                    {!appsLoading &&
                      startPage.defaultAppId &&
                      !chatApps.some(app => app.id === startPage.defaultAppId) && (
                        <option value={startPage.defaultAppId}>
                          {startPage.defaultAppId} (
                          {t('admin.officeIntegration.unknownApp', 'not found')})
                        </option>
                      )}
                  </select>
                  <p className={helpClass}>
                    {t(
                      'admin.officeIntegration.defaultAppHelp',
                      'The app whose chat input the start page shows. When unset — or when a user cannot access it — the top-ranked chat app that user can access is used: favorites first, then the default apps below.'
                    )}
                  </p>
                </div>

                <div>
                  <span className={labelClass}>
                    {t('admin.officeIntegration.featuredApps', 'Default apps')}
                  </span>
                  {featuredItems.length === 0 ? (
                    <p className="rounded-md border border-dashed border-gray-300 dark:border-gray-600 px-3 py-4 text-xs text-gray-500 dark:text-gray-400">
                      {t(
                        'admin.officeIntegration.featuredAppsEmpty',
                        'No default apps yet — the start page lists apps in their configured order, favorites first.'
                      )}
                    </p>
                  ) : (
                    <ReorderableList
                      items={featuredItems}
                      onReorder={items =>
                        updateStartPage({ featuredAppIds: items.map(item => item.id) })
                      }
                      getKey={item => item.id}
                      getLabel={featuredLabel}
                      renderItem={(item, index) => (
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="w-5 shrink-0 text-xs font-semibold text-gray-400 dark:text-gray-500">
                            {index + 1}.
                          </span>
                          {item.app && (
                            <span
                              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-white"
                              style={{ backgroundColor: item.app.color || '#4f46e5' }}
                            >
                              <Icon name={item.app.icon} size="sm" className="h-3.5 w-3.5" />
                            </span>
                          )}
                          <span className="min-w-0 flex-1 truncate text-sm text-gray-900 dark:text-gray-100">
                            {featuredLabel(item)}
                            {!item.app && !appsLoading && (
                              <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">
                                ({t('admin.officeIntegration.unknownApp', 'not found')})
                              </span>
                            )}
                            {item.app?.enabled === false && (
                              <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">
                                ({t('admin.officeIntegration.disabledApp', 'disabled')})
                              </span>
                            )}
                          </span>
                        </span>
                      )}
                      renderActions={item => (
                        <button
                          type="button"
                          onClick={() => removeFeaturedApp(item.id)}
                          aria-label={t(
                            'admin.officeIntegration.removeFeaturedApp',
                            'Remove {{name}}',
                            {
                              name: featuredLabel(item)
                            }
                          )}
                          title={t('admin.officeIntegration.removeFeaturedApp', 'Remove {{name}}', {
                            name: featuredLabel(item)
                          })}
                          className="rounded-md p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30"
                        >
                          <Icon name="trash" size="sm" />
                        </button>
                      )}
                    />
                  )}
                  <select
                    id="office-startPage-addFeaturedApp"
                    value=""
                    disabled={appsLoading || addableApps.length === 0}
                    onChange={e => addFeaturedApp(e.target.value)}
                    aria-label={t('admin.officeIntegration.addFeaturedApp', 'Add a default app')}
                    className={`${selectClass} mt-2`}
                  >
                    <option value="">
                      {t('admin.officeIntegration.addFeaturedApp', 'Add a default app')}
                    </option>
                    {addableApps.map(app => (
                      <option key={app.id} value={app.id}>
                        {appLabel(app)}
                      </option>
                    ))}
                  </select>
                  <p className={helpClass}>
                    {t(
                      'admin.officeIntegration.featuredAppsHelp',
                      "Shown on the start page in this order, right after each user's favorites. Users who cannot access an app never see it. Drag a row or use the arrows to reorder."
                    )}
                  </p>
                </div>
              </div>
            </div>

            {/* Starter Prompts */}
            <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xs border border-gray-200 dark:border-gray-700 p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    {t('admin.officeIntegration.starterPromptsTitle', 'Default Starter Prompts')}
                  </h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    {t(
                      'admin.officeIntegration.starterPromptsDesc',
                      'These prompts are shown in the Outlook add-in when the selected app has no starter prompts defined. Clicking a prompt will send it immediately.'
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleAddPrompt}
                  className="shrink-0 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  {t('admin.officeIntegration.addPrompt', 'Add prompt')}
                </button>
              </div>

              {starterPrompts.length === 0 ? (
                <p className="mt-4 text-sm text-gray-500 dark:text-gray-400 italic">
                  {t(
                    'admin.officeIntegration.noPrompts',
                    'No default starter prompts configured. Add one to show suggestions in Outlook.'
                  )}
                </p>
              ) : (
                <div className="mt-4 space-y-4">
                  {starterPrompts.map((prompt, index) => (
                    <div
                      key={prompt._id}
                      className="rounded-lg border border-gray-200 dark:border-gray-700 p-4 bg-gray-50/60 dark:bg-gray-900/40"
                    >
                      <div className="flex items-center justify-between mb-3">
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                          {t('admin.officeIntegration.promptIndex', 'Prompt #{{n}}', {
                            n: index + 1
                          })}
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleMovePrompt(index, -1)}
                            disabled={index === 0}
                            className="rounded-sm px-2 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40 disabled:hover:bg-transparent"
                            aria-label={t('admin.officeIntegration.moveUp', 'Move up')}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            onClick={() => handleMovePrompt(index, 1)}
                            disabled={index === starterPrompts.length - 1}
                            className="rounded-sm px-2 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40 disabled:hover:bg-transparent"
                            aria-label={t('admin.officeIntegration.moveDown', 'Move down')}
                          >
                            ↓
                          </button>
                          <button
                            type="button"
                            onClick={() => handleRemovePrompt(index)}
                            className="rounded-sm px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
                          >
                            {t('admin.officeIntegration.remove', 'Remove')}
                          </button>
                        </div>
                      </div>
                      <div className="space-y-3">
                        <DynamicLanguageEditor
                          label={t('admin.officeIntegration.promptTitle', 'Title')}
                          value={prompt?.title || {}}
                          onChange={value => handlePromptChange(index, 'title', value)}
                          type="text"
                        />
                        <DynamicLanguageEditor
                          label={t('admin.officeIntegration.promptMessage', 'Message')}
                          value={prompt?.message || {}}
                          onChange={value => handlePromptChange(index, 'message', value)}
                          type="textarea"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-6 flex justify-end">
                <button
                  type="button"
                  onClick={handleSaveConfig}
                  disabled={saving}
                  className="rounded-lg bg-indigo-600 text-white px-4 py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-60"
                >
                  {saving ? '…' : t('admin.officeIntegration.save', 'Save')}
                </button>
              </div>
            </div>

            {/* Setup Instructions */}
            {status?.enabled && (
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800 p-6">
                <h2 className="text-base font-semibold text-blue-900 dark:text-blue-300 mb-3">
                  {t('admin.officeIntegration.setupTitle', 'Deployment Instructions')}
                </h2>
                <ol className="text-sm text-blue-800 dark:text-blue-300 space-y-1.5 list-decimal list-inside">
                  <li>
                    {t(
                      'admin.officeIntegration.step1',
                      'Copy the manifest URL above or download the manifest.xml file.'
                    )}
                  </li>
                  <li>
                    {t(
                      'admin.officeIntegration.step2',
                      'Go to Microsoft 365 Admin Center → Settings → Integrated apps.'
                    )}
                  </li>
                  <li>
                    {t(
                      'admin.officeIntegration.step3',
                      "Choose 'Upload custom apps' and paste the manifest URL or upload the file."
                    )}
                  </li>
                  <li>
                    {t(
                      'admin.officeIntegration.step4',
                      'Assign the add-in to users or the entire organization.'
                    )}
                  </li>
                  <li>
                    {t(
                      'admin.officeIntegration.step5',
                      'Users will find the add-in in Outlook under Get Add-ins or My Add-ins.'
                    )}
                  </li>
                </ol>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default AdminOfficeIntegrationPage;
