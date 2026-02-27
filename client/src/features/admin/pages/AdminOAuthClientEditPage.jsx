import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import ResourceSelector from '../components/ResourceSelector';
import { makeAdminApiCall } from '../../../api/adminApi';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';

const AdminOAuthClientEditPage = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { clientId } = useParams();
  const isNew = clientId === 'new';

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [newClientId, setNewClientId] = useState('');
  const [newClientSecret, setNewClientSecret] = useState('');
  const [showSecretModal, setShowSecretModal] = useState(false);
  const [availableApps, setAvailableApps] = useState([]);
  const [availableModels, setAvailableModels] = useState([]);
  const [redirectUriInput, setRedirectUriInput] = useState('');
  const [postLogoutUriInput, setPostLogoutUriInput] = useState('');

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    allowedApps: [],
    allowedModels: [],
    tokenExpirationMinutes: 60,
    active: true,
    clientType: 'confidential',
    grantTypes: ['client_credentials'],
    redirectUris: [],
    postLogoutRedirectUris: [],
    consentRequired: true,
    trusted: false
  });

  useEffect(() => {
    loadAvailableOptions();
    if (!isNew) {
      loadClient();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  const loadAvailableOptions = async () => {
    try {
      // Load available apps
      const appsResponse = await makeAdminApiCall('/admin/apps');
      const appsData = appsResponse.data;
      const appsList = Array.isArray(appsData) ? appsData : Object.values(appsData.apps || {});
      setAvailableApps(appsList);

      // Load available models
      const modelsResponse = await makeAdminApiCall('/admin/models');
      const modelsData = modelsResponse.data;
      const modelsList = Array.isArray(modelsData)
        ? modelsData
        : Object.values(modelsData.models || {});
      setAvailableModels(modelsList);
    } catch (error) {
      console.error('Failed to load apps/models:', error);
    }
  };

  const loadClient = async () => {
    try {
      const response = await makeAdminApiCall(`/admin/oauth/clients/${clientId}`);
      const data = response.data;

      setFormData({
        name: data.client.name || '',
        description: data.client.description || '',
        allowedApps: data.client.allowedApps || [],
        allowedModels: data.client.allowedModels || [],
        tokenExpirationMinutes: data.client.tokenExpirationMinutes || 60,
        active: data.client.active !== false,
        clientType: data.client.clientType || 'confidential',
        grantTypes: data.client.grantTypes || ['client_credentials'],
        redirectUris: data.client.redirectUris || [],
        postLogoutRedirectUris: data.client.postLogoutRedirectUris || [],
        consentRequired: data.client.consentRequired !== false,
        trusted: data.client.trusted || false
      });
    } catch (error) {
      setMessage({
        type: 'error',
        text: `${t('admin.auth.oauth.loadError', 'Failed to load OAuth client')}: ${error.message}`
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async e => {
    e.preventDefault();
    setSaving(true);
    setMessage('');

    try {
      if (isNew) {
        const response = await makeAdminApiCall('/admin/oauth/clients', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(formData)
        });

        const data = response.data;
        setNewClientId(data.client.clientId);
        setNewClientSecret(data.client.clientSecret);
        setShowSecretModal(true);
      } else {
        await makeAdminApiCall(`/admin/oauth/clients/${clientId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(formData)
        });

        setMessage({
          type: 'success',
          text: t('admin.auth.oauth.updateSuccess', 'OAuth client updated successfully')
        });
      }
    } catch (error) {
      setMessage({
        type: 'error',
        text: `${isNew ? t('admin.auth.oauth.createError', 'Failed to create OAuth client') : t('admin.auth.oauth.updateError', 'Failed to update OAuth client')}: ${error.message}`
      });
    } finally {
      setSaving(false);
    }
  };

  const handleInputChange = e => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };

  const handleAppsChange = selectedApps => {
    setFormData(prev => ({
      ...prev,
      allowedApps: selectedApps
    }));
  };

  const handleModelsChange = selectedModels => {
    setFormData(prev => ({
      ...prev,
      allowedModels: selectedModels
    }));
  };

  /**
   * Adds a redirect URI to the specified field after validating the URI scheme.
   * Accepts HTTPS URIs for production and HTTP localhost URIs for development.
   *
   * @param {'redirectUris'|'postLogoutRedirectUris'} field - The formData field to append to
   * @param {string} value - The raw URI string entered by the admin
   */
  const handleRedirectUriAdd = (field, value) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    // Validate: must be https:// or http://localhost
    if (!trimmed.startsWith('https://') && !trimmed.match(/^http:\/\/localhost(:\d+)?/)) {
      alert('Redirect URIs must use HTTPS (or http://localhost for development)');
      return;
    }
    setFormData(prev => ({
      ...prev,
      [field]: [...(prev[field] || []), trimmed]
    }));
  };

  /**
   * Removes a redirect URI from the specified field by its index.
   *
   * @param {'redirectUris'|'postLogoutRedirectUris'} field - The formData field to remove from
   * @param {number} index - Zero-based index of the URI to remove
   */
  const handleRedirectUriRemove = (field, index) => {
    setFormData(prev => ({
      ...prev,
      [field]: prev[field].filter((_, i) => i !== index)
    }));
  };

  /**
   * Toggles a grant type on or off in the grantTypes array.
   * If the grant type is already present it is removed; otherwise it is added.
   *
   * @param {string} grantType - The OAuth 2.0 grant type identifier (e.g. 'authorization_code')
   */
  const handleGrantTypeToggle = grantType => {
    setFormData(prev => {
      const current = prev.grantTypes || [];
      const updated = current.includes(grantType)
        ? current.filter(g => g !== grantType)
        : [...current, grantType];
      return { ...prev, grantTypes: updated };
    });
  };

  const copyToClipboard = text => {
    navigator.clipboard.writeText(text);
  };

  const handleModalClose = () => {
    setShowSecretModal(false);
    navigate('/admin/oauth/clients');
  };

  if (loading) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      </AdminAuth>
    );
  }

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        {/* Header */}
        <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div className="flex items-center">
              <button
                onClick={() => navigate('/admin/oauth/clients')}
                className="mr-4 text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300"
              >
                <Icon name="arrow-left" size="md" />
              </button>
              <div>
                <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
                  {isNew
                    ? t('admin.auth.oauth.createClient', 'Create OAuth Client')
                    : t('admin.auth.oauth.editClient', 'Edit OAuth Client')}
                </h1>
                <p className="text-gray-600 dark:text-gray-400 mt-1">
                  Configure client credentials and permissions for external API access
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {message && (
            <div
              className={`mb-6 p-4 rounded-md ${
                message.type === 'success'
                  ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800'
                  : 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800'
              }`}
            >
              <div className="flex">
                <Icon
                  name={message.type === 'success' ? 'check' : 'warning'}
                  size="md"
                  className={`mt-0.5 mr-3 ${
                    message.type === 'success' ? 'text-green-500' : 'text-red-500'
                  }`}
                />
                <p
                  className={`text-sm ${
                    message.type === 'success'
                      ? 'text-green-700 dark:text-green-300'
                      : 'text-red-700 dark:text-red-300'
                  }`}
                >
                  {message.text}
                </p>
              </div>
            </div>
          )}

          <form
            onSubmit={handleSubmit}
            className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 space-y-6"
          >
            {/* Basic Information */}
            <div>
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                {t('common.basicInfo', 'Basic Information')}
              </h3>
              <div className="space-y-4">
                <div>
                  <label
                    htmlFor="name"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    {t('admin.auth.oauth.name', 'Client Name')} *
                  </label>
                  <input
                    type="text"
                    id="name"
                    name="name"
                    required
                    value={formData.name}
                    onChange={handleInputChange}
                    className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                  />
                </div>

                <div>
                  <label
                    htmlFor="description"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    {t('admin.auth.oauth.description', 'Description')}
                  </label>
                  <textarea
                    id="description"
                    name="description"
                    rows={3}
                    value={formData.description}
                    onChange={handleInputChange}
                    className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                  />
                </div>

                <div>
                  <label
                    htmlFor="tokenExpirationMinutes"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    {t('admin.auth.oauth.tokenExpiration', 'Token Expiration (minutes)')}
                  </label>
                  <input
                    type="number"
                    id="tokenExpirationMinutes"
                    name="tokenExpirationMinutes"
                    min="1"
                    max="1440"
                    value={formData.tokenExpirationMinutes}
                    onChange={handleInputChange}
                    className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                  />
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    Default: 60 minutes, Maximum: 1440 minutes (24 hours)
                  </p>
                </div>

                <div className="flex items-center">
                  <input
                    type="checkbox"
                    id="active"
                    name="active"
                    checked={formData.active}
                    onChange={handleInputChange}
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                  />
                  <label htmlFor="active" className="ml-2 block text-sm text-gray-900">
                    {t('admin.auth.oauth.active', 'Active')}
                  </label>
                </div>
              </div>
            </div>

            {/* Allowed Apps */}
            <div>
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                {t('admin.auth.oauth.allowedApps', 'Allowed Apps')}
              </h3>
              <ResourceSelector
                label={t('admin.auth.oauth.allowedApps', 'Allowed Apps')}
                resources={availableApps}
                selectedResources={formData.allowedApps}
                onSelectionChange={handleAppsChange}
                placeholder={t('admin.auth.oauth.searchApps', 'Search apps to add...')}
                emptyMessage={t(
                  'admin.auth.oauth.noAppsSelected',
                  'No apps selected - client can access all apps'
                )}
                allowWildcard={true}
              />
            </div>

            {/* Allowed Models */}
            <div>
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                {t('admin.auth.oauth.allowedModels', 'Allowed Models')}
              </h3>
              <ResourceSelector
                label={t('admin.auth.oauth.allowedModels', 'Allowed Models')}
                resources={availableModels}
                selectedResources={formData.allowedModels}
                onSelectionChange={handleModelsChange}
                placeholder={t('admin.auth.oauth.searchModels', 'Search models to add...')}
                emptyMessage={t(
                  'admin.auth.oauth.noModelsSelected',
                  'No models selected - client can access all models'
                )}
                allowWildcard={true}
              />
            </div>

            {/* Client Type & Grant Types */}
            <div>
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                {t('admin.auth.oauth.authCodeSection', 'OAuth 2.0 Authorization Code Flow')}
              </h3>
              <div className="space-y-4">
                <div>
                  <label
                    htmlFor="clientType"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    {t('admin.auth.oauth.clientType', 'Client Type')}
                  </label>
                  <select
                    id="clientType"
                    name="clientType"
                    value={formData.clientType}
                    onChange={handleInputChange}
                    className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                  >
                    <option value="confidential">
                      {t(
                        'admin.auth.oauth.clientTypeConfidential',
                        'Confidential (server-side apps with client secret)'
                      )}
                    </option>
                    <option value="public">
                      {t(
                        'admin.auth.oauth.clientTypePublic',
                        'Public (SPAs, mobile apps - PKCE required)'
                      )}
                    </option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    {t('admin.auth.oauth.grantTypes', 'Grant Types')}
                  </label>
                  <div className="space-y-2">
                    {['client_credentials', 'authorization_code', 'refresh_token'].map(grant => (
                      <label key={grant} className="flex items-center">
                        <input
                          type="checkbox"
                          checked={(formData.grantTypes || []).includes(grant)}
                          onChange={() => handleGrantTypeToggle(grant)}
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                        />
                        <span className="ml-2 text-sm text-gray-700">
                          {grant === 'client_credentials' &&
                            t(
                              'admin.auth.oauth.grantClientCredentials',
                              'Client Credentials (machine-to-machine)'
                            )}
                          {grant === 'authorization_code' &&
                            t(
                              'admin.auth.oauth.grantAuthorizationCode',
                              'Authorization Code (user login with PKCE)'
                            )}
                          {grant === 'refresh_token' &&
                            t(
                              'admin.auth.oauth.grantRefreshToken',
                              'Refresh Token (long-lived sessions)'
                            )}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>

                {(formData.grantTypes || []).includes('authorization_code') && (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        {t('admin.auth.oauth.redirectUris', 'Redirect URIs')}
                      </label>
                      <div className="space-y-2">
                        {(formData.redirectUris || []).map((uri, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <code className="flex-1 bg-gray-100 px-2 py-1 rounded text-sm">
                              {uri}
                            </code>
                            <button
                              type="button"
                              onClick={() => handleRedirectUriRemove('redirectUris', i)}
                              className="text-red-500 hover:text-red-700"
                            >
                              &times;
                            </button>
                          </div>
                        ))}
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={redirectUriInput}
                            onChange={e => setRedirectUriInput(e.target.value)}
                            placeholder={t(
                              'admin.auth.oauth.redirectUriPlaceholder',
                              'https://yourapp.com/callback'
                            )}
                            className="flex-1 border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                handleRedirectUriAdd('redirectUris', redirectUriInput);
                                setRedirectUriInput('');
                              }
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => {
                              handleRedirectUriAdd('redirectUris', redirectUriInput);
                              setRedirectUriInput('');
                            }}
                            className="px-3 py-2 border border-gray-300 rounded-md text-sm hover:bg-gray-50"
                          >
                            {t('common.add', 'Add')}
                          </button>
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          {t(
                            'admin.auth.oauth.redirectUriHint',
                            'Must use HTTPS (or http://localhost for development)'
                          )}
                        </p>
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                        {t('admin.auth.oauth.postLogoutRedirectUris', 'Post-Logout Redirect URIs')}
                      </label>
                      <div className="space-y-2">
                        {(formData.postLogoutRedirectUris || []).map((uri, i) => (
                          <div key={i} className="flex items-center gap-2">
                            <code className="flex-1 bg-gray-100 px-2 py-1 rounded text-sm">
                              {uri}
                            </code>
                            <button
                              type="button"
                              onClick={() => handleRedirectUriRemove('postLogoutRedirectUris', i)}
                              className="text-red-500 hover:text-red-700"
                            >
                              &times;
                            </button>
                          </div>
                        ))}
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={postLogoutUriInput}
                            onChange={e => setPostLogoutUriInput(e.target.value)}
                            placeholder={t(
                              'admin.auth.oauth.postLogoutUriPlaceholder',
                              'https://yourapp.com/logged-out'
                            )}
                            className="flex-1 border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                handleRedirectUriAdd('postLogoutRedirectUris', postLogoutUriInput);
                                setPostLogoutUriInput('');
                              }
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => {
                              handleRedirectUriAdd('postLogoutRedirectUris', postLogoutUriInput);
                              setPostLogoutUriInput('');
                            }}
                            className="px-3 py-2 border border-gray-300 rounded-md text-sm hover:bg-gray-50"
                          >
                            {t('common.add', 'Add')}
                          </button>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-3 border-t pt-3">
                      <div className="flex items-center">
                        <input
                          type="checkbox"
                          id="consentRequired"
                          name="consentRequired"
                          checked={formData.consentRequired}
                          onChange={handleInputChange}
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                        />
                        <label
                          htmlFor="consentRequired"
                          className="ml-2 block text-sm text-gray-900"
                        >
                          {t('admin.auth.oauth.consentRequired', 'Require user consent screen')}
                        </label>
                      </div>
                      <div className="flex items-center">
                        <input
                          type="checkbox"
                          id="trusted"
                          name="trusted"
                          checked={formData.trusted}
                          onChange={handleInputChange}
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
                        />
                        <label htmlFor="trusted" className="ml-2 block text-sm text-gray-900">
                          {t(
                            'admin.auth.oauth.trustedClient',
                            'Trusted client (skip consent screen)'
                          )}
                        </label>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Submit buttons */}
            <div className="flex justify-end space-x-4 pt-6 border-t border-gray-200 dark:border-gray-700">
              <button
                type="button"
                onClick={() => navigate('/admin/oauth/clients')}
                className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
              >
                {saving
                  ? t('common.saving', 'Saving...')
                  : isNew
                    ? t('common.create', 'Create')
                    : t('common.save', 'Save')}
              </button>
            </div>
          </form>
        </div>
      </div>

      {/* Secret Modal */}
      {showSecretModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 dark:bg-gray-900 dark:bg-opacity-75 overflow-y-auto h-full w-full z-50 flex items-center justify-center">
          <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl max-w-2xl w-full mx-4">
            <div className="p-6">
              <div className="flex items-center mb-4">
                <Icon name="check" className="h-6 w-6 text-green-500 mr-3" />
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                  {t('admin.auth.oauth.createSuccess', 'OAuth client created successfully')}
                </h3>
              </div>

              <div className="bg-yellow-50 dark:bg-yellow-900/30 border border-yellow-200 dark:border-yellow-800 rounded-md p-4 mb-4">
                <div className="flex">
                  <Icon name="warning" className="h-5 w-5 text-yellow-400 mr-3 mt-0.5" />
                  <div>
                    <h4 className="text-sm font-medium text-yellow-800 dark:text-yellow-200">
                      {t(
                        'admin.auth.oauth.clientSecretWarning',
                        'Save this secret now. It will not be shown again.'
                      )}
                    </h4>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    {t('admin.auth.oauth.clientId', 'Client ID')}
                  </label>
                  <div className="flex gap-2">
                    <code className="flex-1 bg-gray-100 dark:bg-gray-700 px-3 py-2 rounded text-sm break-all text-gray-900 dark:text-gray-100">
                      {newClientId}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(newClientId)}
                      className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm hover:bg-gray-50 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300"
                    >
                      <Icon name="clipboard" size="sm" />
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    {t('admin.auth.oauth.clientSecret', 'Client Secret')}
                  </label>
                  <div className="flex gap-2">
                    <code className="flex-1 bg-gray-100 dark:bg-gray-700 px-3 py-2 rounded text-sm break-all text-gray-900 dark:text-gray-100">
                      {newClientSecret}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(newClientSecret)}
                      className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm hover:bg-gray-50 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300"
                    >
                      <Icon name="clipboard" size="sm" />
                    </button>
                  </div>
                </div>
              </div>

              <div className="mt-6 flex justify-end">
                <button
                  onClick={handleModalClose}
                  className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
                >
                  {t('common.close', 'Close')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </AdminAuth>
  );
};

export default AdminOAuthClientEditPage;
