import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import CloudStorageConfig from '../components/CloudStorageConfig';

/**
 * Standalone Office 365 (OneDrive / SharePoint) integration page. Shares
 * the CloudStorageConfig component with the Google Drive page; the
 * `filterType="office365"` prop scopes the list and the "Add provider"
 * action to OneDrive / SharePoint providers only.
 */
function AdminIntegrationsOffice365Page() {
  const { t } = useTranslation();
  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
            <Link
              to="/admin/integrations"
              className="text-sm text-indigo-600 dark:text-indigo-400 hover:underline"
            >
              ← {t('admin.integrations.backToIntegrations', 'Back to Integrations')}
            </Link>
            <h1 className="mt-2 text-3xl font-bold text-gray-900 dark:text-gray-100">
              {t('admin.integrations.cards.office365.title', 'Office 365 (OneDrive / SharePoint)')}
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mt-2">
              {t(
                'admin.integrations.cards.office365.description',
                "Let users browse and attach files from OneDrive / SharePoint via Microsoft Graph during a chat. Stored under the platform's `cloudStorage` config."
              )}
            </p>
          </div>
        </div>
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <CloudStorageConfig filterType="office365" />
        </div>
      </div>
    </AdminAuth>
  );
}

export default AdminIntegrationsOffice365Page;
