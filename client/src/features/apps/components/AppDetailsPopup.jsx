import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { getLocalizedContent } from '../../../utils/localizeContent';
import Icon from '../../../shared/components/Icon';
import Modal from '../../../shared/components/Modal';
import { DetailsPopupHeader, DetailsPopupFooter } from '../../../shared/components/DetailsPopup';

function AppDetailsPopup({ app, isOpen, onClose }) {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();

  if (!isOpen || !app) return null;

  const getLocalizedValue = content => {
    return getLocalizedContent(content, currentLanguage);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidthClassName="max-w-2xl">
      <DetailsPopupHeader
        icon={app.icon || 'chat-bubbles'}
        iconStyle={{ backgroundColor: app.color || '#6B7280' }}
        title={getLocalizedValue(app.name)}
        subtitle={app.id}
        onClose={onClose}
      />

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {/* Status */}
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            {t('admin.apps.details.status', 'Status')}
          </span>
          <span
            className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
              app.enabled
                ? 'bg-green-100 dark:bg-green-900/50 text-green-800 dark:text-green-300'
                : 'bg-red-100 dark:bg-red-900/50 text-red-800 dark:text-red-300'
            }`}
          >
            {app.enabled
              ? t('admin.apps.status.enabled', 'Enabled')
              : t('admin.apps.status.disabled', 'Disabled')}
          </span>
        </div>

        {/* Description */}
        <div>
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            {t('admin.apps.details.description', 'Description')}
          </h4>
          <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
            {getLocalizedValue(app.description)}
          </p>
        </div>

        {/* System Instructions */}
        {app.system && (
          <div>
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
              {t('admin.apps.details.systemInstructions', 'System Instructions')}
            </h4>
            <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-3">
              <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                {getLocalizedValue(app.system)}
              </p>
            </div>
          </div>
        )}

        {/* Technical Details */}
        <div>
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
            {t('admin.apps.details.technicalDetails', 'Technical Details')}
          </h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-3">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                {t('admin.apps.details.model', 'Model')}
              </div>
              <div className="text-sm text-gray-900 dark:text-gray-100 mt-1">
                {app.preferredModel || t('common.default', 'Default')}
              </div>
            </div>
            <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-3">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                {t('admin.apps.details.temperature', 'Temperature')}
              </div>
              <div className="text-sm text-gray-900 dark:text-gray-100 mt-1">
                {app.preferredTemperature || t('common.default', 'Default')}
              </div>
            </div>
            <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-3">
              <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                {t('admin.apps.details.order', 'Order')}
              </div>
              <div className="text-sm text-gray-900 dark:text-gray-100 mt-1">
                {app.order || t('common.notSet', 'Not set')}
              </div>
            </div>
          </div>
        </div>

        {/* Variables */}
        {app.variables && app.variables.length > 0 && (
          <div>
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              {t('admin.apps.details.variables', 'Variables')}
            </h4>
            <div className="space-y-2">
              {app.variables.map((variable, index) => (
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
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Starter Prompts */}
        {app.starterPrompts && app.starterPrompts.length > 0 && (
          <div>
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              {t('admin.apps.details.starterPrompts', 'Starter Prompts')}
            </h4>
            <div className="space-y-2">
              {app.starterPrompts.map((prompt, index) => (
                <div key={index} className="bg-gray-50 dark:bg-gray-700 rounded-lg p-3">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {getLocalizedValue(prompt.title)}
                  </div>
                  <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                    {getLocalizedValue(prompt.message)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <DetailsPopupFooter>
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
          className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-600 border border-gray-300 dark:border-gray-500 rounded-md hover:bg-gray-50 dark:hover:bg-gray-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
        >
          {t('admin.apps.details.close', 'Close')}
        </button>
      </DetailsPopupFooter>
    </Modal>
  );
}

export default AppDetailsPopup;
