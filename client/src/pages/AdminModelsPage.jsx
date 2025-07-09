import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../utils/localizeContent';
import Icon from '../components/Icon';
import ModelDetailsPopup from '../components/ModelDetailsPopup';

const AdminModelsPage = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterEnabled, setFilterEnabled] = useState('all'); // all, enabled, disabled
  const [testingModel, setTestingModel] = useState(null);
  const [testResults, setTestResults] = useState({});
  const [selectedModel, setSelectedModel] = useState(null);
  const [showModelDetails, setShowModelDetails] = useState(false);

  useEffect(() => {
    loadModels();
  }, []);

  const loadModels = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/admin/models');
      if (!response.ok) {
        throw new Error('Failed to load models');
      }
      const data = await response.json();
      setModels(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const toggleModel = async (modelId) => {
    try {
      const response = await fetch(`/api/admin/models/${modelId}/toggle`, {
        method: 'POST',
      });
      
      if (!response.ok) {
        throw new Error('Failed to toggle model');
      }
      
      const result = await response.json();
      
      // Update the model in the local state
      setModels(prevModels => 
        prevModels.map(model => 
          model.id === modelId 
            ? { ...model, enabled: result.enabled }
            : model
        )
      );
    } catch (err) {
      setError(err.message);
    }
  };

  const handleModelClick = (model) => {
    setSelectedModel(model);
    setShowModelDetails(true);
  };

  const closeTestResult = (modelId) => {
    setTestResults(prev => {
      const newResults = { ...prev };
      delete newResults[modelId];
      return newResults;
    });
  };

  const testModel = async (modelId) => {
    try {
      setTestingModel(modelId);
      const response = await fetch(`/api/admin/models/${modelId}/test`, {
        method: 'POST',
      });
      
      const result = await response.json();
      setTestResults(prev => ({
        ...prev,
        [modelId]: result
      }));
      
      // Auto-disappear after 5 seconds
      setTimeout(() => {
        closeTestResult(modelId);
      }, 5000);
    } catch (err) {
      console.error('Model test error:', err);
      let errorMessage = 'Unknown error occurred';
      
      if (err.message.includes('fetch failed')) {
        errorMessage = 'Network error: Unable to connect to the model service';
      } else if (err.message.includes('timeout')) {
        errorMessage = 'Request timeout: Model service is not responding';
      } else if (err.message.includes('ECONNREFUSED')) {
        errorMessage = 'Connection refused: Model service is not available';
      } else if (err.message.includes('ENOTFOUND')) {
        errorMessage = 'DNS error: Model service hostname not found';
      } else {
        errorMessage = `Network error: ${err.message}`;
      }
      
      setTestResults(prev => ({
        ...prev,
        [modelId]: { 
          success: false, 
          message: 'Model test failed',
          error: errorMessage
        }
      }));
      
      // Auto-disappear after 5 seconds
      setTimeout(() => {
        closeTestResult(modelId);
      }, 5000);
    } finally {
      setTestingModel(null);
    }
  };

  const deleteModel = async (modelId) => {
    if (!confirm(t('admin.models.delete.confirm'))) {
      return;
    }

    try {
      const response = await fetch(`/api/admin/models/${modelId}`, {
        method: 'DELETE',
      });
      
      if (!response.ok) {
        throw new Error('Failed to delete model');
      }
      
      // Remove the model from the local state
      setModels(prevModels => prevModels.filter(model => model.id !== modelId));
    } catch (err) {
      setError(err.message);
    }
  };

  const filteredModels = models.filter(model => {
    const matchesSearch = model.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         model.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         model.provider.toLowerCase().includes(searchTerm.toLowerCase());
    
    const matchesFilter = filterEnabled === 'all' || 
                         (filterEnabled === 'enabled' && model.enabled) ||
                         (filterEnabled === 'disabled' && !model.enabled);
    
    return matchesSearch && matchesFilter;
  });

  const enabledCount = models.filter(model => model.enabled).length;
  const disabledCount = models.filter(model => !model.enabled).length;
  const defaultModel = models.find(model => model.default);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">{t('app.loading')}</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <div className="text-center">
          <div className="text-red-600 text-xl mb-4">{t('common.error')}</div>
          <p className="text-gray-600">{error}</p>
          <button 
            onClick={loadModels}
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            {t('app.retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <div className="bg-white shadow">
        <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
          <div className="md:flex md:items-center md:justify-between">
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-bold text-gray-900">
                {t('admin.models.title')}
              </h1>
              <p className="mt-1 text-sm text-gray-500">
                {t('admin.models.subtitle')}
              </p>
            </div>
            <div className="mt-4 flex md:mt-0 md:ml-4">
              <button
                onClick={() => navigate('/admin/models/new')}
                className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="plus" className="w-4 h-4 mr-2" />
                {t('admin.models.addNew')}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto py-6 sm:px-6 lg:px-8">
        <div className="px-4 py-6 sm:px-0">
          {/* Search and Filter */}
          <div className="bg-white shadow rounded-lg mb-6">
            <div className="px-4 py-5 sm:p-6">
              <div className="sm:flex sm:items-center sm:justify-between">
                <div className="flex-1 min-w-0">
                  <div className="relative rounded-md shadow-sm">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Icon name="search" className="h-5 w-5 text-gray-400" />
                    </div>
                    <input
                      type="text"
                      placeholder={t('admin.models.searchPlaceholder')}
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                    />
                  </div>
                </div>
                <div className="mt-4 sm:mt-0 sm:ml-4 flex-shrink-0">
                  <select
                    value={filterEnabled}
                    onChange={(e) => setFilterEnabled(e.target.value)}
                    className="block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm py-2 px-3"
                  >
                    <option value="all">{t('admin.models.filterAll')}</option>
                    <option value="enabled">{t('admin.models.filterEnabled')}</option>
                    <option value="disabled">{t('admin.models.filterDisabled')}</option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4 mb-6">
            <div className="bg-white overflow-hidden shadow rounded-lg">
              <div className="p-5">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <Icon name="server" className="h-6 w-6 text-gray-400" />
                  </div>
                  <div className="ml-5 w-0 flex-1">
                    <dl>
                      <dt className="text-sm font-medium text-gray-500 truncate">
                        {t('admin.models.totalModels')}
                      </dt>
                      <dd className="text-lg font-medium text-gray-900">
                        {models.length}
                      </dd>
                    </dl>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white overflow-hidden shadow rounded-lg">
              <div className="p-5">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <Icon name="check-circle" className="h-6 w-6 text-green-400" />
                  </div>
                  <div className="ml-5 w-0 flex-1">
                    <dl>
                      <dt className="text-sm font-medium text-gray-500 truncate">
                        {t('admin.models.enabledModels')}
                      </dt>
                      <dd className="text-lg font-medium text-gray-900">
                        {enabledCount}
                      </dd>
                    </dl>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white overflow-hidden shadow rounded-lg">
              <div className="p-5">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <Icon name="x-circle" className="h-6 w-6 text-red-400" />
                  </div>
                  <div className="ml-5 w-0 flex-1">
                    <dl>
                      <dt className="text-sm font-medium text-gray-500 truncate">
                        {t('admin.models.disabledModels')}
                      </dt>
                      <dd className="text-lg font-medium text-gray-900">
                        {disabledCount}
                      </dd>
                    </dl>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-white overflow-hidden shadow rounded-lg">
              <div className="p-5">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <Icon name="star" className="h-6 w-6 text-yellow-400" />
                  </div>
                  <div className="ml-5 w-0 flex-1">
                    <dl>
                      <dt className="text-sm font-medium text-gray-500 truncate">
                        {t('admin.models.defaultModel')}
                      </dt>
                      <dd className="text-lg font-medium text-gray-900">
                        {defaultModel?.name || 'None'}
                      </dd>
                    </dl>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Models table */}
          <div className="hidden sm:block">
            <div className="flex flex-col">
              <div className="-my-2 overflow-x-auto sm:-mx-6 lg:-mx-8">
                <div className="py-2 align-middle inline-block min-w-full sm:px-6 lg:px-8">
                  <div className="shadow overflow-hidden border-b border-gray-200 sm:rounded-lg">
                    <table className="min-w-full divide-y divide-gray-200">
                      <thead className="bg-gray-50">
                        <tr>
                          <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            {t('admin.models.fields.name')}
                          </th>
                          <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            {t('admin.models.status.enabled')}
                          </th>
                          <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            {t('admin.models.fields.provider')}
                          </th>
                          <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                            {t('admin.models.fields.tokenLimit')}
                          </th>
                          <th scope="col" className="relative px-6 py-3">
                            <span className="sr-only">{t('admin.models.actions.test')}</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {filteredModels.map((model) => (
                          <tr key={model.id} className="hover:bg-gray-50 cursor-pointer" onClick={() => handleModelClick(model)}>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <div className="flex items-center">
                                <div className="flex-shrink-0 h-10 w-10">
                                  <div className="h-10 w-10 rounded-full bg-indigo-100 flex items-center justify-center">
                                    <Icon name="server" className="h-5 w-5 text-indigo-600" />
                                  </div>
                                </div>
                                <div className="ml-4">
                                  <div className="flex items-center">
                                    <div className="text-sm font-medium text-gray-900">{model.name}</div>
                                    {model.default && (
                                      <span className="ml-2 inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                                        {t('admin.models.status.default')}
                                      </span>
                                    )}
                                  </div>
                                  <div className="text-sm text-gray-500">{model.description}</div>
                                  <div className="text-xs text-gray-400">{model.id}</div>
                                </div>
                              </div>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap">
                              <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                                model.enabled 
                                  ? 'bg-green-100 text-green-800' 
                                  : 'bg-red-100 text-red-800'
                              }`}>
                                {model.enabled ? t('admin.models.status.enabled') : t('admin.models.status.disabled')}
                              </span>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                                {model.provider}
                              </span>
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                              {model.tokenLimit?.toLocaleString() || 'N/A'}
                            </td>
                            <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                              <div className="flex items-center justify-end space-x-2">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    testModel(model.id);
                                  }}
                                  disabled={testingModel === model.id}
                                  className={`p-2 rounded-full ${
                                    testingModel === model.id
                                      ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                                      : 'text-blue-600 hover:bg-blue-50'
                                  }`}
                                  title={testingModel === model.id ? t('admin.models.actions.testing') : t('admin.models.actions.test')}
                                >
                                  <Icon name={testingModel === model.id ? "clock" : "play"} className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleModel(model.id);
                                  }}
                                  className={`p-2 rounded-full ${
                                    model.enabled
                                      ? 'text-red-600 hover:bg-red-50'
                                      : 'text-green-600 hover:bg-green-50'
                                  }`}
                                  title={model.enabled ? t('admin.models.actions.disable') : t('admin.models.actions.enable')}
                                >
                                  <Icon name={model.enabled ? "x-circle" : "check-circle"} className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    navigate(`/admin/models/${model.id}`);
                                  }}
                                  className="p-2 text-gray-600 hover:bg-gray-50 rounded-full"
                                  title={t('admin.models.actions.edit')}
                                >
                                  <Icon name="pencil" className="w-4 h-4" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    deleteModel(model.id);
                                  }}
                                  className="p-2 text-red-600 hover:bg-red-50 rounded-full"
                                  title={t('admin.models.actions.delete')}
                                >
                                  <Icon name="trash" className="w-4 h-4" />
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Mobile Cards */}
          <div className="sm:hidden">
            <div className="bg-white shadow overflow-hidden sm:rounded-md">
              <ul className="divide-y divide-gray-200">
                {filteredModels.map((model) => (
                  <li key={model.id}>
                    <div className="px-4 py-4 flex items-center justify-between hover:bg-gray-50 cursor-pointer" onClick={() => handleModelClick(model)}>
                      <div className="flex items-center flex-1">
                        <div className="flex-shrink-0 h-10 w-10">
                          <div className="h-10 w-10 rounded-full bg-indigo-100 flex items-center justify-center">
                            <Icon name="server" className="h-5 w-5 text-indigo-600" />
                          </div>
                        </div>
                        <div className="ml-4 flex-1">
                          <div className="flex items-center flex-wrap gap-2">
                            <div className="text-sm font-medium text-gray-900">{model.name}</div>
                            {model.default && (
                              <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                                {t('admin.models.status.default')}
                              </span>
                            )}
                          </div>
                          <div className="text-sm text-gray-500 mt-1">{model.description}</div>
                          <div className="flex items-center gap-2 mt-2">
                            <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                              model.enabled 
                                ? 'bg-green-100 text-green-800' 
                                : 'bg-red-100 text-red-800'
                            }`}>
                              {model.enabled ? t('admin.models.status.enabled') : t('admin.models.status.disabled')}
                            </span>
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                              {model.provider}
                            </span>
                          </div>
                          <div className="text-xs text-gray-400 mt-1">
                            {model.id} • {model.tokenLimit?.toLocaleString() || 'N/A'} tokens
                          </div>
                        </div>
                      </div>
                    </div>
                    <div className="px-4 pb-4 flex items-center justify-center space-x-4">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          testModel(model.id);
                        }}
                        disabled={testingModel === model.id}
                        className={`flex items-center px-3 py-2 rounded-md text-sm font-medium ${
                          testingModel === model.id
                            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                            : 'text-blue-600 hover:bg-blue-50'
                        }`}
                      >
                        <Icon name={testingModel === model.id ? "clock" : "play"} className="w-4 h-4 mr-1" />
                        {testingModel === model.id ? t('admin.models.actions.testing') : t('admin.models.actions.test')}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleModel(model.id);
                        }}
                        className={`flex items-center px-3 py-2 rounded-md text-sm font-medium ${
                          model.enabled
                            ? 'text-red-600 hover:bg-red-50'
                            : 'text-green-600 hover:bg-green-50'
                        }`}
                      >
                        <Icon name={model.enabled ? "x-circle" : "check-circle"} className="w-4 h-4 mr-1" />
                        {model.enabled ? t('admin.models.actions.disable') : t('admin.models.actions.enable')}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/admin/models/${model.id}`);
                        }}
                        className="flex items-center px-3 py-2 text-gray-600 hover:bg-gray-50 rounded-md text-sm font-medium"
                      >
                        <Icon name="pencil" className="w-4 h-4 mr-1" />
                        {t('admin.models.actions.edit')}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteModel(model.id);
                        }}
                        className="flex items-center px-3 py-2 text-red-600 hover:bg-red-50 rounded-md text-sm font-medium"
                      >
                        <Icon name="trash" className="w-4 h-4 mr-1" />
                        {t('admin.models.actions.delete')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Test Results */}
          {Object.entries(testResults).map(([modelId, result]) => (
            <div key={modelId} className={`mt-4 p-4 rounded-lg ${
              result.success 
                ? 'bg-green-50 border border-green-200' 
                : 'bg-red-50 border border-red-200'
            }`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Icon 
                    name={result.success ? "check-circle" : "x-circle"} 
                    className={`w-5 h-5 ${
                      result.success ? 'text-green-600' : 'text-red-600'
                    }`} 
                  />
                  <span className={`text-sm font-medium ${
                    result.success ? 'text-green-800' : 'text-red-800'
                  }`}>
                    {result.success ? t('admin.models.test.success') : t('admin.models.test.failed')}
                  </span>
                </div>
                <button
                  onClick={() => closeTestResult(modelId)}
                  className="p-1 hover:bg-gray-200 rounded"
                >
                  <Icon name="x" className="w-4 h-4 text-gray-500" />
                </button>
              </div>
              {result.response && (
                <div className="mt-2 text-sm text-gray-600">
                  <strong>{t('admin.models.test.response')}</strong> {result.response}
                </div>
              )}
              {result.error && (
                <div className="mt-2 text-sm text-red-600">
                  <strong>{t('admin.models.test.error')}</strong> {result.error}
                </div>
              )}
            </div>
          ))}

          {filteredModels.length === 0 && (
            <div className="text-center py-12">
              <Icon name="server" className="w-12 h-12 text-gray-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 mb-2">{t('admin.models.noModelsFound')}</h3>
              <p className="text-gray-500">
                {searchTerm ? t('admin.models.noModelsFoundDesc') : t('admin.models.getStarted')}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Model Details Popup */}
      <ModelDetailsPopup
        model={selectedModel}
        isOpen={showModelDetails}
        onClose={() => setShowModelDetails(false)}
      />
    </div>
  );
};

export default AdminModelsPage;