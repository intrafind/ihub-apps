import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
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
  const [newClientSecret, setNewClientSecret] = useState('');
  const [showSecretModal, setShowSecretModal] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    scopes: [],
    allowedApps: [],
    allowedModels: [],
    tokenExpirationMinutes: 60,
    active: true
  });

  const [scopeInput, setScopeInput] = useState('');
  const [appInput, setAppInput] = useState('');
  const [modelInput, setModelInput] = useState('');

  useEffect(() => {
    if (!isNew) {
      loadClient();
    }
  }, [clientId]);

  const loadClient = async () => {
    try {
      const response = await makeAdminApiCall(`/admin/oauth/clients/${clientId}`);
      const data = response.data;

      setFormData({
        name: data.client.name || '',
        description: data.client.description || '',
        scopes: data.client.scopes || [],
        allowedApps: data.client.allowedApps || [],
        allowedModels: data.client.allowedModels || [],
        tokenExpirationMinutes: data.client.tokenExpirationMinutes || 60,
        active: data.client.active !== false
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

  const addScope = () => {
    if (scopeInput.trim() && !formData.scopes.includes(scopeInput.trim())) {
      setFormData(prev => ({
        ...prev,
        scopes: [...prev.scopes, scopeInput.trim()]
      }));
      setScopeInput('');
    }
  };

  const removeScope = scope => {
    setFormData(prev => ({
      ...prev,
      scopes: prev.scopes.filter(s => s !== scope)
    }));
  };

  const addApp = () => {
    if (appInput.trim() && !formData.allowedApps.includes(appInput.trim())) {
      setFormData(prev => ({
        ...prev,
        allowedApps: [...prev.allowedApps, appInput.trim()]
      }));
      setAppInput('');
    }
  };

  const removeApp = app => {
    setFormData(prev => ({
      ...prev,
      allowedApps: prev.allowedApps.filter(a => a !== app)
    }));
  };

  const addModel = () => {
    if (modelInput.trim() && !formData.allowedModels.includes(modelInput.trim())) {
      setFormData(prev => ({
        ...prev,
        allowedModels: [...prev.allowedModels, modelInput.trim()]
      }));
      setModelInput('');
    }
  };

  const removeModel = model => {
    setFormData(prev => ({
      ...prev,
      allowedModels: prev.allowedModels.filter(m => m !== model)
    }));
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
        <div className="min-h-screen bg-gray-50 flex items-center justify-center">
          <LoadingSpinner size="lg" />
        </div>
      </AdminAuth>
    );
  }

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50">
        {/* Header */}
        <div className="bg-white shadow-sm border-b border-gray-200">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
            <div className="flex items-center">
              <button
                onClick={() => navigate('/admin/oauth/clients')}
                className="mr-4 text-gray-400 hover:text-gray-600"
              >
                <Icon name="arrow-left" size="md" />
              </button>
              <div>
                <h1 className="text-3xl font-bold text-gray-900">
                  {isNew
                    ? t('admin.auth.oauth.createClient', 'Create OAuth Client')
                    : t('admin.auth.oauth.editClient', 'Edit OAuth Client')}
                </h1>
                <p className="text-gray-600 mt-1">
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
                  ? 'bg-green-50 border border-green-200'
                  : 'bg-red-50 border border-red-200'
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
                    message.type === 'success' ? 'text-green-700' : 'text-red-700'
                  }`}
                >
                  {message.text}
                </p>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="bg-white shadow rounded-lg p-6 space-y-6">
            {/* Basic Information */}
            <div>
              <h3 className="text-lg font-medium text-gray-900 mb-4">
                {t('common.basicInfo', 'Basic Information')}
              </h3>
              <div className="space-y-4">
                <div>
                  <label htmlFor="name" className="block text-sm font-medium text-gray-700">
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
                  <label htmlFor="description" className="block text-sm font-medium text-gray-700">
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
                    className="block text-sm font-medium text-gray-700"
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
                  <p className="mt-1 text-sm text-gray-500">
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

            {/* Scopes */}
            <div>
              <h3 className="text-lg font-medium text-gray-900 mb-4">
                {t('admin.auth.oauth.scopes', 'Scopes')}
              </h3>
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={scopeInput}
                    onChange={e => setScopeInput(e.target.value)}
                    onKeyPress={e => e.key === 'Enter' && (e.preventDefault(), addScope())}
                    placeholder="e.g., chat, models, apps"
                    className="flex-1 border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                  />
                  <button
                    type="button"
                    onClick={addScope}
                    className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                  >
                    {t('common.add', 'Add')}
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {formData.scopes.map(scope => (
                    <span
                      key={scope}
                      className="inline-flex items-center px-3 py-1 rounded-full text-sm bg-blue-100 text-blue-800"
                    >
                      {scope}
                      <button
                        type="button"
                        onClick={() => removeScope(scope)}
                        className="ml-2 text-blue-600 hover:text-blue-800"
                      >
                        <Icon name="x" size="sm" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Allowed Apps */}
            <div>
              <h3 className="text-lg font-medium text-gray-900 mb-4">
                {t('admin.auth.oauth.allowedApps', 'Allowed Apps')}
              </h3>
              <p className="text-sm text-gray-500 mb-2">Leave empty to allow all apps</p>
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={appInput}
                    onChange={e => setAppInput(e.target.value)}
                    onKeyPress={e => e.key === 'Enter' && (e.preventDefault(), addApp())}
                    placeholder="e.g., chat, summarizer"
                    className="flex-1 border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                  />
                  <button
                    type="button"
                    onClick={addApp}
                    className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                  >
                    {t('common.add', 'Add')}
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {formData.allowedApps.map(app => (
                    <span
                      key={app}
                      className="inline-flex items-center px-3 py-1 rounded-full text-sm bg-green-100 text-green-800"
                    >
                      {app}
                      <button
                        type="button"
                        onClick={() => removeApp(app)}
                        className="ml-2 text-green-600 hover:text-green-800"
                      >
                        <Icon name="x" size="sm" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Allowed Models */}
            <div>
              <h3 className="text-lg font-medium text-gray-900 mb-4">
                {t('admin.auth.oauth.allowedModels', 'Allowed Models')}
              </h3>
              <p className="text-sm text-gray-500 mb-2">Leave empty to allow all models</p>
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={modelInput}
                    onChange={e => setModelInput(e.target.value)}
                    onKeyPress={e => e.key === 'Enter' && (e.preventDefault(), addModel())}
                    placeholder="e.g., gpt-4, claude-3"
                    className="flex-1 border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
                  />
                  <button
                    type="button"
                    onClick={addModel}
                    className="px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
                  >
                    {t('common.add', 'Add')}
                  </button>
                </div>
                <div className="flex flex-wrap gap-2">
                  {formData.allowedModels.map(model => (
                    <span
                      key={model}
                      className="inline-flex items-center px-3 py-1 rounded-full text-sm bg-purple-100 text-purple-800"
                    >
                      {model}
                      <button
                        type="button"
                        onClick={() => removeModel(model)}
                        className="ml-2 text-purple-600 hover:text-purple-800"
                      >
                        <Icon name="x" size="sm" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            </div>

            {/* Submit buttons */}
            <div className="flex justify-end space-x-4 pt-6 border-t border-gray-200">
              <button
                type="button"
                onClick={() => navigate('/admin/oauth/clients')}
                className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
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
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50 flex items-center justify-center">
          <div className="relative bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4">
            <div className="p-6">
              <div className="flex items-center mb-4">
                <Icon name="check" className="h-6 w-6 text-green-500 mr-3" />
                <h3 className="text-lg font-medium text-gray-900">
                  {t('admin.auth.oauth.createSuccess', 'OAuth client created successfully')}
                </h3>
              </div>

              <div className="bg-yellow-50 border border-yellow-200 rounded-md p-4 mb-4">
                <div className="flex">
                  <Icon name="warning" className="h-5 w-5 text-yellow-400 mr-3 mt-0.5" />
                  <div>
                    <h4 className="text-sm font-medium text-yellow-800">
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
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    {t('admin.auth.oauth.clientId', 'Client ID')}
                  </label>
                  <div className="flex gap-2">
                    <code className="flex-1 bg-gray-100 px-3 py-2 rounded text-sm break-all">
                      {clientId}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(clientId)}
                      className="px-3 py-2 border border-gray-300 rounded-md text-sm hover:bg-gray-50"
                    >
                      <Icon name="clipboard" size="sm" />
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    {t('admin.auth.oauth.clientSecret', 'Client Secret')}
                  </label>
                  <div className="flex gap-2">
                    <code className="flex-1 bg-gray-100 px-3 py-2 rounded text-sm break-all">
                      {newClientSecret}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(newClientSecret)}
                      className="px-3 py-2 border border-gray-300 rounded-md text-sm hover:bg-gray-50"
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
