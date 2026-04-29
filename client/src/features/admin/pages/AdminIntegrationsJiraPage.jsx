import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import JiraConfig from '../components/JiraConfig';

/**
 * Standalone Jira integration page — extracts the JiraConfig component
 * (previously embedded inline at the bottom of AdminProvidersPage) into
 * its own admin route under /admin/integrations/jira so it has parity
 * with the rest of the integrations landing.
 */
function AdminIntegrationsJiraPage() {
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
              {t('admin.integrations.cards.jira.title', 'Atlassian Jira')}
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mt-2">
              {t(
                'admin.integrations.cards.jira.description',
                'OAuth credentials so iHub apps can read and create Jira tickets on behalf of the signed‑in user.'
              )}
            </p>
          </div>
        </div>
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <JiraConfig />
        </div>
      </div>
    </AdminAuth>
  );
}

export default AdminIntegrationsJiraPage;
