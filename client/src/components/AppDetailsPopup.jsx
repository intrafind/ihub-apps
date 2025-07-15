import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../utils/localizeContent';
import Icon from './Icon';

const AppDetailsPopup = ({ app, isOpen, onClose }) => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();

  if (!isOpen || !app) return null;

  const getLocalizedValue = content => {
    return getLocalizedContent(content, currentLanguage);
  };

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50 flex items-center justify-center p-4">
      <div className="relative bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between rounded-t-lg">
          <div className="flex items-center space-x-3">
            <div
              className="w-12 h-12 rounded-lg flex items-center justify-center text-white font-bold"
              style={{ backgroundColor: app.color || '#6B7280' }}
            >
              <Icon name={app.icon || 'chat-bubbles'} className="w-6 h-6" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900">{getLocalizedValue(app.name)}</h3>
              <p className="text-sm text-gray-500">{app.id}</p>
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
          {/* Status */}
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">
              {t('admin.apps.details.status', 'Status')}
            </span>
            <span
              className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                app.enabled ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
              }`}
            >
              {app.enabled
                ? t('admin.apps.status.enabled', 'Enabled')
                : t('admin.apps.status.disabled', 'Disabled')}
            </span>
          </div>

          {/* Description */}
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-2">
              {t('admin.apps.details.description', 'Description')}
            </h4>
            <p className="text-sm text-gray-600 leading-relaxed">
              {getLocalizedValue(app.description)}
            </p>
          </div>

          {/* System Instructions */}
          {app.system && (
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-2">
                {t('admin.apps.details.systemInstructions', 'System Instructions')}
              </h4>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-sm text-gray-600 leading-relaxed">
                  {getLocalizedValue(app.system)}
                </p>
              </div>
            </div>
          )}

          {/* Technical Details */}
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-3">
              {t('admin.apps.details.technicalDetails', 'Technical Details')}
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {t('admin.apps.details.model', 'Model')}
                </div>
                <div className="text-sm text-gray-900 mt-1">{app.preferredModel || 'Default'}</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {t('admin.apps.details.tokenLimit', 'Token Limit')}
                </div>
                <div className="text-sm text-gray-900 mt-1">{app.tokenLimit || 'Default'}</div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {t('admin.apps.details.temperature', 'Temperature')}
                </div>
                <div className="text-sm text-gray-900 mt-1">
                  {app.preferredTemperature || 'Default'}
                </div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {t('admin.apps.details.order', 'Order')}
                </div>
                <div className="text-sm text-gray-900 mt-1">{app.order || 'Not set'}</div>
              </div>
            </div>
          </div>

          {/* Variables */}
          {app.variables && app.variables.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-3">
                {t('admin.apps.details.variables', 'Variables')}
              </h4>
              <div className="space-y-2">
                {app.variables.map((variable, index) => (
                  <div key={index} className="bg-gray-50 rounded-lg p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800">
                          {variable.name}
                        </span>
                        <span className="text-xs text-gray-500">{variable.type}</span>
                        {variable.required && (
                          <span className="text-xs text-red-500">required</span>
                        )}
                      </div>
                    </div>
                    <div className="text-sm text-gray-600 mt-1">
                      {getLocalizedValue(variable.label)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Starter Prompts */}
          {app.starterPrompts && app.starterPrompts.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-3">
                {t('admin.apps.details.starterPrompts', 'Starter Prompts')}
              </h4>
              <div className="space-y-2">
                {app.starterPrompts.map((prompt, index) => (
                  <div key={index} className="bg-gray-50 rounded-lg p-3">
                    <div className="text-sm font-medium text-gray-900">
                      {getLocalizedValue(prompt.title)}
                    </div>
                    <div className="text-sm text-gray-600 mt-1">
                      {getLocalizedValue(prompt.message)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-gray-50 border-t border-gray-200 px-6 py-4 flex justify-between items-center rounded-b-lg">
          <button
            onClick={() => {
              navigate(`/admin/apps/${app.id}`);
              onClose();
            }}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            <Icon name="pencil" className="w-4 h-4 mr-2" />
            {t('admin.apps.details.editApp', 'Edit App')}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            {t('admin.apps.details.close', 'Close')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default AppDetailsPopup;
