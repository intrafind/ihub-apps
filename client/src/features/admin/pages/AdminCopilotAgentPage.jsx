import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { makeAdminApiCall } from '../../../api/adminApi';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';

const TEAMS_DEVELOPER_PORTAL_URL = 'https://dev.teams.microsoft.com/tools';

const CARD =
  'bg-white dark:bg-gray-800 rounded-xl shadow-xs border border-gray-200 dark:border-gray-700 p-6';
const INPUT =
  'w-full rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-hidden focus:ring-2 focus:ring-indigo-500';
const SECONDARY_BUTTON =
  'shrink-0 rounded-lg border border-gray-300 dark:border-gray-600 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50';
const PRIMARY_BUTTON =
  'rounded-lg bg-indigo-600 text-white px-4 py-2 text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed';

/** A read-only value with a copy button, for the Teams Developer Portal fields. */
function CopyField({ label, value, hint }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(value);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div>
      <div className="text-sm font-medium text-gray-700 dark:text-gray-300">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <input
          type="text"
          readOnly
          value={value}
          aria-label={label}
          onClick={e => e.target.select()}
          className="flex-1 min-w-0 rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 px-3 py-2 text-sm font-mono text-gray-700 dark:text-gray-300 focus:outline-hidden"
        />
        <button type="button" onClick={copy} className={SECONDARY_BUTTON}>
          {copied ? t('admin.copilotAgent.copied', 'Copied') : t('admin.copilotAgent.copy', 'Copy')}
        </button>
      </div>
      {hint && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{hint}</p>}
    </div>
  );
}

/** One prerequisite, met or not. */
function Prerequisite({ ok, children }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span
        aria-hidden
        className={ok ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}
      >
        {ok ? '✓' : '!'}
      </span>
      <span className="text-gray-700 dark:text-gray-300">{children}</span>
    </li>
  );
}

/**
 * Admin → Integrations → Microsoft 365 Copilot.
 *
 * Makes iHub a declarative agent in Microsoft 365 Copilot: enabling creates the
 * OAuth client Copilot signs users in with (and turns on the MCP gateway it
 * calls), the admin registers that client in the Teams Developer Portal and
 * brings back the registration ID, and the page builds the package to upload
 * in the Microsoft 365 admin center. See server/routes/admin/copilotAgent.js.
 */
function AdminCopilotAgentPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [message, setMessage] = useState(null);
  const [toggling, setToggling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [secret, setSecret] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);

  const [referenceId, setReferenceId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [starters, setStarters] = useState([]);

  const limits = status?.limits || {};

  const loadStatus = async () => {
    try {
      setLoading(true);
      const res = await makeAdminApiCall('/admin/copilot-agent/status', { method: 'GET' });
      const data = res.data;
      setStatus(data);
      setReferenceId(data.oauthReferenceId || '');
      setName(data.name || '');
      setDescription(data.description || '');
      setInstructions(data.instructions || '');
      setStarters(
        Array.isArray(data.conversationStarters)
          ? data.conversationStarters.map(s => ({
              _id: crypto.randomUUID(),
              title: s?.title || '',
              text: s?.text || ''
            }))
          : []
      );
    } catch {
      setMessage({
        type: 'error',
        text: t('admin.copilotAgent.loadError', 'Failed to load the Copilot agent settings')
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadStatus();
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  const handleToggle = async () => {
    if (!status) return;
    const action = status.enabled ? 'disable' : 'enable';
    try {
      setToggling(true);
      setMessage(null);
      const res = await makeAdminApiCall(`/admin/copilot-agent/${action}`, { method: 'POST' });
      if (res.data?.clientSecret) setSecret(res.data.clientSecret);
      if (action === 'disable') setSecret(null);
      await loadStatus();
      setMessage({
        type: 'success',
        text: status.enabled
          ? t(
              'admin.copilotAgent.disabled',
              'Copilot agent disabled. Copilot can no longer sign in to iHub.'
            )
          : t(
              'admin.copilotAgent.enabled',
              'Copilot agent enabled. Register the sign-in in the Teams Developer Portal next.'
            )
      });
    } catch (err) {
      setMessage({
        type: 'error',
        text:
          t('admin.copilotAgent.toggleError', 'Failed to update the Copilot agent: ') +
          (err?.message || '')
      });
    } finally {
      setToggling(false);
    }
  };

  const handleRotateSecret = () => {
    setConfirmDialog({
      title: t('admin.copilotAgent.rotateTitle', 'Issue a new client secret'),
      message: t(
        'admin.copilotAgent.rotateConfirm',
        'The current secret stops working at once, and Copilot cannot sign anyone in until you enter the new one in the Teams Developer Portal. Continue?'
      ),
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          setMessage(null);
          const res = await makeAdminApiCall('/admin/copilot-agent/rotate-secret', {
            method: 'POST'
          });
          setSecret(res.data?.clientSecret || null);
        } catch (err) {
          setMessage({
            type: 'error',
            text:
              t('admin.copilotAgent.rotateError', 'Failed to issue a new secret: ') +
              (err?.message || '')
          });
        }
      }
    });
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setMessage(null);
      await makeAdminApiCall('/admin/copilot-agent/config', {
        method: 'PUT',
        body: {
          oauthReferenceId: referenceId,
          name,
          description,
          instructions,
          conversationStarters: starters
            .map(s => ({ title: s.title.trim(), text: s.text.trim() }))
            .filter(s => s.title || s.text)
        }
      });
      await loadStatus();
      setMessage({ type: 'success', text: t('admin.copilotAgent.saved', 'Settings saved') });
    } catch (err) {
      setMessage({
        type: 'error',
        text:
          t('admin.copilotAgent.saveError', 'Failed to save the settings: ') +
          (err?.originalMessage || err?.message || '')
      });
    } finally {
      setSaving(false);
    }
  };

  // Step 1's own save: the registration ID only, never step 2's unsaved edits.
  const handleSaveReferenceId = async () => {
    try {
      setSaving(true);
      setMessage(null);
      await makeAdminApiCall('/admin/copilot-agent/config', {
        method: 'PUT',
        body: { oauthReferenceId: referenceId }
      });
      const res = await makeAdminApiCall('/admin/copilot-agent/status', { method: 'GET' });
      setStatus(res.data);
      setMessage({ type: 'success', text: t('admin.copilotAgent.saved', 'Settings saved') });
    } catch (err) {
      setMessage({
        type: 'error',
        text:
          t('admin.copilotAgent.saveError', 'Failed to save the settings: ') +
          (err?.originalMessage || err?.message || '')
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDownload = async () => {
    try {
      setDownloading(true);
      setMessage(null);
      const response = await makeAdminApiCall('/admin/copilot-agent/package.zip', {
        method: 'GET',
        responseType: 'blob'
      });
      const url = window.URL.createObjectURL(response.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ihub-copilot-agent.zip';
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      setMessage({
        type: 'error',
        text:
          t('admin.copilotAgent.downloadError', 'Failed to build the package: ') +
          (err?.message || '')
      });
    } finally {
      setDownloading(false);
    }
  };

  const updateStarter = (index, field, value) =>
    setStarters(prev => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)));

  const registration = status?.registration;
  const prerequisites = status?.prerequisites || {};
  const savedReferenceId = status?.oauthReferenceId || '';

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="bg-white dark:bg-gray-800 shadow-xs border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
            {t('admin.copilotAgent.title', 'Microsoft 365 Copilot')}
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mt-2">
            {t(
              'admin.copilotAgent.description',
              "Make iHub an agent in Microsoft 365 Copilot. Users pick it in Copilot Chat or in Copilot's pane in Outlook, Teams and Word, and Copilot runs iHub's apps for them — signed in with their own iHub account."
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

        {loading && !status ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-8 h-8 border-4 border-gray-200 border-t-indigo-600 rounded-full animate-spin" />
          </div>
        ) : (
          <>
            {/* Status */}
            <div className={CARD}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    {t('admin.copilotAgent.statusTitle', 'Integration status')}
                  </h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                    {status?.enabled
                      ? t(
                          'admin.copilotAgent.statusEnabled',
                          'Enabled. Copilot signs users in with the OAuth client below and calls the MCP gateway.'
                        )
                      : t(
                          'admin.copilotAgent.statusDisabled',
                          "Enabling creates the OAuth client Copilot signs users in with, and turns on iHub's OAuth server and MCP gateway, which the agent needs."
                        )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleToggle}
                  disabled={toggling}
                  className={`shrink-0 rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:opacity-60 ${
                    status?.enabled
                      ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400'
                      : 'bg-indigo-600 text-white hover:bg-indigo-700'
                  }`}
                >
                  {toggling
                    ? '…'
                    : status?.enabled
                      ? t('admin.copilotAgent.disable', 'Disable')
                      : t('admin.copilotAgent.enable', 'Enable')}
                </button>
              </div>

              {status?.enabled && (
                <ul className="mt-4 pt-4 border-t border-gray-100 dark:border-gray-700 space-y-1">
                  <Prerequisite ok={prerequisites.oauthClient}>
                    {t('admin.copilotAgent.prereqClient', 'OAuth client')}{' '}
                    {status.oauthClientId && (
                      <Link
                        to={`/admin/oauth/clients/${status.oauthClientId}`}
                        className="font-mono text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                      >
                        {status.oauthClientId}
                      </Link>
                    )}
                  </Prerequisite>
                  <Prerequisite ok={prerequisites.oauthServer}>
                    {t('admin.copilotAgent.prereqOauth', 'OAuth authorization server')}
                  </Prerequisite>
                  <Prerequisite ok={prerequisites.mcpGateway}>
                    {t('admin.copilotAgent.prereqGateway', 'MCP gateway')}{' '}
                    <Link
                      to="/admin/mcp/gateway"
                      className="text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      {t('admin.copilotAgent.gatewaySettings', 'Gateway settings')}
                    </Link>
                  </Prerequisite>
                  <Prerequisite ok={prerequisites.publicHttps}>
                    {prerequisites.publicHttps
                      ? t('admin.copilotAgent.prereqHttps', "iHub's public address uses HTTPS")
                      : t(
                          'admin.copilotAgent.prereqHttpsOff',
                          "iHub's public address is not HTTPS, and Copilot only calls HTTPS addresses — set the MCP gateway's Public URL (or forward X-Forwarded-Proto from the proxy)"
                        )}
                  </Prerequisite>
                  <Prerequisite ok={prerequisites.appsExposed}>
                    {prerequisites.appsExposed
                      ? t('admin.copilotAgent.prereqApps', 'The gateway offers iHub apps as tools')
                      : t(
                          'admin.copilotAgent.prereqAppsOff',
                          'The gateway does not offer iHub apps — turn on "Apps" under the gateway\'s exposed capabilities'
                        )}
                  </Prerequisite>
                </ul>
              )}

              {secret && (
                <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-900/20">
                  <CopyField
                    label={t('admin.copilotAgent.secretLabel', 'Client secret')}
                    value={secret}
                    hint={t(
                      'admin.copilotAgent.secretHint',
                      'Shown only now. Enter it as the client secret in the Teams Developer Portal (step 1).'
                    )}
                  />
                </div>
              )}
            </div>

            {status?.enabled && registration && (
              <>
                {/* Step 1: OAuth registration */}
                <div className={CARD}>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    {t(
                      'admin.copilotAgent.step1Title',
                      '1. Register the sign-in in the Teams Developer Portal'
                    )}
                  </h2>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 mb-4">
                    {t(
                      'admin.copilotAgent.step1Desc',
                      'In the Teams Developer Portal, open Tools → OAuth client registration and register a client with these values. Set "Restrict usage by app" to "Any Teams app" and keep PKCE on.'
                    )}{' '}
                    <a
                      href={TEAMS_DEVELOPER_PORTAL_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-indigo-600 hover:underline dark:text-indigo-400"
                    >
                      {t('admin.copilotAgent.openPortal', 'Open the Teams Developer Portal')}
                    </a>
                  </p>
                  <div className="space-y-3">
                    <CopyField
                      label={t('admin.copilotAgent.fieldBaseUrl', 'Base URL')}
                      value={registration.baseUrl}
                      hint={t(
                        'admin.copilotAgent.fieldBaseUrlHint',
                        "The MCP gateway's address. It must match the address in the package exactly."
                      )}
                    />
                    <CopyField
                      label={t('admin.copilotAgent.fieldClientId', 'Client ID')}
                      value={registration.clientId}
                    />
                    <div className="text-sm text-gray-600 dark:text-gray-400">
                      <span className="font-medium text-gray-700 dark:text-gray-300">
                        {t('admin.copilotAgent.fieldSecret', 'Client secret')}:
                      </span>{' '}
                      {t(
                        'admin.copilotAgent.fieldSecretDesc',
                        'shown once when the agent is enabled. Lost it?'
                      )}{' '}
                      <button
                        type="button"
                        onClick={handleRotateSecret}
                        className="text-indigo-600 hover:underline dark:text-indigo-400"
                      >
                        {t('admin.copilotAgent.rotate', 'Issue a new secret')}
                      </button>
                    </div>
                    <CopyField
                      label={t('admin.copilotAgent.fieldAuthorize', 'Authorization endpoint')}
                      value={registration.authorizationEndpoint}
                    />
                    <CopyField
                      label={t('admin.copilotAgent.fieldToken', 'Token endpoint')}
                      value={registration.tokenEndpoint}
                    />
                    <CopyField
                      label={t('admin.copilotAgent.fieldRefresh', 'Refresh endpoint')}
                      value={registration.refreshEndpoint}
                    />
                    <CopyField
                      label={t('admin.copilotAgent.fieldScope', 'Scope')}
                      value={registration.scope}
                    />
                    <CopyField
                      label={t(
                        'admin.copilotAgent.fieldRedirect',
                        'Redirect URI (already allowed)'
                      )}
                      value={registration.redirectUri}
                    />
                  </div>
                  <div className="mt-6">
                    <label
                      htmlFor="copilot-reference-id"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                    >
                      {t('admin.copilotAgent.referenceId', 'OAuth client registration ID')}
                    </label>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                      {t(
                        'admin.copilotAgent.referenceIdHint',
                        'The portal shows this ID after saving the registration. The package needs it.'
                      )}
                    </p>
                    <div className="flex items-center gap-2">
                      <input
                        id="copilot-reference-id"
                        type="text"
                        value={referenceId}
                        onChange={e => setReferenceId(e.target.value)}
                        className={`${INPUT} font-mono`}
                        maxLength={limits.referenceId || 512}
                      />
                      <button
                        type="button"
                        onClick={handleSaveReferenceId}
                        disabled={saving || referenceId.trim() === savedReferenceId}
                        className={SECONDARY_BUTTON}
                      >
                        {t('admin.copilotAgent.save', 'Save')}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Step 2: Agent */}
                <div className={CARD}>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
                    {t('admin.copilotAgent.step2Title', '2. Describe the agent')}
                  </h2>
                  <div className="space-y-4">
                    <div>
                      <label
                        htmlFor="copilot-name"
                        className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                      >
                        {t('admin.copilotAgent.name', 'Name')}
                      </label>
                      <input
                        id="copilot-name"
                        type="text"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        maxLength={limits.name || 30}
                        className={INPUT}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="copilot-description"
                        className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                      >
                        {t('admin.copilotAgent.agentDescription', 'Description')}
                      </label>
                      <textarea
                        id="copilot-description"
                        value={description}
                        onChange={e => setDescription(e.target.value)}
                        maxLength={limits.description || 1000}
                        rows={2}
                        className={INPUT}
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="copilot-instructions"
                        className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                      >
                        {t('admin.copilotAgent.instructions', 'Instructions')}
                      </label>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">
                        {t(
                          'admin.copilotAgent.instructionsHint',
                          "What Copilot is told about iHub. Leave empty to use iHub's default instructions, shown as the placeholder."
                        )}
                      </p>
                      <textarea
                        id="copilot-instructions"
                        value={instructions}
                        onChange={e => setInstructions(e.target.value)}
                        placeholder={status.defaultInstructions}
                        maxLength={limits.instructions || 8000}
                        rows={8}
                        className={`${INPUT} font-mono text-xs`}
                      />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        {t('admin.copilotAgent.starters', 'Conversation starters')}
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                        {t(
                          'admin.copilotAgent.startersHint',
                          'Suggestions Copilot shows when the agent is opened. Up to 12.'
                        )}
                      </p>
                      <div className="space-y-2">
                        {starters.map((starter, index) => (
                          <div key={starter._id} className="flex items-start gap-2">
                            <input
                              type="text"
                              value={starter.title}
                              onChange={e => updateStarter(index, 'title', e.target.value)}
                              placeholder={t('admin.copilotAgent.starterTitle', 'Title')}
                              aria-label={t('admin.copilotAgent.starterTitle', 'Title')}
                              maxLength={limits.starterTitle || 50}
                              className={`${INPUT} sm:w-1/3`}
                            />
                            <input
                              type="text"
                              value={starter.text}
                              onChange={e => updateStarter(index, 'text', e.target.value)}
                              placeholder={t('admin.copilotAgent.starterText', 'Prompt')}
                              aria-label={t('admin.copilotAgent.starterText', 'Prompt')}
                              maxLength={limits.starterText || 500}
                              className={INPUT}
                            />
                            <button
                              type="button"
                              onClick={() =>
                                setStarters(prev => prev.filter((_, i) => i !== index))
                              }
                              className={SECONDARY_BUTTON}
                              aria-label={t('admin.copilotAgent.removeStarter', 'Remove')}
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                      <button
                        type="button"
                        disabled={starters.length >= (limits.starters || 12)}
                        onClick={() =>
                          setStarters(prev => [
                            ...prev,
                            { _id: crypto.randomUUID(), title: '', text: '' }
                          ])
                        }
                        className={`${SECONDARY_BUTTON} mt-2`}
                      >
                        {t('admin.copilotAgent.addStarter', 'Add starter')}
                      </button>
                    </div>
                  </div>
                  <div className="mt-6 flex justify-end">
                    <button
                      type="button"
                      onClick={handleSave}
                      disabled={saving}
                      className={PRIMARY_BUTTON}
                    >
                      {saving
                        ? t('admin.copilotAgent.saving', 'Saving…')
                        : t('admin.copilotAgent.save', 'Save')}
                    </button>
                  </div>
                </div>

                {/* Step 3: Package */}
                <div className={CARD}>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    {t('admin.copilotAgent.step3Title', '3. Upload the agent to Microsoft 365')}
                  </h2>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1 mb-4">
                    {t(
                      'admin.copilotAgent.step3Desc',
                      'Upload the package in the Microsoft 365 admin center under Copilot → Agents → Upload custom agent, then choose who gets it. Every download has a new version, so download again and re-upload after changing the settings.'
                    )}
                  </p>
                  {!savedReferenceId && (
                    <p className="mb-3 text-sm text-amber-700 dark:text-amber-400">
                      {t(
                        'admin.copilotAgent.needsReferenceId',
                        'Save the OAuth client registration ID from step 1 first.'
                      )}
                    </p>
                  )}
                  {!prerequisites.publicHttps && (
                    <p className="mb-3 text-sm text-amber-700 dark:text-amber-400">
                      {t(
                        'admin.copilotAgent.needsHttps',
                        'Copilot only calls HTTPS addresses. Set the MCP gateway Public URL to the HTTPS address of iHub first.'
                      )}
                    </p>
                  )}
                  <button
                    type="button"
                    onClick={handleDownload}
                    disabled={!status.packageReady || downloading}
                    className={PRIMARY_BUTTON}
                  >
                    {downloading
                      ? t('admin.copilotAgent.downloading', 'Building…')
                      : t('admin.copilotAgent.download', 'Download agent package')}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        isOpen={!!confirmDialog}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        danger={confirmDialog?.danger}
        onConfirm={() => confirmDialog?.onConfirm()}
        onDeny={() => setConfirmDialog(null)}
      />
    </div>
  );
}

export default AdminCopilotAgentPage;
