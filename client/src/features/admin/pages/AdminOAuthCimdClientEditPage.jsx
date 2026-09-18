import { useState, useEffect, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminBreadcrumb from '../components/AdminBreadcrumb';
import ResourceSelector from '../components/ResourceSelector';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import { makeAdminApiCall } from '../../../api/adminApi';

/**
 * Admin → OAuth → Clients → a client identified by a metadata document.
 *
 * The difference from the stored-client editor is the whole point of this page:
 * a CIMD client's **identity** — its name, redirect URIs and grant types — comes
 * from the document it publishes and is never stored here, so none of it is
 * editable. Only policy is. `trusted` and `consentRequired` are not rendered at
 * all: they are locked, and approving a client is not the same as trusting it.
 *
 * Every policy field can either be set on this client or left to inherit the
 * global defaults under MCP gateway → Client identification. The two are
 * layered field by field, so narrowing one client's groups does not silently
 * drop the global apps list on it — which is why "inherit" is a per-field
 * checkbox rather than an all-or-nothing mode.
 */
function AdminOAuthCimdClientEditPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { encodedClientId } = useParams();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const [client, setClient] = useState(null);
  const [availableApps, setAvailableApps] = useState([]);
  const [availableModels, setAvailableModels] = useState([]);
  const [availablePrompts, setAvailablePrompts] = useState([]);

  // `null` on a field means "inherit the global default"; the API stores null
  // for exactly that, which is what `effectiveField` reads as inherited.
  const [form, setForm] = useState({
    allowedGroups: null,
    allowedApps: null,
    allowedModels: null,
    allowedPrompts: null,
    scopes: null,
    tokenExpirationMinutes: null
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await makeAdminApiCall(`/admin/oauth/clients/cimd/${encodedClientId}`);
      const loaded = response.data?.client;
      setClient(loaded);
      setForm({
        allowedGroups: loaded?.policy?.allowedGroups ?? null,
        allowedApps: loaded?.policy?.allowedApps ?? null,
        allowedModels: loaded?.policy?.allowedModels ?? null,
        allowedPrompts: loaded?.policy?.allowedPrompts ?? null,
        scopes: loaded?.policy?.scopes ?? null,
        tokenExpirationMinutes: loaded?.policy?.tokenExpirationMinutes ?? null
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: `${t('admin.auth.oauth.cimd.loadError', 'Failed to load the client')}: ${error.message}`
      });
    } finally {
      setLoading(false);
    }
  }, [encodedClientId, t]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const loadOptions = async () => {
      const read = async (path, key) => {
        try {
          const response = await makeAdminApiCall(path);
          const data = response.data;
          return Array.isArray(data) ? data : Object.values(data?.[key] || {});
        } catch {
          return [];
        }
      };
      setAvailableApps(await read('/admin/apps', 'apps'));
      setAvailableModels(await read('/admin/models', 'models'));
      setAvailablePrompts(await read('/admin/prompts', 'prompts'));
    };
    loadOptions();
  }, []);

  const setField = (field, value) => setForm(prev => ({ ...prev, [field]: value }));

  const toggleInherit = (field, inherit) => {
    if (inherit) {
      setField(field, null);
      return;
    }
    // Starting point when a field stops inheriting: whatever it effectively
    // has right now, so switching the checkbox never silently widens access.
    setField(field, client?.effective?.[field] ?? []);
  };

  const save = async () => {
    setSaving(true);
    try {
      const response = await makeAdminApiCall(`/admin/oauth/clients/cimd/${encodedClientId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: form
      });
      setClient(response.data?.client || client);
      setMessage({ type: 'success', text: t('admin.auth.oauth.cimd.saved', 'Policy saved') });
    } catch (error) {
      setMessage({
        type: 'error',
        text: `${t('admin.auth.oauth.cimd.saveError', 'Failed to save the policy')}: ${error.message}`
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  const listField = (field, label, resources, placeholder) => (
    <div key={field}>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">{label}</h3>
        <label className="inline-flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
          <input
            type="checkbox"
            checked={form[field] === null}
            onChange={e => toggleInherit(field, e.target.checked)}
            className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded-sm"
          />
          {t('admin.auth.oauth.cimd.inherit', 'Inherit the global default')}
        </label>
      </div>
      {form[field] === null ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('admin.auth.oauth.cimd.inheriting', 'Inheriting: {{value}}', {
            value:
              (client?.effective?.[field] || []).join(', ') ||
              t('admin.auth.oauth.cimd.noRestriction', 'no restriction')
          })}
        </p>
      ) : (
        <ResourceSelector
          label={label}
          resources={resources}
          selectedResources={form[field]}
          onSelectionChange={value => setField(field, value)}
          placeholder={placeholder}
          emptyMessage={t(
            'admin.auth.oauth.cimd.noneSelected',
            'Nothing selected — this client gets none of them'
          )}
          allowWildcard={true}
        />
      )}
    </div>
  );

  const textListField = (field, label, help, placeholder) => (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">{label}</h3>
        <label className="inline-flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
          <input
            type="checkbox"
            checked={form[field] === null}
            onChange={e => toggleInherit(field, e.target.checked)}
            className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded-sm"
          />
          {t('admin.auth.oauth.cimd.inherit', 'Inherit the global default')}
        </label>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{help}</p>
      {form[field] === null ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('admin.auth.oauth.cimd.inheriting', 'Inheriting: {{value}}', {
            value:
              (client?.effective?.[field] || []).join(', ') ||
              t('admin.auth.oauth.cimd.noRestriction', 'no restriction')
          })}
        </p>
      ) : (
        <input
          type="text"
          value={form[field].join(', ')}
          placeholder={placeholder}
          onChange={e =>
            setField(
              field,
              e.target.value
                .split(',')
                .map(value => value.trim())
                .filter(Boolean)
            )
          }
          className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 py-2 px-3 text-sm"
        />
      )}
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 pt-6">
        <AdminBreadcrumb
          crumbs={[
            { label: 'Admin', href: '/admin' },
            { label: 'OAuth', href: '/admin/oauth/clients' },
            { label: client?.name || t('admin.auth.oauth.kind.cimd', 'Client metadata') }
          ]}
        />
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center mb-6">
          <button
            onClick={() => navigate('/admin/oauth/clients')}
            className="mr-4 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
          >
            <Icon name="arrow-left" size="md" />
          </button>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
              {client?.name || t('admin.auth.oauth.kind.cimd', 'Client metadata')}
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              {t(
                'admin.auth.oauth.cimd.editSubtitle',
                'Only policy is editable. This client’s name, redirect URIs and grant types come from the document it publishes.'
              )}
            </p>
          </div>
        </div>

        {message && (
          <div
            className={`mb-6 p-4 rounded-md text-sm ${
              message.type === 'success'
                ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800 text-green-700 dark:text-green-300'
                : 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
            }`}
          >
            {message.text}
          </div>
        )}

        {/* Identity — read-only by design */}
        <section className="bg-white dark:bg-gray-800 shadow-sm rounded-lg p-6 mb-6">
          <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-1">
            {t('admin.auth.oauth.cimd.identityTitle', 'Identity')}
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            {t(
              'admin.auth.oauth.cimd.identityDesc',
              'Read from the metadata document at the URL below on every authorization. Nothing here is stored, so it cannot go stale — and it cannot be edited here.'
            )}
          </p>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <div>
              <dt className="text-gray-500 dark:text-gray-400">
                {t('admin.auth.oauth.cimd.documentUrl', 'Document URL')}
              </dt>
              <dd className="font-mono text-xs text-gray-900 dark:text-gray-100 break-all">
                {client?.clientId}
              </dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">
                {t('admin.auth.oauth.cimd.host', 'Host')}
              </dt>
              <dd className="text-gray-900 dark:text-gray-100">{client?.host}</dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">
                {t('admin.auth.oauth.connectionsLabel', 'Connections')}
              </dt>
              <dd className="text-gray-900 dark:text-gray-100">{client?.connectionCount ?? 0}</dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">
                {t('admin.auth.oauth.cimd.firstSeen', 'First seen')}
              </dt>
              <dd className="text-gray-900 dark:text-gray-100">
                {client?.firstSeenAt
                  ? new Date(client.firstSeenAt).toLocaleString()
                  : t('common.notAvailable', 'N/A')}
              </dd>
            </div>
          </dl>
          <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">
            {t(
              'admin.auth.oauth.cimd.neverTrusted',
              'This client is never trusted and always requires consent, whatever its approval state. Approving it lets people connect; it does not skip the consent screen.'
            )}
          </p>
        </section>

        {/* Policy */}
        <section className="bg-white dark:bg-gray-800 shadow-sm rounded-lg p-6 space-y-6">
          <div>
            <h2 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-1">
              {t('admin.auth.oauth.cimd.policyTitle', 'Policy')}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t(
                'admin.auth.oauth.cimd.policyDesc',
                'Each field either applies to this client alone or inherits the global default for metadata-document clients. Changes take effect on the next gateway request and the next token refresh.'
              )}
            </p>
          </div>

          {textListField(
            'allowedGroups',
            t('admin.auth.oauth.cimd.allowedGroups', 'Allowed groups'),
            t(
              'admin.auth.oauth.cimd.allowedGroupsHelp',
              'Comma-separated group IDs. Only members may connect this client, and a user who leaves every listed group loses access on their next gateway request. Empty means any group.'
            ),
            'claude-code-users'
          )}

          {listField(
            'allowedApps',
            t('admin.auth.oauth.allowedApps', 'Allowed Apps'),
            availableApps,
            t('admin.auth.oauth.searchApps', 'Search apps to add...')
          )}
          {listField(
            'allowedModels',
            t('admin.auth.oauth.allowedModels', 'Allowed Models'),
            availableModels,
            t('admin.auth.oauth.searchModels', 'Search models to add...')
          )}
          {listField(
            'allowedPrompts',
            t('admin.auth.oauth.allowedPrompts', 'Allowed Prompts'),
            availablePrompts,
            t('admin.auth.oauth.searchPrompts', 'Search prompts to add...')
          )}

          {textListField(
            'scopes',
            t('admin.auth.oauth.cimd.scopes', 'Grantable scopes'),
            t(
              'admin.auth.oauth.cimd.scopesHelp',
              'Comma-separated OAuth scopes this client may be granted. Narrowing them also narrows connections that already exist, at their next token refresh.'
            ),
            'openid, mcp:tools:read'
          )}

          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {t('admin.auth.oauth.tokenExpiration', 'Token Expiration (minutes)')}
              </h3>
              <label className="inline-flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                <input
                  type="checkbox"
                  checked={form.tokenExpirationMinutes === null}
                  onChange={e =>
                    setField(
                      'tokenExpirationMinutes',
                      e.target.checked ? null : client?.effective?.tokenExpirationMinutes || 60
                    )
                  }
                  className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded-sm"
                />
                {t('admin.auth.oauth.cimd.inherit', 'Inherit the global default')}
              </label>
            </div>
            {form.tokenExpirationMinutes === null ? (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {t('admin.auth.oauth.cimd.inheriting', 'Inheriting: {{value}}', {
                  value: client?.effective?.tokenExpirationMinutes ?? 60
                })}
              </p>
            ) : (
              <input
                type="number"
                min="1"
                max="1440"
                value={form.tokenExpirationMinutes}
                onChange={e => setField('tokenExpirationMinutes', Number(e.target.value))}
                className="w-40 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 py-2 px-3 text-sm"
              />
            )}
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
              {t(
                'admin.auth.oauth.cimd.tokenExpirationHelp',
                'Also the window a block takes to bite: an access token already issued stays valid until it expires.'
              )}
            </p>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={() => navigate('/admin/oauth/clients')}
              className="px-4 py-2 border border-gray-300 dark:border-gray-600 text-sm font-medium rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
            >
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? t('common.saving', 'Saving...') : t('common.save', 'Save')}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

export default AdminOAuthCimdClientEditPage;
