import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import ResourceSelector from '../components/ResourceSelector';
import { makeAdminApiCall } from '../../../api/adminApi';

function AdminBrowserExtensionPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [message, setMessage] = useState(null);
  const [status, setStatus] = useState(null);

  const [displayName, setDisplayName] = useState({});
  const [description, setDescription] = useState({});
  const [starterPrompts, setStarterPrompts] = useState([]);
  const [extensionIdsText, setExtensionIdsText] = useState('');
  const [allowedGroups, setAllowedGroups] = useState(['browser-extension']);
  const [availableGroups, setAvailableGroups] = useState([]);

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
      const res = await makeAdminApiCall('/admin/browser-extension/status', { method: 'GET' });
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
      setExtensionIdsText(Array.isArray(data.extensionIds) ? data.extensionIds.join('\n') : '');
      setAllowedGroups(
        Array.isArray(data.allowedGroups) && data.allowedGroups.length > 0
          ? data.allowedGroups
          : ['browser-extension']
      );
    } catch (_err) {
      setMessage({
        type: 'error',
        text: t('admin.browserExtension.loadError', 'Failed to load Browser Extension status')
      });
    } finally {
      setLoading(false);
    }
  };

  const loadGroups = async () => {
    try {
      const res = await makeAdminApiCall('/admin/groups');
      const groupsObj = res?.data?.groups || {};
      // Convert { id: groupObj } -> [{ id, name }] for ResourceSelector
      const list = Object.values(groupsObj).map(g => ({
        id: g.id,
        name: g.name || g.id,
        description: g.description
      }));
      list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      setAvailableGroups(list);
    } catch {
      // Non-fatal — admin can still type the group ID via the search field;
      // ResourceSelector will simply have an empty dropdown.
    }
  };

  useEffect(() => {
    loadStatus();
    loadGroups();
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  const handleToggle = async () => {
    if (!status) return;
    const action = status.enabled ? 'disable' : 'enable';
    try {
      setToggling(true);
      setMessage(null);
      await makeAdminApiCall(`/admin/browser-extension/${action}`, { method: 'POST' });
      await loadStatus();
      setMessage({
        type: 'success',
        text: status.enabled
          ? t('admin.browserExtension.disabled', 'Browser Extension integration disabled')
          : t(
              'admin.browserExtension.enabled',
              'Browser Extension integration enabled successfully. OAuth client has been created.'
            )
      });
    } catch (_err) {
      setMessage({
        type: 'error',
        text: t(
          'admin.browserExtension.toggleError',
          'Failed to update Browser Extension integration'
        )
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

  const downloadPackage = async format => {
    const path = `/admin/browser-extension/download.${format}`;
    setMessage(null);
    try {
      const response = await makeAdminApiCall(path, { method: 'GET', responseType: 'blob' });
      const blob = response.data;
      const contentDisposition = response.headers?.['content-disposition'] || '';
      const match = contentDisposition.match(/filename="(.+)"/);
      const filename = match ? match[1] : `ihub-extension.${format}`;
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      setMessage({
        type: 'error',
        text:
          t('admin.browserExtension.downloadError', 'Failed to download {{format}} package: ', {
            format: format.toUpperCase()
          }) + (err?.message || 'unknown error')
      });
    }
  };

  const handleRotateKey = async () => {
    if (
      !window.confirm(
        t(
          'admin.browserExtension.rotateKeyConfirm',
          'Generate a new signing key? The extension ID will change and existing installed copies will need to be reinstalled (or use the previous-ID grace window).'
        )
      )
    ) {
      return;
    }
    try {
      setMessage(null);
      await makeAdminApiCall('/admin/browser-extension/rotate-key', { method: 'POST' });
      await loadStatus();
      setMessage({
        type: 'success',
        text: t(
          'admin.browserExtension.rotateKeyOk',
          'Signing key rotated; new extension ID issued.'
        )
      });
    } catch (err) {
      setMessage({
        type: 'error',
        text:
          t('admin.browserExtension.rotateKeyError', 'Failed to rotate key: ') +
          (err?.message || 'unknown error')
      });
    }
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

      const extensionIds = extensionIdsText
        .split(/[\s,]+/)
        .map(s => s.trim())
        .filter(Boolean);

      // ResourceSelector emits ['*'] for "all"; the server treats that and
      // an empty array as "no group restriction".
      const cleanedAllowedGroups = Array.isArray(allowedGroups)
        ? Array.from(new Set(allowedGroups.filter(Boolean)))
        : [];

      await makeAdminApiCall('/admin/browser-extension/config', {
        method: 'PUT',
        data: {
          displayName: trimLocalized(displayName),
          description: trimLocalized(description),
          starterPrompts: cleanedPrompts,
          extensionIds,
          allowedGroups: cleanedAllowedGroups
        }
      });
      await loadStatus();
      setMessage({
        type: 'success',
        text: t('admin.browserExtension.saved', 'Configuration saved')
      });
      setTimeout(() => setMessage(null), 3000);
    } catch (_err) {
      setMessage({
        type: 'error',
        text: t('admin.browserExtension.saveError', 'Failed to save configuration')
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

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
              {t('admin.browserExtension.title', 'Browser Extension')}
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mt-2">
              {t(
                'admin.browserExtension.description',
                'Configure the iHub browser extension, its OAuth client, and which users can install it.'
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
              <div className="w-8 h-8 border-4 border-gray-200 border-t-emerald-600 rounded-full animate-spin" />
            </div>
          ) : (
            <>
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                      {t('admin.browserExtension.statusTitle', 'Integration Status')}
                    </h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                      {status?.enabled
                        ? t(
                            'admin.browserExtension.statusEnabled',
                            'The browser extension integration is enabled. Users can sign in via the extension.'
                          )
                        : t(
                            'admin.browserExtension.statusDisabled',
                            'Enable to auto-create the OAuth client and allow users to sign in from the extension.'
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
                        : 'bg-emerald-600 text-white hover:bg-emerald-700'
                    }`}
                  >
                    {toggling
                      ? '…'
                      : status?.enabled
                        ? t('admin.browserExtension.disable', 'Disable')
                        : t('admin.browserExtension.enable', 'Enable')}
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
                      className="text-emerald-600 hover:underline dark:text-emerald-400"
                    >
                      {t('admin.browserExtension.viewClient', 'View OAuth Client')}
                    </Link>
                  </div>
                )}

                {status?.enabled && status?.configUrl && (
                  <div className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700 text-sm text-gray-600 dark:text-gray-400">
                    <span className="font-medium text-gray-700 dark:text-gray-300">
                      {t('admin.browserExtension.configUrl', 'Runtime config URL')}:
                    </span>{' '}
                    <code className="font-mono text-xs bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded break-all">
                      {status.configUrl}
                    </code>
                  </div>
                )}
              </div>

              {status?.enabled && status?.signingKey?.extensionId && (
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                    {t('admin.browserExtension.packageTitle', 'Packaged Extension')}
                  </h2>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                    {t(
                      'admin.browserExtension.packageDesc',
                      'Download a customised extension build for this iHub deployment. The base URL, OAuth client ID and starter prompts are baked in, so end users just install and sign in — no setup required. The extension ID is fixed by the signing key, so the same package works for everyone.'
                    )}
                  </p>

                  <dl className="text-sm grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
                    <div>
                      <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                        {t('admin.browserExtension.extensionId', 'Extension ID')}
                      </dt>
                      <dd className="mt-1">
                        <code className="font-mono text-xs bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded break-all">
                          {status.signingKey.extensionId}
                        </code>
                      </dd>
                    </div>
                    {status.signingKey.previousExtensionId && (
                      <div>
                        <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                          {t('admin.browserExtension.previousExtensionId', 'Previous ID (grace)')}
                        </dt>
                        <dd className="mt-1">
                          <code className="font-mono text-xs bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded break-all">
                            {status.signingKey.previousExtensionId}
                          </code>
                        </dd>
                      </div>
                    )}
                    {status.signingKey.createdAt && (
                      <div>
                        <dt className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                          {t('admin.browserExtension.keyCreated', 'Key created')}
                        </dt>
                        <dd className="mt-1 text-gray-700 dark:text-gray-300">
                          {new Date(status.signingKey.createdAt).toLocaleString()}
                        </dd>
                      </div>
                    )}
                  </dl>

                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => downloadPackage('zip')}
                      className="rounded-lg bg-emerald-600 text-white px-4 py-2 text-sm font-medium hover:bg-emerald-700"
                    >
                      {t('admin.browserExtension.downloadZip', 'Download ZIP')}
                    </button>
                    <button
                      type="button"
                      onClick={() => downloadPackage('crx')}
                      className="rounded-lg bg-emerald-600 text-white px-4 py-2 text-sm font-medium hover:bg-emerald-700"
                    >
                      {t('admin.browserExtension.downloadCrx', 'Download CRX')}
                    </button>
                    <button
                      type="button"
                      onClick={handleRotateKey}
                      className="rounded-lg border border-red-300 dark:border-red-700 text-red-700 dark:text-red-400 px-4 py-2 text-sm font-medium hover:bg-red-50 dark:hover:bg-red-900/20"
                    >
                      {t('admin.browserExtension.rotateKey', 'Rotate signing key')}
                    </button>
                  </div>

                  <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">
                    {t(
                      'admin.browserExtension.packageHint',
                      'ZIP: unzip and "Load unpacked" in chrome://extensions, or distribute via enterprise policy. CRX: drag-and-drop install or enterprise policy. Rotate the key only when you need to invalidate every installed copy.'
                    )}
                  </p>
                </div>
              )}

              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                  {t(
                    'admin.browserExtension.idsTitle',
                    'Additional unpacked extension IDs (advanced)'
                  )}
                </h2>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                  {t(
                    'admin.browserExtension.idsDesc',
                    'Optional. The packaged-download flow above auto-registers a fixed extension ID — you only need this list for developers side-loading their own unpacked builds (each with a different Chrome-assigned ID). The redirect URIs https://<id>.chromiumapp.org/cb and https://<id>.extensions.allizom.org/cb are registered automatically for every entry.'
                  )}
                </p>
                <textarea
                  value={extensionIdsText}
                  onChange={e => setExtensionIdsText(e.target.value)}
                  rows={4}
                  placeholder="abcdefghijklmnopabcdefghijklmnop"
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 px-3 py-2 text-sm font-mono text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                  {t('admin.browserExtension.groupsTitle', 'Allowed Groups')}
                </h2>
                <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                  {t(
                    'admin.browserExtension.groupsDesc',
                    'Pick which internal groups can sign in via the extension. Defaults to the "browser-extension" group. Pick "All (*)" to skip the group check entirely. Users not in any allowed group see an access-denied page during sign-in.'
                  )}
                </p>
                <ResourceSelector
                  label={t('admin.browserExtension.groupsTitle', 'Allowed Groups')}
                  resources={availableGroups}
                  selectedResources={allowedGroups}
                  onSelectionChange={setAllowedGroups}
                  placeholder={t('admin.browserExtension.groupsSearch', 'Search groups to add...')}
                  emptyMessage={t(
                    'admin.browserExtension.groupsEmpty',
                    'No groups selected — sign-in is unrestricted (any authenticated user can use the extension)'
                  )}
                  allowWildcard={true}
                />
              </div>

              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                  {t('admin.browserExtension.displayTitle', 'Display Settings')}
                </h2>
                <div className="space-y-4">
                  <DynamicLanguageEditor
                    label={t('admin.browserExtension.displayName', 'Display Name')}
                    value={displayName}
                    onChange={setDisplayName}
                    type="text"
                  />
                  <DynamicLanguageEditor
                    label={t('admin.browserExtension.descriptionLabel', 'Description')}
                    value={description}
                    onChange={setDescription}
                    type="textarea"
                  />
                </div>
              </div>

              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                      {t('admin.browserExtension.starterPromptsTitle', 'Default Starter Prompts')}
                    </h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                      {t(
                        'admin.browserExtension.starterPromptsDesc',
                        'Prompts shown in the extension side panel when the selected app has no starter prompts of its own.'
                      )}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={handleAddPrompt}
                    className="shrink-0 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                  >
                    {t('admin.browserExtension.addPrompt', 'Add prompt')}
                  </button>
                </div>

                {starterPrompts.length === 0 ? (
                  <p className="mt-4 text-sm text-gray-500 dark:text-gray-400 italic">
                    {t(
                      'admin.browserExtension.noPrompts',
                      'No default starter prompts configured.'
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
                            {t('admin.browserExtension.promptIndex', 'Prompt #{{n}}', {
                              n: index + 1
                            })}
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => handleMovePrompt(index, -1)}
                              disabled={index === 0}
                              className="rounded px-2 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40 disabled:hover:bg-transparent"
                              aria-label={t('admin.browserExtension.moveUp', 'Move up')}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              onClick={() => handleMovePrompt(index, 1)}
                              disabled={index === starterPrompts.length - 1}
                              className="rounded px-2 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40 disabled:hover:bg-transparent"
                              aria-label={t('admin.browserExtension.moveDown', 'Move down')}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemovePrompt(index)}
                              className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
                            >
                              {t('admin.browserExtension.remove', 'Remove')}
                            </button>
                          </div>
                        </div>
                        <div className="space-y-3">
                          <DynamicLanguageEditor
                            label={t('admin.browserExtension.promptTitle', 'Title')}
                            value={prompt?.title || {}}
                            onChange={value => handlePromptChange(index, 'title', value)}
                            type="text"
                          />
                          <DynamicLanguageEditor
                            label={t('admin.browserExtension.promptMessage', 'Message')}
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
                    className="rounded-lg bg-emerald-600 text-white px-4 py-2 text-sm font-medium hover:bg-emerald-700 disabled:opacity-60"
                  >
                    {saving ? '…' : t('admin.browserExtension.save', 'Save')}
                  </button>
                </div>
              </div>

              {status?.enabled && (
                <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl border border-blue-200 dark:border-blue-800 p-6">
                  <h2 className="text-base font-semibold text-blue-900 dark:text-blue-300 mb-3">
                    {t('admin.browserExtension.setupTitle', 'Distribution Instructions')}
                  </h2>
                  <ol className="text-sm text-blue-800 dark:text-blue-300 space-y-1.5 list-decimal list-inside">
                    <li>
                      {t(
                        'admin.browserExtension.step1',
                        'Load the extension folder under /browser-extension into Chrome via chrome://extensions → Developer mode → Load unpacked, or package and distribute via the Chrome Web Store.'
                      )}
                    </li>
                    <li>
                      {t(
                        'admin.browserExtension.step2',
                        'Copy the extension ID Chrome assigns and add it to the "Extension IDs" list above; save.'
                      )}
                    </li>
                    <li>
                      {t(
                        'admin.browserExtension.step3',
                        'In the extension options page, point the extension at this iHub instance and sign in with PKCE.'
                      )}
                    </li>
                    <li>
                      {t(
                        'admin.browserExtension.step4',
                        'Add eligible users to the "browser-extension" group (or whichever group(s) you listed above) so they can sign in.'
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

export default AdminBrowserExtensionPage;
