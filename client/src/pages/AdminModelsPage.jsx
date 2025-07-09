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
    if (!confirm('Are you sure you want to delete this model?')) {
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
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading models...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="text-red-600 text-xl mb-4">Error loading models</div>
          <p className="text-gray-600">{error}</p>
          <button 
            onClick={loadModels}
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center py-6">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">Model Management</h1>
              <p className="text-gray-600 mt-1">Configure and manage AI models</p>
            </div>
            <button 
              onClick={() => navigate('/admin/models/new')}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2"
            >
              <Icon name="plus" className="w-4 h-4" />
              Add New Model
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Icon name="server" className="w-6 h-6 text-blue-600" />
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-600">Total Models</p>
                <p className="text-2xl font-bold text-gray-900">{models.length}</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center">
              <div className="p-2 bg-green-100 rounded-lg">
                <Icon name="check-circle" className="w-6 h-6 text-green-600" />
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-600">Enabled</p>
                <p className="text-2xl font-bold text-gray-900">{enabledCount}</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center">
              <div className="p-2 bg-red-100 rounded-lg">
                <Icon name="x-circle" className="w-6 h-6 text-red-600" />
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-600">Disabled</p>
                <p className="text-2xl font-bold text-gray-900">{disabledCount}</p>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex items-center">
              <div className="p-2 bg-yellow-100 rounded-lg">
                <Icon name="star" className="w-6 h-6 text-yellow-600" />
              </div>
              <div className="ml-4">
                <p className="text-sm font-medium text-gray-600">Default</p>
                <p className="text-lg font-bold text-gray-900">{defaultModel?.name || 'None'}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Search and Filter */}
        <div className="bg-white rounded-lg shadow mb-6">
          <div className="p-6 border-b border-gray-200">
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="flex-1">
                <div className="relative">
                  <Icon name="search" className="absolute left-3 top-3 w-5 h-5 text-gray-400" />
                  <input
                    type="text"
                    placeholder="Search models..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <select
                  value={filterEnabled}
                  onChange={(e) => setFilterEnabled(e.target.value)}
                  className="px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="all">All Models</option>
                  <option value="enabled">Enabled Only</option>
                  <option value="disabled">Disabled Only</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* Models List */}
        <div className="bg-white rounded-lg shadow">
          <div className="p-6">
            <div className="space-y-4">
              {filteredModels.map((model) => (
                <div key={model.id} className="border border-gray-200 rounded-lg p-4 hover:bg-gray-50 cursor-pointer" onClick={() => handleModelClick(model)}>
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-3">
                        <h3 className="text-lg font-medium text-gray-900">{model.name}</h3>
                        {model.default && (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
                            Default
                          </span>
                        )}
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          model.enabled 
                            ? 'bg-green-100 text-green-800' 
                            : 'bg-red-100 text-red-800'
                        }`}>
                          {model.enabled ? 'Enabled' : 'Disabled'}
                        </span>
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                          {model.provider}
                        </span>
                      </div>
                      <p className="text-sm text-gray-600 mt-1">{model.description}</p>
                      <div className="flex items-center gap-4 mt-2 text-sm text-gray-500">
                        <span>ID: {model.id}</span>
                        <span>Token Limit: {model.tokenLimit?.toLocaleString() || 'N/A'}</span>
                        <span>Tools: {model.supportsTools ? 'Supported' : 'Not Supported'}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          testModel(model.id);
                        }}
                        disabled={testingModel === model.id}
                        className={`px-3 py-1 text-sm rounded ${
                          testingModel === model.id
                            ? 'bg-gray-200 text-gray-500 cursor-not-allowed'
                            : 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                        }`}
                      >
                        {testingModel === model.id ? 'Testing...' : 'Test'}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleModel(model.id);
                        }}
                        className={`px-3 py-1 text-sm rounded ${
                          model.enabled
                            ? 'bg-red-100 text-red-700 hover:bg-red-200'
                            : 'bg-green-100 text-green-700 hover:bg-green-200'
                        }`}
                      >
                        {model.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          navigate(`/admin/models/${model.id}`);
                        }}
                        className="px-3 py-1 bg-gray-100 text-gray-700 text-sm rounded hover:bg-gray-200"
                      >
                        Edit
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteModel(model.id);
                        }}
                        className="px-3 py-1 bg-red-100 text-red-700 text-sm rounded hover:bg-red-200"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  
                  {/* Test Results */}
                  {testResults[model.id] && (
                    <div className={`mt-3 p-3 rounded-lg ${
                      testResults[model.id].success 
                        ? 'bg-green-50 border border-green-200' 
                        : 'bg-red-50 border border-red-200'
                    }`}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Icon 
                            name={testResults[model.id].success ? "check-circle" : "x-circle"} 
                            className={`w-4 h-4 ${
                              testResults[model.id].success ? 'text-green-600' : 'text-red-600'
                            }`} 
                          />
                          <span className={`text-sm font-medium ${
                            testResults[model.id].success ? 'text-green-800' : 'text-red-800'
                          }`}>
                            {testResults[model.id].message}
                          </span>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            closeTestResult(model.id);
                          }}
                          className="p-1 hover:bg-gray-200 rounded"
                        >
                          <Icon name="x" className="w-4 h-4 text-gray-500" />
                        </button>
                      </div>
                      {testResults[model.id].response && (
                        <div className="mt-2 text-sm text-gray-600">
                          <strong>Response:</strong> {testResults[model.id].response}
                        </div>
                      )}
                      {testResults[model.id].error && (
                        <div className="mt-2 text-sm text-red-600">
                          <strong>Error:</strong> {testResults[model.id].error}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {filteredModels.length === 0 && (
          <div className="text-center py-12">
            <Icon name="server" className="w-16 h-16 text-gray-400 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No models found</h3>
            <p className="text-gray-500">
              {searchTerm ? 'Try adjusting your search terms.' : 'Get started by adding a new model.'}
            </p>
          </div>
        )}
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