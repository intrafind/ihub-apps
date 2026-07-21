import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import Modal from '../../../shared/components/Modal';
import { DetailsPopupHeader, DetailsPopupFooter } from '../../../shared/components/DetailsPopup';

function PromptDetailsPopup({ prompt, isOpen, onClose }) {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();

  if (!isOpen || !prompt) return null;

  const getLocalizedValue = content => {
    return getLocalizedContent(content, currentLanguage);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidthClassName="max-w-2xl">
      <DetailsPopupHeader
        icon={prompt.icon || 'clipboard'}
        title={getLocalizedValue(prompt.name)}
        subtitle={prompt.id}
        onClose={onClose}
      />

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Status */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('admin.prompts.details.status', 'Status')}
          </span>
          <span
            className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
              prompt.enabled !== false
                ? 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300'
                : 'bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-300'
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
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('admin.prompts.details.description', 'Description')}
            </h4>
            <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
              {getLocalizedValue(prompt.description)}
            </p>
          </div>
        )}

        {/* Prompt Content */}
        <div>
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            {t('admin.prompts.details.promptContent', 'Prompt Content')}
          </h4>
          <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-3 max-h-60 overflow-y-auto">
            <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed whitespace-pre-wrap">
              {getLocalizedValue(prompt.prompt)}
            </p>
          </div>
        </div>

        {/* Technical Details */}
        <div>
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
            {t('admin.prompts.details.technicalDetails', 'Technical Details')}
          </h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-3">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                {t('admin.prompts.details.order', 'Order')}
              </div>
              <div className="text-sm text-gray-900 dark:text-gray-100 mt-1">
                {prompt.order !== undefined ? prompt.order : t('common.notSet', 'Not set')}
              </div>
            </div>
            <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-3">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                {t('admin.prompts.details.linkedApp', 'Linked App')}
              </div>
              <div className="text-sm text-gray-900 dark:text-gray-100 mt-1">
                {prompt.appId || t('common.none', 'None')}
              </div>
            </div>
          </div>
        </div>

        {/* Variables */}
        {prompt.variables && prompt.variables.length > 0 && (
          <div>
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              {t('admin.prompts.details.variables', 'Variables')}
            </h4>
            <div className="space-y-2">
              {prompt.variables.map((variable, index) => (
                <div key={index} className="bg-gray-50 dark:bg-gray-700 rounded-lg p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-indigo-100 dark:bg-indigo-900/50 text-indigo-800 dark:text-indigo-300">
                        {variable.name}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {variable.type}
                      </span>
                      {variable.required && (
                        <span className="text-xs text-red-500 dark:text-red-400">
                          {t('common.required', 'required')}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                    {getLocalizedValue(variable.label)}
                  </div>
                  {variable.defaultValue && (
                    <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      {t('common.default', 'Default')}: {variable.defaultValue}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Available Languages */}
        <div>
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
            {t('admin.prompts.details.availableLanguages', 'Available Languages')}
          </h4>
          <div className="flex flex-wrap gap-2">
            {Object.keys(prompt.name || {}).map(lang => (
              <span
                key={lang}
                className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300"
              >
                {lang.toUpperCase()}
              </span>
            ))}
          </div>
        </div>
      </div>

      <DetailsPopupFooter>
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
          className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-600 border border-gray-300 dark:border-gray-500 rounded-md hover:bg-gray-50 dark:hover:bg-gray-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
        >
          {t('admin.prompts.details.close', 'Close')}
        </button>
      </DetailsPopupFooter>
    </Modal>
  );
}

export default PromptDetailsPopup;
