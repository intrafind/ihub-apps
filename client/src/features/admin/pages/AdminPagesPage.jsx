import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import Icon from '../../../shared/components/Icon';
import { fetchAdminPages, deletePage } from '../../../api/adminApi';
import { getLocalizedContent } from '../../../utils/localizeContent';

const AdminPagesPage = () => {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadPages();
  }, []);

  const loadPages = async () => {
    try {
      setLoading(true);
      const data = await fetchAdminPages();
      setPages(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async id => {
    if (!window.confirm(t('admin.pages.confirmDelete', 'Delete this page?'))) {
      return;
    }
    try {
      await deletePage(id);
      setPages(prev => prev.filter(p => p.id !== id));
    } catch (err) {
      setError(err.message);
    }
  };

  const getTitle = page => getLocalizedContent(page.title, currentLanguage);

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  if (error) {
    return <div className="text-center text-red-600 dark:text-red-400 py-8">{error}</div>;
  }

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="sm:flex sm:items-center">
            <div className="sm:flex-auto">
              <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                {t('admin.pages.title', 'Pages Administration')}
              </h1>
              <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
                {t('admin.pages.subtitle', 'Manage static pages displayed in the application')}
              </p>
            </div>
            <div className="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
              <button
                type="button"
                className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 sm:w-auto"
                onClick={() => navigate('/admin/pages/new')}
              >
                <Icon name="plus" className="h-4 w-4 mr-2" />
                {t('admin.pages.create', 'Create Page')}
              </button>
            </div>
          </div>

          <div className="mt-8 flex flex-col">
            <div className="-my-2 -mx-4 overflow-x-auto sm:-mx-6 lg:-mx-8">
              <div className="inline-block min-w-full py-2 align-middle md:px-6 lg:px-8">
                <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 dark:ring-gray-700 md:rounded-lg">
                  <table className="min-w-full divide-y divide-gray-300 dark:divide-gray-700">
                    <thead className="bg-gray-50 dark:bg-gray-800">
                      <tr>
                        <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          ID
                        </th>
                        <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          {t('admin.pages.fields.title', 'Title')}
                        </th>
                        <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          {t('admin.pages.access', 'Access')}
                        </th>
                        <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          {t('admin.pages.actions', 'Actions')}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
                      {pages.map(page => (
                        <tr key={page.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
                          <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                            {page.id}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                            {getTitle(page)}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap text-sm text-gray-900 dark:text-gray-100">
                            {page.authRequired
                              ? Array.isArray(page.allowedGroups) && page.allowedGroups.length > 0
                                ? page.allowedGroups.join(', ')
                                : t('common.all', 'All')
                              : t('common.none', 'None')}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap text-right text-sm font-medium space-x-2">
                            <button
                              onClick={() => window.open(`/pages/${page.id}`, '_blank')}
                              className="p-2 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/50 rounded-full"
                              title={t('common.view', 'View')}
                            >
                              <Icon name="eye" className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => navigate(`/admin/pages/${page.id}`)}
                              className="p-2 text-indigo-600 hover:bg-indigo-50 dark:hover:bg-indigo-900/50 rounded-full"
                              title={t('common.edit', 'Edit')}
                            >
                              <Icon name="pencil" className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleDelete(page.id)}
                              className="p-2 text-red-600 hover:bg-red-50 dark:hover:bg-red-900/50 rounded-full"
                              title={t('common.delete', 'Delete')}
                            >
                              <Icon name="trash" className="h-4 w-4" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminPagesPage;
