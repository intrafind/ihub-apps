import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { deletePage, fetchAdminPages, getAdminApiErrorMessage } from '../../../api/adminApi';
import { getLocalizedContent } from '../../../utils/localizeContent';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { DataTable } from '../components/data-table';

function AdminPagesPage() {
  const { t, i18n } = useTranslation();
  const currentLanguage = i18n.language;
  const navigate = useNavigate();
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);

  useEffect(() => {
    loadPages();
  }, []);

  const loadPages = async () => {
    try {
      setLoading(true);
      const data = await fetchAdminPages();
      setPages(data);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = id => {
    setConfirmDialog({
      title: t('admin.pages.deleteTitle', 'Delete Page'),
      message: t('admin.pages.confirmDelete', 'Delete this page?'),
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await deletePage(id);
          setPages(prev => prev.filter(p => p.id !== id));
        } catch (err) {
          setError(getAdminApiErrorMessage(err));
        }
      }
    });
  };

  const getTitle = page => getLocalizedContent(page.title, currentLanguage);

  const columns = [
    {
      key: 'id',
      header: 'ID',
      sortable: true,
      width: 'w-48'
    },
    {
      key: 'title',
      header: t('admin.pages.fields.title', 'Title'),
      sortable: true,
      sortAccessor: getTitle,
      render: getTitle
    },
    {
      key: 'access',
      header: t('admin.pages.access', 'Access'),
      render: page =>
        page.authRequired
          ? Array.isArray(page.allowedGroups) && page.allowedGroups.length > 0
            ? page.allowedGroups.join(', ')
            : t('common.all', 'All')
          : t('common.none', 'None')
    }
  ];

  const actions = [
    {
      id: 'view',
      label: t('common.view', 'View'),
      icon: 'eye',
      onClick: page => window.open(`/pages/${page.id}`, '_blank')
    },
    {
      id: 'edit',
      label: t('common.edit', 'Edit'),
      icon: 'pencil',
      priority: 'primary',
      onClick: page => navigate(`/admin/pages/${page.id}`)
    },
    {
      id: 'delete',
      label: t('common.delete', 'Delete'),
      icon: 'trash',
      destructive: true,
      onClick: page => handleDelete(page.id)
    }
  ];

  if (error) {
    return <div className="text-center text-red-600 dark:text-red-400 py-8">{error}</div>;
  }

  return (
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

        <div className="mt-8">
          <DataTable
            columns={columns}
            data={pages}
            getRowId={page => page.id}
            actions={actions}
            loading={loading}
            empty={{
              icon: 'document-text',
              title: t('admin.pages.empty', 'No pages yet'),
              description: t(
                'admin.pages.emptyDescription',
                'Create your first page to display custom content in the app.'
              )
            }}
          />
        </div>
      </div>
      <ConfirmDialog
        isOpen={!!confirmDialog}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        danger={confirmDialog?.danger}
        onConfirm={() => confirmDialog?.onConfirm()}
        onDeny={() => setConfirmDialog(null)}
      />
    </div>
  );
}

export default AdminPagesPage;
