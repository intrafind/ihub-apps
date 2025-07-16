import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';

const PromptDetailsPopup = ({ prompt, isOpen, onClose }) => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();

  if (!isOpen || !prompt) return null;

  const getLocalizedValue = content => {
    return getLocalizedContent(content, currentLanguage);
  };

  return (
    <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50 flex items-center justify-center p-4">
      <div className="relative bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between rounded-t-lg">
          <div className="flex items-center space-x-3">
            <div className="w-12 h-12 rounded-lg bg-indigo-100 flex items-center justify-center">
              <Icon name={prompt.icon || 'clipboard'} className="w-6 h-6 text-indigo-600" />
            </div>
            <div>
              <h3 className="text-lg font-semibold text-gray-900">
                {getLocalizedValue(prompt.name)}
              </h3>
              <p className="text-sm text-gray-500">{prompt.id}</p>
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
              {t('admin.prompts.details.status', 'Status')}
            </span>
            <span
              className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                prompt.enabled !== false ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
              }`}
            >
              {prompt.enabled !== false
                ? t('admin.prompts.status.enabled', 'Enabled')
                : t('admin.prompts.status.disabled', 'Disabled')}
            </span>
          </div>

          {/* Description */}
          {prompt.description && (
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-2">
                {t('admin.prompts.details.description', 'Description')}
              </h4>
              <p className="text-sm text-gray-600 leading-relaxed">
                {getLocalizedValue(prompt.description)}
              </p>
            </div>
          )}

          {/* Prompt Content */}
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-2">
              {t('admin.prompts.details.promptContent', 'Prompt Content')}
            </h4>
            <div className="bg-gray-50 rounded-lg p-3 max-h-60 overflow-y-auto">
              <p className="text-sm text-gray-600 leading-relaxed whitespace-pre-wrap">
                {getLocalizedValue(prompt.prompt)}
              </p>
            </div>
          </div>

          {/* Technical Details */}
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-3">
              {t('admin.prompts.details.technicalDetails', 'Technical Details')}
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {t('admin.prompts.details.order', 'Order')}
                </div>
                <div className="text-sm text-gray-900 mt-1">
                  {prompt.order !== undefined ? prompt.order : 'Not set'}
                </div>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                  {t('admin.prompts.details.linkedApp', 'Linked App')}
                </div>
                <div className="text-sm text-gray-900 mt-1">{prompt.appId || 'None'}</div>
              </div>
            </div>
          </div>

          {/* Variables */}
          {prompt.variables && prompt.variables.length > 0 && (
            <div>
              <h4 className="text-sm font-medium text-gray-700 mb-3">
                {t('admin.prompts.details.variables', 'Variables')}
              </h4>
              <div className="space-y-2">
                {prompt.variables.map((variable, index) => (
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
                    {variable.defaultValue && (
                      <div className="text-xs text-gray-500 mt-1">
                        Default: {variable.defaultValue}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Available Languages */}
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-3">
              {t('admin.prompts.details.availableLanguages', 'Available Languages')}
            </h4>
            <div className="flex flex-wrap gap-2">
              {Object.keys(prompt.name || {}).map(lang => (
                <span
                  key={lang}
                  className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800"
                >
                  {lang.toUpperCase()}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="sticky bottom-0 bg-gray-50 border-t border-gray-200 px-6 py-4 flex justify-between items-center rounded-b-lg">
          <button
            onClick={() => {
              navigate(`/admin/prompts/${prompt.id}`);
              onClose();
            }}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            <Icon name="pencil" className="w-4 h-4 mr-2" />
            {t('admin.prompts.details.editPrompt', 'Edit Prompt')}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          >
            {t('admin.prompts.details.close', 'Close')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PromptDetailsPopup;
