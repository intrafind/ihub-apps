import React, { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../utils/localizeContent';
import Icon from '../components/Icon';

const AdminModelEditPage = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const { modelId } = useParams();
  const isNewModel = modelId === 'new';
  
  const [loading, setLoading] = useState(!isNewModel);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(false);
  const [apps, setApps] = useState([]);
  const [usage, setUsage] = useState(null);
  
  const [formData, setFormData] = useState({
    id: '',
    modelId: '',
    name: '',
    description: '',
    url: '',
    provider: '',
    tokenLimit: '',
    supportsTools: false,
    enabled: true,
    default: false,
    concurrency: '',
    requestDelayMs: ''
  });

  useEffect(() => {
    if (isNewModel) {
      setLoading(false);
    } else {
      loadModel();
    }
    loadAppsUsingModel();
    loadUsageData();
  }, [modelId]);

  const loadModel = async () => {
    try {
      setLoading(true);
      const response = await fetch(`/api/admin/models/${modelId}`);
      if (!response.ok) {
        throw new Error('Model not found');
      }
      const model = await response.json();
      setFormData({
        id: model.id || '',
        modelId: model.modelId || '',
        name: model.name || '',
        description: model.description || '',
        url: model.url || '',
        provider: model.provider || '',
        tokenLimit: model.tokenLimit || '',
        supportsTools: model.supportsTools || false,
        enabled: model.enabled !== undefined ? model.enabled : true,
        default: model.default || false,
        concurrency: model.concurrency || '',
        requestDelayMs: model.requestDelayMs || ''
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadAppsUsingModel = async () => {
    try {
      const response = await fetch('/api/admin/apps');
      if (response.ok) {
        const allApps = await response.json();
        const appsUsingModel = allApps.filter(app => app.preferredModel === modelId);
        setApps(appsUsingModel);
      }
    } catch (err) {
      console.error('Error loading apps:', err);
    }
  };

  const loadUsageData = async () => {
    try {
      const response = await fetch('/api/admin/usage');
      if (response.ok) {
        const usageData = await response.json();
        if (usageData.messages && usageData.messages.perModel && usageData.messages.perModel[modelId]) {
          setUsage({
            messages: usageData.messages.perModel[modelId],
            tokens: usageData.tokens.perModel[modelId] || 0
          });
        }
      }
    } catch (err) {
      console.error('Error loading usage data:', err);
    }
  };

  const handleChange = (e) => {
    const { name, value, type, checked } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    try {
      setSaving(true);
      setError(null);
      
      // Validate required fields
      if (!formData.id || !formData.name || !formData.description || !formData.provider) {
        throw new Error('Please fill in all required fields');
      }
      
      // Prepare the data to send
      const dataToSend = {
        ...formData,
        tokenLimit: formData.tokenLimit ? parseInt(formData.tokenLimit) : undefined,
        concurrency: formData.concurrency ? parseInt(formData.concurrency) : undefined,
        requestDelayMs: formData.requestDelayMs ? parseInt(formData.requestDelayMs) : undefined
      };
      
      // Remove empty fields
      Object.keys(dataToSend).forEach(key => {
        if (dataToSend[key] === '' || dataToSend[key] === undefined) {
          delete dataToSend[key];
        }
      });
      
      const url = isNewModel ? '/api/admin/models' : `/api/admin/models/${modelId}`;
      const method = isNewModel ? 'POST' : 'PUT';
      
      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(dataToSend),
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to save model');
      }
      
      setSuccess(true);
      
      // Redirect after a short delay
      setTimeout(() => {
        navigate('/admin/models');
      }, 1500);
      
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const providerOptions = [
    { value: 'openai', label: 'OpenAI' },
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'google', label: 'Google' },
    { value: 'mistral', label: 'Mistral' },
    { value: 'local', label: 'Local' },
  ];

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading model...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between py-6">
            <div className="flex items-center gap-4">
              <button
                onClick={() => navigate('/admin/models')}
                className="p-2 text-gray-600 hover:text-gray-900"
              >
                <Icon name="arrow-left" className="w-5 h-5" />
              </button>
              <div>
                <h1 className="text-2xl font-bold text-gray-900">
                  {isNewModel ? 'Add New Model' : 'Edit Model'}
                </h1>
                <p className="text-gray-600">
                  {isNewModel ? 'Configure a new AI model' : `Configure ${formData.name}`}
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Main Form */}
          <div className="lg:col-span-2">
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-lg font-medium text-gray-900 mb-4">Basic Information</h2>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Model ID *
                    </label>
                    <input
                      type="text"
                      name="id"
                      value={formData.id}
                      onChange={handleChange}
                      disabled={!isNewModel}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                      required
                    />
                    <p className="text-xs text-gray-500 mt-1">Unique identifier for the model</p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Model Name *
                    </label>
                    <input
                      type="text"
                      name="name"
                      value={formData.name}
                      onChange={handleChange}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      required
                    />
                  </div>

                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Description *
                    </label>
                    <textarea
                      name="description"
                      value={formData.description}
                      onChange={handleChange}
                      rows={3}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      required
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Provider *
                    </label>
                    <select
                      name="provider"
                      value={formData.provider}
                      onChange={handleChange}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      required
                    >
                      <option value="">Select provider</option>
                      {providerOptions.map(option => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Model ID (API)
                    </label>
                    <input
                      type="text"
                      name="modelId"
                      value={formData.modelId}
                      onChange={handleChange}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="e.g., gpt-4"
                    />
                    <p className="text-xs text-gray-500 mt-1">API model identifier</p>
                  </div>

                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      API URL
                    </label>
                    <input
                      type="url"
                      name="url"
                      value={formData.url}
                      onChange={handleChange}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="https://api.openai.com/v1/chat/completions"
                    />
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-lg font-medium text-gray-900 mb-4">Configuration</h2>
                
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Token Limit
                    </label>
                    <input
                      type="number"
                      name="tokenLimit"
                      value={formData.tokenLimit}
                      onChange={handleChange}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      min="1"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Concurrency
                    </label>
                    <input
                      type="number"
                      name="concurrency"
                      value={formData.concurrency}
                      onChange={handleChange}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      min="1"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Request Delay (ms)
                    </label>
                    <input
                      type="number"
                      name="requestDelayMs"
                      value={formData.requestDelayMs}
                      onChange={handleChange}
                      className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                      min="0"
                    />
                  </div>
                </div>

                <div className="mt-4 space-y-3">
                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      name="supportsTools"
                      checked={formData.supportsTools}
                      onChange={handleChange}
                      className="rounded border-gray-300 text-blue-600 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                    />
                    <span className="ml-2 text-sm text-gray-700">Supports Tools</span>
                  </label>

                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      name="enabled"
                      checked={formData.enabled}
                      onChange={handleChange}
                      className="rounded border-gray-300 text-blue-600 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                    />
                    <span className="ml-2 text-sm text-gray-700">Enabled</span>
                  </label>

                  <label className="flex items-center">
                    <input
                      type="checkbox"
                      name="default"
                      checked={formData.default}
                      onChange={handleChange}
                      className="rounded border-gray-300 text-blue-600 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                    />
                    <span className="ml-2 text-sm text-gray-700">Default Model</span>
                  </label>
                </div>
              </div>

              {/* Actions */}
              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => navigate('/admin/models')}
                    className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
                  >
                    {saving ? 'Saving...' : isNewModel ? 'Create Model' : 'Save Changes'}
                  </button>
                </div>
              </div>
            </form>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Usage Stats */}
            {!isNewModel && (
              <div className="bg-white rounded-lg shadow p-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Usage Statistics</h3>
                {usage ? (
                  <div className="space-y-3">
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-600">Messages:</span>
                      <span className="text-sm font-medium">{usage.messages?.toLocaleString() || 0}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-sm text-gray-600">Tokens:</span>
                      <span className="text-sm font-medium">{usage.tokens?.toLocaleString() || 0}</span>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">No usage data available</p>
                )}
              </div>
            )}

            {/* Apps Using Model */}
            {!isNewModel && (
              <div className="bg-white rounded-lg shadow p-6">
                <h3 className="text-lg font-medium text-gray-900 mb-4">Apps Using This Model</h3>
                {apps.length > 0 ? (
                  <div className="space-y-2">
                    {apps.map(app => (
                      <div key={app.id} className="flex items-center justify-between p-2 bg-gray-50 rounded">
                        <span className="text-sm font-medium">{getLocalizedContent(app.name, currentLanguage)}</span>
                        <span className={`text-xs px-2 py-1 rounded-full ${
                          app.enabled ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                        }`}>
                          {app.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500">No apps are using this model as preferred</p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Status Messages */}
        {error && (
          <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-md">
            <div className="flex items-center">
              <Icon name="x-circle" className="w-5 h-5 text-red-600 mr-2" />
              <span className="text-red-800">{error}</span>
            </div>
          </div>
        )}

        {success && (
          <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded-md">
            <div className="flex items-center">
              <Icon name="check-circle" className="w-5 h-5 text-green-600 mr-2" />
              <span className="text-green-800">
                Model {isNewModel ? 'created' : 'updated'} successfully! Redirecting...
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default AdminModelEditPage;