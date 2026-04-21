import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import { makeAdminApiCall } from '../../../api/adminApi';
import { buildApiUrl } from '../../../utils/runtimeBasePath';

function AdminOfficeIntegrationPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [message, setMessage] = useState(null);
  const [status, setStatus] = useState(null);

  const [displayName, setDisplayName] = useState({});
  const [description, setDescription] = useState({});
  const [starterPrompts, setStarterPrompts] = useState([]);

  const emptyPrompt = () => ({
    title: {},
    message: {}
  });

  const loadStatus = async () => {
    try {
      setLoading(true);
      const res = await makeAdminApiCall('/admin/office-integration/status', { method: 'GET' });
      const data = res.data;
      setStatus(data);
      setDisplayName(data.displayName || {});
      setDescription(data.description || {});
      setStarterPrompts(
        Array.isArray(data.starterPrompts)
          ? data.starterPrompts.map(p => ({
              title: p?.title || {},
              message: p?.message || {}
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

  const handleSaveConfig = async () => {
    try {
      setSaving(true);
      setMessage(null);

      const cleanedPrompts = starterPrompts
        .map(p => ({
          title: p?.title || {},
          message: p?.message || {}
        }))
        .filter(p => {
          const hasTitle = Object.values(p.title).some(v => (v || '').trim().length > 0);
          const hasMessage = Object.values(p.message).some(v => (v || '').trim().length > 0);
          return hasTitle && hasMessage;
        });

      await makeAdminApiCall('/admin/office-integration/config', {
        method: 'PUT',
        data: {
          displayName,
          description,
          starterPrompts: cleanedPrompts
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
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        {/* Header */}
        <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
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
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
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
                    <code className="font-mono text-xs bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded">
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
                <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
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
                      className="flex-1 rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 px-3 py-2 text-sm font-mono text-gray-700 dark:text-gray-300 focus:outline-none"
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
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
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

              {/* Starter Prompts */}
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
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
                        key={index}
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
                              className="rounded px-2 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40 disabled:hover:bg-transparent"
                              aria-label={t('admin.officeIntegration.moveUp', 'Move up')}
                            >
                              ↑
                            </button>
                            <button
                              type="button"
                              onClick={() => handleMovePrompt(index, 1)}
                              disabled={index === starterPrompts.length - 1}
                              className="rounded px-2 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-40 disabled:hover:bg-transparent"
                              aria-label={t('admin.officeIntegration.moveDown', 'Move down')}
                            >
                              ↓
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemovePrompt(index)}
                              className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-900/30"
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
    </AdminAuth>
  );
}

export default AdminOfficeIntegrationPage;
