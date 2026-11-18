// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminBreadcrumb from '../components/AdminBreadcrumb';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import ResourceSelector from '../components/ResourceSelector';
import { makeAdminApiCall } from '../../../api/adminApi';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import UnsavedChangesDialog from '../components/UnsavedChangesDialog';
import SecretRevealDialog from '../../../shared/components/SecretRevealDialog';
import {
  clientGrantWarnings,
  emptyResourceLists,
  grantTypesChanged,
  grantsAll,
  isDelegatedClient,
  isMachineClient,
  validateClientGrants
} from '../utils/oauthClientGrants';

function AdminOAuthClientEditPage() {
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
  const [availablePrompts, setAvailablePrompts] = useState([]);
  const [redirectUriInput, setRedirectUriInput] = useState('');
  const [postLogoutUriInput, setPostLogoutUriInput] = useState('');
  // Inline validation message per redirect-URI field (no native alert).
  const [uriErrors, setUriErrors] = useState({});
  const [initialData, setInitialData] = useState(null);
  // A personal API key acts as its owner, whatever its grant types, so its
  // lists narrow the owner's permissions. Kept out of formData: it is not
  // editable and is not sent on save.
  const [personal, setPersonal] = useState(false);

  const [formData, setFormData] = useState(() => ({
    name: '',
    description: '',
    // New clients start with nothing granted: for a client-credentials client
    // the lists are the grant, so "All" must be an explicit choice.
    ...emptyResourceLists(),
    tokenExpirationMinutes: 60,
    active: true,
    clientType: 'confidential',
    grantTypes: ['client_credentials'],
    redirectUris: [],
    postLogoutRedirectUris: [],
    consentRequired: true,
    trusted: false
  }));

  const { blocker, markSaved } = useUnsavedChanges(initialData, formData);

  useEffect(() => {
    void loadAvailableOptions();
    if (!isNew) {
      void loadClient();
    } else {
      setInitialData({
        name: '',
        description: '',
        ...emptyResourceLists(),
        tokenExpirationMinutes: 60,
        active: true,
        clientType: 'confidential',
        grantTypes: ['client_credentials'],
        redirectUris: [],
        postLogoutRedirectUris: [],
        consentRequired: true,
        trusted: false
      });
    }
    // eslint-disable-next-line @eslint-react/exhaustive-deps
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
      const modelsList = modelsResponse.data?.items;
      setAvailableModels(Array.isArray(modelsList) ? modelsList : []);

      // Load available prompts
      try {
        const promptsResponse = await makeAdminApiCall('/admin/prompts');
        const promptsData = promptsResponse.data;
        const promptsList = Array.isArray(promptsData)
          ? promptsData
          : Object.values(promptsData.prompts || {});
        setAvailablePrompts(promptsList);
      } catch (promptsError) {
        console.error('Failed to load prompts:', promptsError);
      }
    } catch (error) {
      console.error('Failed to load apps/models:', error);
    }
  };

  const loadClient = async () => {
    try {
      const response = await makeAdminApiCall(`/admin/oauth/clients/${clientId}`);
      // The server answers with the client record itself (no envelope).
      const client = response.data || {};

      const loadedFormData = {
        name: client.name || '',
        description: client.description || '',
        allowedApps: client.allowedApps || [],
        allowedModels: client.allowedModels || [],
        allowedPrompts: client.allowedPrompts || [],
        tokenExpirationMinutes: client.tokenExpirationMinutes || 60,
        active: client.active !== false,
        clientType: client.clientType || 'confidential',
        grantTypes: client.grantTypes || ['client_credentials'],
        redirectUris: client.redirectUris || [],
        postLogoutRedirectUris: client.postLogoutRedirectUris || [],
        consentRequired: client.consentRequired !== false,
        trusted: client.trusted || false
      };
      setPersonal(client.personal === true);
      setFormData(loadedFormData);
      setInitialData(loadedFormData);
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
    setMessage('');

    // The only problem validateClientGrants reports: a machine client granted nothing.
    if (
      validateClientGrants(formData, {
        isNew,
        initialLists: initialData,
        personal
      })
    ) {
      setMessage({
        type: 'error',
        text: t(
          'admin.auth.oauth.machineClientNeedsGrant',
          'A client-credentials client needs at least one app, model or prompt. Select what it may use, or choose "All (*)".'
        )
      });
      return;
    }

    setSaving(true);

    try {
      if (isNew) {
        const response = await makeAdminApiCall('/admin/oauth/clients', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: formData
        });

        // The created client, with its secret, is the response body itself.
        const created = response.data || {};
        setNewClientId(created.clientId);
        setNewClientSecret(created.clientSecret);
        setShowSecretModal(true);
      } else {
        await makeAdminApiCall(`/admin/oauth/clients/${clientId}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: formData
        });

        markSaved();
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

  const handlePromptsChange = selectedPrompts => {
    setFormData(prev => ({
      ...prev,
      allowedPrompts: selectedPrompts
    }));
  };

  /**
   * Adds a redirect URI to the specified field after validating the URI scheme.
   * Accepts HTTPS URIs for production and HTTP localhost URIs for development.
   *
   * @param {'redirectUris'|'postLogoutRedirectUris'} field - The formData field to append to
   * @param {string} value - The raw URI string entered by the admin
   * @returns {boolean} true when the URI was added (the caller then clears the
   *   input); false keeps the input so the admin can fix it, with an inline error.
   */
  const handleRedirectUriAdd = (field, value) => {
    const trimmed = value.trim();
    if (!trimmed) return false;
    // Validate: must be https:// or http://localhost
    if (!trimmed.startsWith('https://') && !trimmed.match(/^http:\/\/localhost(:\d+)?/)) {
      setUriErrors(prev => ({
        ...prev,
        [field]: t(
          'admin.auth.oauth.redirectUriInvalid',
          'Not added: redirect URIs must use HTTPS (or http://localhost for development).'
        )
      }));
      return false;
    }
    setUriErrors(prev => ({ ...prev, [field]: null }));
    setFormData(prev => ({
      ...prev,
      [field]: [...(prev[field] || []), trimmed]
    }));
    return true;
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

  const handleModalClose = () => {
    setShowSecretModal(false);
    setNewClientSecret('');
    markSaved();
    navigate('/admin/oauth/clients');
  };

  const machineClient = isMachineClient(formData.grantTypes, { personal });
  // A personal key's lists narrow its owner's permissions, like a delegated client's.
  const delegatedClient = personal || isDelegatedClient(formData.grantTypes);
  const grantWarnings = clientGrantWarnings(formData, { personal });
  const grantTypesEdited =
    !isNew &&
    initialData !== null &&
    grantTypesChanged(initialData.grantTypes, formData.grantTypes);

  /**
   * The text shown under an empty resource list. What "empty" means depends on
   * the grant types: nothing for a machine client, no extra restriction for a
   * user-delegated one, and both when the client has both grant types.
   *
   * @param {'apps'|'models'|'prompts'} kind - The resource list.
   * @returns {string} The translated empty-state text.
   */
  const emptyListMessage = kind => {
    if (machineClient && !delegatedClient) {
      return {
        apps: t(
          'admin.auth.oauth.noAppsSelectedMachine',
          'Nothing selected: this client can use no apps.'
        ),
        models: t(
          'admin.auth.oauth.noModelsSelectedMachine',
          'Nothing selected: this client can use no models.'
        ),
        prompts: t(
          'admin.auth.oauth.noPromptsSelectedMachine',
          'Nothing selected: this client can use no prompts.'
        )
      }[kind];
    }
    if (delegatedClient && !machineClient) {
      return {
        apps: t(
          'admin.auth.oauth.noAppsSelectedDelegated',
          'Nothing selected: no client-level restriction (users keep the apps their groups allow).'
        ),
        models: t(
          'admin.auth.oauth.noModelsSelectedDelegated',
          'Nothing selected: no client-level restriction (users keep the models their groups allow).'
        ),
        prompts: t(
          'admin.auth.oauth.noPromptsSelectedDelegated',
          'Nothing selected: no client-level restriction (users keep the prompts their groups allow).'
        )
      }[kind];
    }
    return {
      apps: t(
        'admin.auth.oauth.noAppsSelected',
        'No apps selected — no client-level restriction (user keeps full group permissions; machine-to-machine tokens get no apps)'
      ),
      models: t(
        'admin.auth.oauth.noModelsSelected',
        'No models selected — no client-level restriction (user keeps full group permissions; machine-to-machine tokens get no models)'
      ),
      prompts: t(
        'admin.auth.oauth.noPromptsSelected',
        'No prompts selected — no client-level restriction (user keeps full group permissions; machine-to-machine tokens get no prompts)'
      )
    }[kind];
  };

  /**
   * A warning shown under a list set to "All (*)". On a machine client it then
   * reaches every resource of that kind; on a user-delegated client (or a
   * personal key) it sets no client-level limit, so its users reach everything
   * their groups allow. Both include resources added later.
   *
   * @param {string[]} list - The resource list.
   * @returns {JSX.Element|null} The warning, or null when it does not apply.
   */
  const renderAllWarning = list =>
    grantsAll(list) ? (
      <p role="note" className="mt-2 flex items-start text-sm text-amber-800 dark:text-amber-200">
        <Icon name="warning" size="sm" className="mr-2 mt-0.5 shrink-0" />
        {machineClient
          ? t(
              'admin.auth.oauth.allGrantWarning',
              'All (*) gives this client-credentials client every item of this kind, including items added later. Prefer listing only what it needs.'
            )
          : t(
              'admin.auth.oauth.allGrantWarningDelegated',
              'All (*) sets no client-level limit: users of this client reach every item of this kind their groups allow, including items added later. Prefer listing only what it needs.'
            )}
      </p>
    ) : null;

  /**
   * A non-blocking warning about a machine client's lists (see
   * `clientGrantWarnings`), shown under the list it is about.
   *
   * @param {string} key - The warning's i18n key.
   * @returns {JSX.Element|null} The warning, or null when it is not raised.
   */
  const renderGrantWarning = key => {
    if (!grantWarnings.includes(key)) return null;
    const text = {
      'admin.auth.oauth.machineClientHasNoGrant': t(
        'admin.auth.oauth.machineClientHasNoGrant',
        'This client-credentials client has no apps, models or prompts, so its tokens can do nothing. Select what it may use, or choose "All (*)".'
      ),
      'admin.auth.oauth.machineClientHasNoModels': t(
        'admin.auth.oauth.machineClientHasNoModels',
        'This client has apps but no models. Every app call needs a model the client may use, so these calls will fail. Select the models it may use, or choose "All (*)".'
      )
    }[key];
    return (
      <p role="note" className="mt-2 flex items-start text-sm text-amber-800 dark:text-amber-200">
        <Icon name="warning" size="sm" className="mr-2 mt-0.5 shrink-0" />
        {text}
      </p>
    );
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-6">
          <AdminBreadcrumb
            crumbs={[
              { label: 'Admin', href: '/admin' },
              { label: 'OAuth', href: '/admin/oauth/clients' },
              { label: isNew ? 'New Client' : (formData?.name ?? clientId) }
            ]}
          />
        </div>
        {/* Header */}
        <div className="bg-white dark:bg-gray-800 shadow-xs border-b border-gray-200 dark:border-gray-700">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div className="flex items-center">
              <button
                onClick={() => navigate('/admin/oauth/clients')}
                className="mr-4 text-gray-500 dark:text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
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
                    message.type === 'success' ? 'text-green-500' : 'text-red-700'
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
            className="bg-white dark:bg-gray-800 shadow-sm rounded-lg p-6 space-y-6"
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
                    className="mt-1 block w-full border border-admin-control-border rounded-md shadow-xs py-2 px-3 focus:outline-hidden focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
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
                    className="mt-1 block w-full border border-admin-control-border rounded-md shadow-xs py-2 px-3 focus:outline-hidden focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
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
                    className="mt-1 block w-full border border-admin-control-border rounded-md shadow-xs py-2 px-3 focus:outline-hidden focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
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
                    className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded-sm"
                  />
                  <label
                    htmlFor="active"
                    className="ml-2 block text-sm text-gray-900 dark:text-gray-100"
                  >
                    {t('admin.auth.oauth.active', 'Active')}
                  </label>
                </div>
              </div>
            </div>

            {/* Permissions hint */}
            <div className="rounded-md border border-blue-200 bg-blue-50 dark:bg-blue-900/20 dark:border-blue-800 p-4 text-sm text-blue-900 dark:text-blue-200">
              <div className="flex items-start">
                <Icon name="info" size="sm" className="mr-2 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium mb-1">
                    {t('admin.auth.oauth.permissionsHintTitle', 'How Resource Restrictions Work')}
                  </p>
                  {machineClient && (
                    <p>
                      {t(
                        'admin.auth.oauth.permissionsHintMachine',
                        'Client credentials (machine-to-machine): there is no user behind the token, so these lists ARE the grant. The client can use exactly the apps, models and prompts listed here, and none of a kind whose list is empty. "All (*)" grants every one, including ones added later.'
                      )}
                    </p>
                  )}
                  {personal && (
                    <p>
                      {t(
                        'admin.auth.oauth.permissionsHintPersonal',
                        'Personal API key: the token acts as the user who owns the key. These lists narrow what that user\'s groups allow; an empty list adds no restriction. "All (*)" sets no limit, so the key reaches everything the owner\'s groups allow, including items added later.'
                      )}
                    </p>
                  )}
                  {delegatedClient && !personal && (
                    <p className={machineClient ? 'mt-2' : undefined}>
                      {t(
                        'admin.auth.oauth.permissionsHintDelegated',
                        'Authorization code (user login): the token acts as the signed-in user. These lists narrow what that user\'s groups allow; an empty list adds no restriction. "All (*)" sets no limit, so users reach everything their groups allow, including items added later.'
                      )}
                    </p>
                  )}
                  {!machineClient && !delegatedClient && (
                    <p>
                      {t(
                        'admin.auth.oauth.permissionsHintNoGrant',
                        "Select a grant type below. For client credentials these lists are the grant; for authorization code they narrow the signed-in user's permissions."
                      )}
                    </p>
                  )}
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
                emptyMessage={emptyListMessage('apps')}
                allowWildcard={true}
              />
              {renderAllWarning(formData.allowedApps)}
              {renderGrantWarning('admin.auth.oauth.machineClientHasNoGrant')}
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
                emptyMessage={emptyListMessage('models')}
                allowWildcard={true}
              />
              {renderAllWarning(formData.allowedModels)}
              {renderGrantWarning('admin.auth.oauth.machineClientHasNoModels')}
            </div>

            {/* Allowed Prompts */}
            <div>
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                {t('admin.auth.oauth.allowedPrompts', 'Allowed Prompts')}
              </h3>
              <ResourceSelector
                label={t('admin.auth.oauth.allowedPrompts', 'Allowed Prompts')}
                resources={availablePrompts}
                selectedResources={formData.allowedPrompts}
                onSelectionChange={handlePromptsChange}
                placeholder={t('admin.auth.oauth.searchPrompts', 'Search prompts to add...')}
                emptyMessage={emptyListMessage('prompts')}
                allowWildcard={true}
              />
              {renderAllWarning(formData.allowedPrompts)}
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
                    className="mt-1 block w-full border border-admin-control-border rounded-md shadow-xs py-2 px-3 focus:outline-hidden focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
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
                  {grantTypesEdited && (
                    <div
                      role="alert"
                      className="mb-3 rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800 p-3 text-sm text-amber-900 dark:text-amber-200"
                    >
                      {t(
                        'admin.auth.oauth.grantTypesChangedWarning',
                        'You changed the grant types, which changes what the allowed apps, models and prompts mean. For client-credentials tokens an empty list means nothing and the lists are the full grant; for authorization-code tokens an empty list means no extra restriction. Review the lists above before saving.'
                      )}
                    </div>
                  )}
                  <div className="space-y-2">
                    {['client_credentials', 'authorization_code', 'refresh_token'].map(grant => (
                      <label key={grant} className="flex items-center">
                        <input
                          type="checkbox"
                          checked={(formData.grantTypes || []).includes(grant)}
                          onChange={() => handleGrantTypeToggle(grant)}
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded-sm"
                        />
                        <span className="ml-2 text-sm text-gray-700 dark:text-gray-300">
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
                            <code className="flex-1 bg-gray-100 px-2 py-1 rounded-sm text-sm">
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
                            aria-invalid={uriErrors.redirectUris ? 'true' : undefined}
                            aria-describedby={
                              uriErrors.redirectUris ? 'redirectUris-error' : undefined
                            }
                            placeholder={t(
                              'admin.auth.oauth.redirectUriPlaceholder',
                              'https://yourapp.com/callback'
                            )}
                            className="flex-1 border border-admin-control-border rounded-md shadow-xs py-2 px-3 focus:outline-hidden focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                if (handleRedirectUriAdd('redirectUris', redirectUriInput)) {
                                  setRedirectUriInput('');
                                }
                              }
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => {
                              if (handleRedirectUriAdd('redirectUris', redirectUriInput)) {
                                setRedirectUriInput('');
                              }
                            }}
                            className="px-3 py-2 border border-gray-300 rounded-md text-sm hover:bg-gray-50"
                          >
                            {t('common.add', 'Add')}
                          </button>
                        </div>
                        {uriErrors.redirectUris && (
                          <p
                            id="redirectUris-error"
                            role="alert"
                            className="text-sm text-red-700 dark:text-red-300"
                          >
                            {uriErrors.redirectUris}
                          </p>
                        )}
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
                            <code className="flex-1 bg-gray-100 px-2 py-1 rounded-sm text-sm">
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
                            aria-invalid={uriErrors.postLogoutRedirectUris ? 'true' : undefined}
                            aria-describedby={
                              uriErrors.postLogoutRedirectUris
                                ? 'postLogoutRedirectUris-error'
                                : undefined
                            }
                            placeholder={t(
                              'admin.auth.oauth.postLogoutUriPlaceholder',
                              'https://yourapp.com/logged-out'
                            )}
                            className="flex-1 border border-admin-control-border rounded-md shadow-xs py-2 px-3 focus:outline-hidden focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                if (
                                  handleRedirectUriAdd('postLogoutRedirectUris', postLogoutUriInput)
                                ) {
                                  setPostLogoutUriInput('');
                                }
                              }
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => {
                              if (
                                handleRedirectUriAdd('postLogoutRedirectUris', postLogoutUriInput)
                              ) {
                                setPostLogoutUriInput('');
                              }
                            }}
                            className="px-3 py-2 border border-gray-300 rounded-md text-sm hover:bg-gray-50"
                          >
                            {t('common.add', 'Add')}
                          </button>
                        </div>
                        {uriErrors.postLogoutRedirectUris && (
                          <p
                            id="postLogoutRedirectUris-error"
                            role="alert"
                            className="text-sm text-red-700 dark:text-red-300"
                          >
                            {uriErrors.postLogoutRedirectUris}
                          </p>
                        )}
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
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded-sm"
                        />
                        <label
                          htmlFor="consentRequired"
                          className="ml-2 block text-sm text-gray-900 dark:text-gray-100"
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
                          className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded-sm"
                        />
                        <label
                          htmlFor="trusted"
                          className="ml-2 block text-sm text-gray-900 dark:text-gray-100"
                        >
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
                className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-xs text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 border border-transparent rounded-md shadow-xs text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
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

      <UnsavedChangesDialog blocker={blocker} />

      {/* The new client's secret, shown once (ID-B15). The secret leaves state on Done. */}
      <SecretRevealDialog
        isOpen={showSecretModal}
        title={t('admin.auth.oauth.secretReveal.createdTitle', {
          name: formData.name || newClientId,
          defaultValue: 'Client "{{name}}" created'
        })}
        description={
          <p>
            {t('admin.auth.oauth.clientId', 'Client ID')}:{' '}
            <code className="font-mono break-all text-gray-900 dark:text-gray-100">
              {newClientId}
            </code>
          </p>
        }
        fieldLabel={t('admin.auth.oauth.clientSecret', 'Client Secret')}
        secret={newClientSecret}
        onDone={handleModalClose}
      />
    </>
  );
}

export default AdminOAuthClientEditPage;
