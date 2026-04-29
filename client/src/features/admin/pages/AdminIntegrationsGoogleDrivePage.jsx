import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import CloudStorageConfig from '../components/CloudStorageConfig';

/**
 * Standalone Google Drive integration page. Shares the CloudStorageConfig
 * component with the Office 365 page; `filterType="googledrive"` scopes
 * the list and the "Add provider" action to Google Drive providers only.
 */
function AdminIntegrationsGoogleDrivePage() {
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
              {t('admin.integrations.cards.googleDrive.title', 'Google Drive')}
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mt-2">
              {t(
                'admin.integrations.cards.googleDrive.description',
                'Let users browse and attach files from Google Drive during a chat. Same `cloudStorage` config surface as Office 365.'
              )}
            </p>
          </div>
        </div>
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <CloudStorageConfig filterType="googledrive" />
        </div>
      </div>
    </AdminAuth>
  );
}

export default AdminIntegrationsGoogleDrivePage;
