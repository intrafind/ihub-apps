import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';

function AdminAdvancedPage() {
  const { t } = useTranslation();
  const [forceRefreshLoading, setForceRefreshLoading] = useState(false);
  const [forceRefreshMessage, setForceRefreshMessage] = useState('');

  const handleForceRefresh = async () => {
    setForceRefreshLoading(true);
    setForceRefreshMessage('');

    try {
      const response = await makeAdminApiCall('/admin/client/_refresh', { method: 'POST' });
      const data = response.data;
      setForceRefreshMessage({
        type: 'success',
        text: t(
          'admin.system.triggerSuccess',
          'Force refresh triggered successfully! New salt: {{salt}}. All clients will refresh on their next page load.',
          { salt: data.newAdminSalt }
        )
      });
    } catch (error) {
      setForceRefreshMessage({
        type: 'error',
        text:
          t('admin.system.triggerError', 'Failed to trigger force refresh') +
          (error.message ? `: ${error.message}` : '')
      });
    } finally {
      setForceRefreshLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
          {t('admin.nav.advanced', 'Advanced')}
        </h1>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
          {t('admin.advanced.description', 'Advanced system operations and maintenance tools')}
        </p>
      </div>

      <div className="space-y-6">
        {/* Force Refresh Section */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
          <div className="flex items-start space-x-4">
            <div className="flex-shrink-0 mt-1">
              <div className="p-3 rounded-full bg-orange-100 dark:bg-orange-900/50">
                <Icon name="refresh" size="lg" className="text-orange-600 dark:text-orange-400" />
              </div>
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
                {t('admin.system.forceTitle', 'Force Client Refresh')}
              </h3>
              <p className="text-gray-600 dark:text-gray-400 mb-4">
                {t(
                  'admin.system.forceDesc',
                  'Trigger a force refresh for all clients. This will clear all browser caches, localStorage, and force clients to reload all assets (JS, CSS, fonts, configurations) without using browser cache. The disclaimer acceptance will be preserved.'
                )}
              </p>

              <div className="bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-md p-4 mb-4">
                <div className="flex">
                  <Icon name="warning" size="md" className="text-amber-500 mt-0.5 mr-3" />
                  <div>
                    <h4 className="text-sm font-medium text-amber-800 dark:text-amber-200">
                      {t('admin.system.warningTitle', 'Warning')}
                    </h4>
                    <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                      {t(
                        'admin.system.warningDesc',
                        'This action will force all connected clients to reload their browsers on their next page interaction. Use this when deploying critical updates or when clients need to clear cached data.'
                      )}
                    </p>
                  </div>
                </div>
              </div>

              {forceRefreshMessage && (
                <div
                  className={`p-4 rounded-md mb-4 ${
                    forceRefreshMessage.type === 'success'
                      ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800'
                      : 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800'
                  }`}
                >
                  <div className="flex">
                    <Icon
                      name={forceRefreshMessage.type === 'success' ? 'check' : 'warning'}
                      size="md"
                      className={`mt-0.5 mr-3 ${
                        forceRefreshMessage.type === 'success' ? 'text-green-500' : 'text-red-500'
                      }`}
                    />
                    <p
                      className={`text-sm ${
                        forceRefreshMessage.type === 'success'
                          ? 'text-green-700 dark:text-green-300'
                          : 'text-red-700 dark:text-red-300'
                      }`}
                    >
                      {forceRefreshMessage.text}
                    </p>
                  </div>
                </div>
              )}

              <button
                onClick={handleForceRefresh}
                disabled={forceRefreshLoading}
                className={`inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white ${
                  forceRefreshLoading
                    ? 'bg-gray-400 cursor-not-allowed'
                    : 'bg-orange-600 hover:bg-orange-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-500'
                }`}
              >
                {forceRefreshLoading ? (
                  <>
                    <svg
                      className="animate-spin -ml-1 mr-3 h-4 w-4 text-white"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                      />
                    </svg>
                    {t('admin.system.triggering', 'Triggering Force Refresh...')}
                  </>
                ) : (
                  <>
                    <Icon name="refresh" size="md" className="mr-2" />
                    {t('admin.system.trigger', 'Trigger Force Refresh')}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AdminAdvancedPage;
