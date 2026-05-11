import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import { makeAdminApiCall } from '../../../api/adminApi';
import { buildApiUrl } from '../../../utils/runtimeBasePath';

function AdminNextcloudEmbedPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [message, setMessage] = useState(null);
  const [status, setStatus] = useState(null);

  const [displayName, setDisplayName] = useState({});
  const [description, setDescription] = useState({});
  const [starterPrompts, setStarterPrompts] = useState([]);
  const [allowedHostOrigins, setAllowedHostOrigins] = useState([]);
  const [newOrigin, setNewOrigin] = useState('');

  const emptyPrompt = () => ({
    _id: crypto.randomUUID(),
    title: {},
    message: {}
  });

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
      const res = await makeAdminApiCall('/admin/nextcloud-embed/status', { method: 'GET' });
      const data = res.data;
      setStatus(data);
      setDisplayName(sanitizeLocalized(data.displayName));
      setDescription(sanitizeLocalized(data.description));
      setStarterPrompts(
        Array.isArray(data.starterPrompts)
          ? data.starterPrompts.map(p => ({
              _id: crypto.randomUUID(),
              title: sanitizeLocalized(p?.title),
              message: sanitizeLocalized(p?.message)
            }))
          : []
      );
      setAllowedHostOrigins(
        Array.isArray(data.allowedHostOrigins) ? data.allowedHostOrigins.slice() : []
      );
    } catch (_err) {
      setMessage({
        type: 'error',
        text: t('admin.nextcloudEmbed.loadError', 'Failed to load Nextcloud embed status')
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadStatus();
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  const handleToggle = async () => {
    if (!status) return;
    const action = status.enabled ? 'disable' : 'enable';
    try {
      setToggling(true);
      setMessage(null);
      await makeAdminApiCall(`/admin/nextcloud-embed/${action}`, { method: 'POST' });
      await loadStatus();
      setMessage({
        type: 'success',
        text: status.enabled
          ? t('admin.nextcloudEmbed.disabled', 'Nextcloud embed disabled')
          : t(
              'admin.nextcloudEmbed.enabled',
              'Nextcloud embed enabled successfully. OAuth client has been created.'
            )
      });
    } catch (_err) {
      setMessage({
        type: 'error',
        text: t('admin.nextcloudEmbed.toggleError', 'Failed to update Nextcloud embed')
      });
    } finally {
      setToggling(false);
    }
  };

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

  // Validate origins client-side so the admin sees errors before saving.
  // Mirror the server's `canonicalizeOrigin` rules.
  const canonicalizeOrigin = raw => {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
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
  };

  const handleAddOrigin = () => {
    const canonical = canonicalizeOrigin(newOrigin);
    if (!canonical) {
      setMessage({
        type: 'error',
        text: t(
          'admin.nextcloudEmbed.originInvalid',
          'Enter a valid http(s) origin like https://cloud.example.com'
        )
      });
      return;
    }
    if (allowedHostOrigins.includes(canonical)) {
      setNewOrigin('');
      return;
    }
    setAllowedHostOrigins(prev => [...prev, canonical]);
    setNewOrigin('');
    setMessage(null);
  };

  const handleRemoveOrigin = origin => {
    setAllowedHostOrigins(prev => prev.filter(o => o !== origin));
  };

  const handleSaveConfig = async () => {
    try {
      setSaving(true);
      setMessage(null);

      const cleanedPrompts = starterPrompts
        .map(p => ({
          title: trimLocalized(p?.title),
          message: trimLocalized(p?.message)
        }))
        .filter(p => Object.keys(p.title).length > 0 && Object.keys(p.message).length > 0);

      await makeAdminApiCall('/admin/nextcloud-embed/config', {
        method: 'PUT',
        data: {
          displayName: trimLocalized(displayName),
          description: trimLocalized(description),
          starterPrompts: cleanedPrompts,
          allowedHostOrigins
        }
      });
      await loadStatus();
      setMessage({ type: 'success', text: t('admin.nextcloudEmbed.saved', 'Configuration saved') });
      setTimeout(() => setMessage(null), 3000);
    } catch (_err) {
      setMessage({
        type: 'error',
        text: t('admin.nextcloudEmbed.saveError', 'Failed to save configuration')
      });
    } finally {
      setSaving(false);
    }
  };

  const handlePromptChange = (index, field, value) => {
    setStarterPrompts(prev => {
      const next = [...prev];
      const current = next[index] || emptyPrompt();
      next[index] = { ...current, [field]: value };
      return next;
    });
  };

  const handleAddPrompt = () => setStarterPrompts(prev => [...prev, emptyPrompt()]);
  const handleRemovePrompt = index => setStarterPrompts(prev => prev.filter((_, i) => i !== index));
  const handleMovePrompt = (index, direction) => {
    setStarterPrompts(prev => {
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const infoXmlUrl = status?.infoXmlUrl || buildApiUrl('integrations/nextcloud-embed/info.xml');
  const embedUrl = status?.embedUrl || '';
  const infoXmlApiPath = buildApiUrl('integrations/nextcloud-embed/info.xml');

  const handleDownloadInfoXml = async () => {
    try {
      const res = await fetch(infoXmlApiPath);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'info.xml';
      a.click();
      URL.revokeObjectURL(url);
    } catch (_err) {
      setMessage({
        type: 'error',
        text: t('admin.nextcloudEmbed.downloadError', 'Failed to download info.xml')
      });
    }
  };

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <Link
              to="/admin/integrations"
              className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              ← {t('admin.integrations.backToIntegrations', 'Back to Integrations')}
            </Link>
            <h1 className="mt-2 text-3xl font-bold text-gray-900 dark:text-gray-100">
              {t('admin.nextcloudEmbed.title', 'Nextcloud Embed')}
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mt-2">
              {t(
                'admin.nextcloudEmbed.description',
                'Configure the embedded iHub experience that opens inside Nextcloud when a user picks a document and starts a chat.'
              )}
            </p>
          </div>
        </div>

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
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                      {t('admin.nextcloudEmbed.statusTitle', 'Integration Status')}
                    </h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                      {status?.enabled
                        ? t(
                            'admin.nextcloudEmbed.statusEnabled',
                            'The Nextcloud embed is enabled. Add a Nextcloud origin below to allow it to iframe iHub.'
                          )
                        : t(
                            'admin.nextcloudEmbed.statusDisabled',
                            'Enable to auto-create an OAuth client and activate the embedded UI.'
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
                        ? t('admin.nextcloudEmbed.disable', 'Disable')
                        : t('admin.nextcloudEmbed.enable', 'Enable')}
                  </button>
                </div>

                {status?.enabled && status?.oauthClientId && (
                  <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700 text-sm text-gray-600 dark:text-gray-400">
                    <span className="font-medium text-gray-700 dark:text-gray-300">
                      OAuth Client ID:
                    </span>{' '}
                    <code className="font-mono text-xs bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded">
                      {status.oauthClientId}
                    </code>
                    {' — '}
                    <Link
                      to={`/admin/oauth/clients/${status.oauthClientId}`}
                      className="text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      {t('admin.nextcloudEmbed.viewClient', 'View OAuth Client')}
                    </Link>
                  </div>
                )}
              </div>

              {/* Embed URL + info.xml */}
              {status?.enabled && (
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6 space-y-6">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
                      {t('admin.nextcloudEmbed.embedUrlTitle', 'Embed URL')}
                    </h2>
                    <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                      {t(
                        'admin.nextcloudEmbed.embedUrlDesc',
                        'Use this URL as the iframe src inside your Nextcloud app. Pass the file selection in the URL hash (see docs).'
                      )}
                    </p>
                    <div className="flex items-center gap-3">
                      <input
                        type="text"
                        readOnly
                        value={embedUrl}
                        className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 px-3 py-2 text-sm font-mono text-gray-700 dark:text-gray-300 focus:outline-none"
                        onClick={e => e.target.select()}
                      />
                      <button
                        type="button"
                        onClick={() => navigator.clipboard?.writeText(embedUrl)}
                        className="shrink-0 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                      >
                        {t('admin.nextcloudEmbed.copy', 'Copy')}
                      </button>
                    </div>
                  </div>

                  <div className="border-t border-gray-100 dark:border-gray-700 pt-6">
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
                      {t('admin.nextcloudEmbed.infoXmlTitle', 'Nextcloud appinfo/info.xml')}
                    </h2>
                    <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                      {t(
                        'admin.nextcloudEmbed.infoXmlDesc',
                        'Drop this into your Nextcloud app under appinfo/info.xml. URLs are pinned to this deployment.'
                      )}
                    </p>
                    <div className="flex items-center gap-3">
                      <input
                        type="text"
                        readOnly
                        value={infoXmlUrl}
                        className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 px-3 py-2 text-sm font-mono text-gray-700 dark:text-gray-300 focus:outline-none"
                        onClick={e => e.target.select()}
                      />
                      <button
                        type="button"
                        onClick={() => navigator.clipboard?.writeText(infoXmlUrl)}
                        className="shrink-0 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                      >
                        {t('admin.nextcloudEmbed.copy', 'Copy')}
                      </button>
                      <button
                        type="button"
                        onClick={handleDownloadInfoXml}
                        className="shrink-0 rounded-lg bg-indigo-600 text-white px-3 py-2 text-sm font-medium hover:bg-indigo-700"
                      >
                        {t('admin.nextcloudEmbed.download', 'Download')}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* Allowed Host Origins */}
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
                  {t('admin.nextcloudEmbed.originsTitle', 'Allowed Nextcloud Origins')}
                </h2>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                  {t(
                    'admin.nextcloudEmbed.originsDesc',
                    'Only these Nextcloud origins may iframe iHub or postMessage selections to it. Used for both CSP frame-ancestors and the postMessage origin check.'
                  )}
                </p>
                <div className="flex items-center gap-3 mb-4">
                  <input
                    type="url"
                    value={newOrigin}
                    onChange={e => setNewOrigin(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddOrigin();
                      }
                    }}
                    placeholder="https://cloud.example.com"
                    className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                  <button
                    type="button"
                    onClick={handleAddOrigin}
                    className="shrink-0 rounded-lg bg-indigo-600 text-white px-3 py-2 text-sm font-medium hover:bg-indigo-700"
                  >
                    {t('admin.nextcloudEmbed.addOrigin', 'Add')}
                  </button>
                </div>
                {allowedHostOrigins.length === 0 ? (
                  <p className="text-sm text-gray-500 dark:text-gray-400 italic">
                    {t(
                      'admin.nextcloudEmbed.noOrigins',
                      'No origins added yet. iframing iHub from a Nextcloud instance will be blocked until you add its origin here.'
                    )}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {allowedHostOrigins.map(origin => (
                      <li
                        key={origin}
                        className="flex items-center justify-between rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 bg-gray-50/60 dark:bg-gray-900/40"
                      >
                        <code className="text-sm font-mono text-gray-800 dark:text-gray-200 break-all">
                          {origin}
                        </code>
                        <button
                          type="button"
                          onClick={() => handleRemoveOrigin(origin)}
                          className="shrink-0 rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
                        >
                          {t('admin.nextcloudEmbed.remove', 'Remove')}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Display Settings */}
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                  {t('admin.nextcloudEmbed.displayTitle', 'Display Settings')}
                </h2>
                <div className="space-y-4">
                  <DynamicLanguageEditor
                    label={t('admin.nextcloudEmbed.displayName', 'Display Name')}
                    value={displayName}
                    onChange={setDisplayName}
                    type="text"
                  />
                  <DynamicLanguageEditor
                    label={t('admin.nextcloudEmbed.descriptionField', 'Description')}
                    value={description}
                    onChange={setDescription}
                    type="textarea"
                  />
                </div>
              </div>

              {/* Starter Prompts */}
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                      {t('admin.nextcloudEmbed.starterPromptsTitle', 'Default Starter Prompts')}
                    </h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                      {t(
                        'admin.nextcloudEmbed.starterPromptsDesc',
                        'Shown in the embed when the selected app has no starter prompts of its own. Clicking a prompt sends it immediately against the current selection.'
                      )}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleAddPrompt}
                    className="shrink-0 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                  >
                    {t('admin.nextcloudEmbed.addPrompt', 'Add prompt')}
                  </button>
                </div>

                {starterPrompts.length === 0 ? (
                  <p className="mt-4 text-sm text-gray-500 dark:text-gray-400 italic">
                    {t(
                      'admin.nextcloudEmbed.noPrompts',
                      'No default starter prompts configured. Add one to show suggestions in the embed.'
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
                            {t('admin.nextcloudEmbed.promptIndex', 'Prompt #{{n}}', {
                              n: index + 1
                            })}
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => handleMovePrompt(index, -1)}
                              disabled={index === 0}
                              className="rounded px-2 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40 disabled:hover:bg-transparent"
                              aria-label={t('admin.nextcloudEmbed.moveUp', 'Move up')}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              onClick={() => handleMovePrompt(index, 1)}
                              disabled={index === starterPrompts.length - 1}
                              className="rounded px-2 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40 disabled:hover:bg-transparent"
                              aria-label={t('admin.nextcloudEmbed.moveDown', 'Move down')}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemovePrompt(index)}
                              className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
                            >
                              {t('admin.nextcloudEmbed.remove', 'Remove')}
                            </button>
                          </div>
                        </div>
                        <div className="space-y-3">
                          <DynamicLanguageEditor
                            label={t('admin.nextcloudEmbed.promptTitle', 'Title')}
                            value={prompt?.title || {}}
                            onChange={value => handlePromptChange(index, 'title', value)}
                            type="text"
                          />
                          <DynamicLanguageEditor
                            label={t('admin.nextcloudEmbed.promptMessage', 'Message')}
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
                    {saving ? '…' : t('admin.nextcloudEmbed.save', 'Save')}
                  </button>
                </div>
              </div>

              {status?.enabled && (
                <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800 p-6">
                  <h2 className="text-base font-semibold text-blue-900 dark:text-blue-300 mb-3">
                    {t('admin.nextcloudEmbed.setupTitle', 'Deployment Instructions')}
                  </h2>
                  <ol className="text-sm text-blue-800 dark:text-blue-300 space-y-1.5 list-decimal list-inside">
                    <li>
                      {t(
                        'admin.nextcloudEmbed.step1',
                        'Configure a Nextcloud cloud-storage provider under Admin → Integrations → Nextcloud (this powers the OAuth + WebDAV flow).'
                      )}
                    </li>
                    <li>
                      {t(
                        'admin.nextcloudEmbed.step2',
                        'Add your Nextcloud origin (e.g. https://cloud.example.com) above so the embed page accepts iframe and postMessage from it.'
                      )}
                    </li>
                    <li>
                      {t(
                        'admin.nextcloudEmbed.step3',
                        'Build & install the bundled Nextcloud app skeleton (see nextcloud-app/README.md in the iHub repo).'
                      )}
                    </li>
                    <li>
                      {t(
                        'admin.nextcloudEmbed.step4',
                        'Users right-click any file in Nextcloud Files → "Chat with iHub" — the embed opens with the documents pre-attached.'
                      )}
                    </li>
                  </ol>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </AdminAuth>
  );
}

export default AdminNextcloudEmbedPage;
