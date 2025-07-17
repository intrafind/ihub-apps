import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../utils/localizeContent';
import Icon from './Icon';

const ModelDetailsPopup = ({ model, isOpen, onClose }) => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const [usage, setUsage] = useState(null);
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen && model) {
      loadModelData();
    }
  }, [isOpen, model]);

  const loadModelData = async() => {
    setLoading(true);
    try {
      // Load usage data
      const usageResponse = await fetch('/api/admin/usage');
      if (usageResponse.ok) {
        const usageData = await usageResponse.json();
        if (
          usageData.messages &&
          usageData.messages.perModel &&
          usageData.messages.perModel[model.id]
        ) {
          setUsage({
            messages: usageData.messages.perModel[model.id],
            tokens: usageData.tokens.perModel[model.id] || 0
          });
        }
      }

      // Load apps using this model
      const appsResponse = await fetch('/api/admin/apps');
      if (appsResponse.ok) {
        const allApps = await appsResponse.json();
        const appsUsingModel = allApps.filter(app => app.preferredModel === model.id);
        setApps(appsUsingModel);
      }
    } catch (error) {
      console.error('Error loading model data:', error);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen || !model) return null;

  const getProviderIcon = provider => {
    switch (provider) {
    case 'openai':
      return 'cpu-chip';
    case 'anthropic':
      return 'academic-cap';
    case 'google':
      return 'globe-alt';
    case 'mistral':
      return 'lightning-bolt';
    case 'local':
      return 'computer-desktop';
    default:
      return 'server';
    }
  };

  const getProviderColor = provider => {
    switch (provider) {
    case 'openai':
      return '#00A67E';
    case 'anthropic':
      return '#CC785C';
    case 'google':
      return '#4285F4';
    case 'mistral':
      return '#FF6B35';
    case 'local':
      return '#6B7280';
    default:
      return '#6B7280';
    }
  };

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50 flex items-center justify-center p-4">
      <div className="relative bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between rounded-t-lg">
          <div className="flex items-center space-x-3">
            <div
              className="w-12 h-12 rounded-lg flex items-center justify-center text-white font-bold"
              style={{ backgroundColor: getProviderColor(model.provider) }}
            >
              <Icon name={getProviderIcon(model.provider)} className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900">
                {getLocalizedContent(model.name, currentLanguage)}
              </h3>
              <p className="text-sm text-gray-500">{model.id}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
          >
            <Icon name="x" className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-6">
          {loading && (
            <div className="flex justify-center py-4">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
            </div>
          )}

          {/* Status and Default Model */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">
              {t('admin.models.details.status', 'Status')}
            </span>
            <div className="flex items-center space-x-2">
              {model.default && (
                <span className="inline-flex px-2 py-1 text-xs font-semibold rounded-full bg-blue-100 text-blue-800">
                  {t('admin.models.details.default', 'Default')}
                </span>
              )}
              <span
                className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                  model.enabled ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                }`}
              >
                {model.enabled
                  ? t('admin.models.status.enabled', 'Enabled')
                  : t('admin.models.status.disabled', 'Disabled')}
              </span>
            </div>
          </div>

          {/* Description */}
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-2">
              {t('admin.models.details.description', 'Description')}
            </h4>
            <p className="text-sm text-gray-600 leading-relaxed">
              {getLocalizedContent(model.description, currentLanguage)}
            </p>
          </div>

          {/* Technical Details */}
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-3">
              {t('admin.models.details.technicalDetails', 'Technical Details')}
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {t('admin.models.details.provider', 'Provider')}
                </div>
                <div className="text-sm text-gray-900 mt-1">{model.provider}</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {t('admin.models.details.modelId', 'Model ID')}
                </div>
                <div className="text-sm text-gray-900 mt-1">{model.modelId || 'Not specified'}</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {t('admin.models.details.tokenLimit', 'Token Limit')}
                </div>
                <div className="text-sm text-gray-900 mt-1">
                  {model.tokenLimit ? model.tokenLimit.toLocaleString() : 'Not set'}
                </div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {t('admin.models.details.supportsTools', 'Supports Tools')}
                </div>
                <div className="text-sm text-gray-900 mt-1">
                  {model.supportsTools ? 'Yes' : 'No'}
                </div>
              </div>
              {model.concurrency && (
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                    {t('admin.models.details.concurrency', 'Concurrency')}
                  </div>
                  <div className="text-sm text-gray-900 mt-1">{model.concurrency}</div>
                </div>
              )}
              {model.requestDelayMs && (
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                    {t('admin.models.details.requestDelay', 'Request Delay')}
                  </div>
                  <div className="text-sm text-gray-900 mt-1">{model.requestDelayMs}ms</div>
                </div>
              )}
            </div>
          </div>

          {/* API Configuration */}
          {model.url && (
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-2">
                {t('admin.models.details.apiConfiguration', 'API Configuration')}
              </h4>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">
                  {t('admin.models.details.apiUrl', 'API URL')}
                </div>
                <div className="text-sm text-gray-900 break-all">{model.url}</div>
              </div>
            </div>
          )}

          {/* Usage Statistics */}
          {usage && (
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-3">
                {t('admin.models.details.usageStats', 'Usage Statistics')}
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                    {t('admin.models.details.messages', 'Messages')}
                  </div>
                  <div className="text-sm text-gray-900 mt-1">
                    {usage.messages.toLocaleString()}
                  </div>
                </div>
                <div className="bg-gray-50 rounded-lg p-3">
                  <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                    {t('admin.models.details.tokens', 'Tokens')}
                  </div>
                  <div className="text-sm text-gray-900 mt-1">{usage.tokens.toLocaleString()}</div>
                </div>
              </div>
            </div>
          )}

          {/* Apps Using This Model */}
          {apps.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-3">
                {t('admin.models.details.appsUsingModel', 'Apps Using This Model')}
              </h4>
              <div className="space-y-2">
                {apps.map(app => (
                  <div key={app.id} className="bg-gray-50 rounded-lg p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <div
                          className="w-8 h-8 rounded-md flex items-center justify-center text-white text-xs font-bold"
                          style={{ backgroundColor: app.color || '#6B7280' }}
                        >
                          <Icon name={app.icon || 'chat-bubbles'} className="w-4 h-4" />
                        </div>
                        <div>
                          <div className="text-sm font-medium text-gray-900">
                            {getLocalizedContent(app.name, currentLanguage)}
                          </div>
                          <div className="text-xs text-gray-500">{app.id}</div>
                        </div>
                      </div>
                      <span
                        className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                          app.enabled ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                        }`}
                      >
                        {app.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* No Usage Data */}
          {!loading && !usage && (
            <div className="text-center py-4">
              <Icon name="chart-bar" className="w-12 h-12 text-gray-400 mx-auto mb-2" />
              <p className="text-sm text-gray-500">
                {t('admin.models.details.noUsageData', 'No usage data available')}
              </p>
            </div>
          )}

          {/* No Apps */}
          {!loading && apps.length === 0 && (
            <div className="text-center py-4">
              <Icon name="document-text" className="w-12 h-12 text-gray-400 mx-auto mb-2" />
              <p className="text-sm text-gray-500">
                {t(
                  'admin.models.details.noApps',
                  'No apps are using this model as their preferred choice'
                )}
              </p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-gray-50 border-t border-gray-200 px-6 py-4 flex justify-between items-center rounded-b-lg">
          <button
            onClick={() => {
              navigate(`/admin/models/${model.id}`);
              onClose();
            }}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            <Icon name="pencil" className="w-4 h-4 mr-2" />
            {t('admin.models.details.editModel')}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            {t('admin.models.details.close', 'Close')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ModelDetailsPopup;
