import { useEffect, useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useFilterState } from '../hooks/useFilterState';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';
import ShortLinkDetailsPopup from '../../../shared/components/ShortLinkDetailsPopup';
import { useClipboard } from '../../../shared/hooks/useClipboard';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { DataTable, SearchInput, parseSortParam, formatSortParam } from '../components/data-table';

function CodeCell({ link }) {
  return (
    <div className="flex items-center">
      <div className="flex-shrink-0 h-8 w-8">
        <div className="h-8 w-8 rounded-full bg-indigo-100 dark:bg-indigo-900/50 flex items-center justify-center">
          <Icon name="link" className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
        </div>
      </div>
      <div className="ml-3 min-w-0">
        <div className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
          {link.code}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 truncate">/s/{link.code}</div>
      </div>
    </div>
  );
}

function AdminShortLinks() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { copyText } = useClipboard();
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [appIdFilter, setAppIdFilter] = useFilterState('app', '');
  const [userFilter, setUserFilter] = useFilterState('user', '');
  const [selectedLink, setSelectedLink] = useState(null);
  const [showDetails, setShowDetails] = useState(false);
  const [copiedLink, setCopiedLink] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [sortParam, setSortParam] = useFilterState('sort', '');
  const sort = useMemo(
    () => parseSortParam(sortParam) || { column: 'createdAt', direction: 'desc' },
    [sortParam]
  );

  const loadLinks = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (appIdFilter) params.set('appId', appIdFilter);
      if (userFilter) params.set('userId', userFilter);
      const response = await makeAdminApiCall(`/shortlinks?${params.toString()}`);
      setLinks(response.data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [appIdFilter, userFilter]);

  useEffect(() => {
    loadLinks();
  }, [loadLinks]);

  const handleDelete = code => {
    setConfirmDialog({
      title: t('admin.shortlinks.deleteTitle', 'Delete Short Link'),
      message: t('admin.shortlinks.deleteConfirm', 'Delete this link?'),
      danger: true,
      onConfirm: async () => {
        setConfirmDialog(null);
        try {
          await makeAdminApiCall(`/shortlinks/${code}`, { method: 'DELETE' });
          setLinks(l => l.filter(link => link.code !== code));
        } catch (e) {
          setError(e.message);
        }
      }
    });
  };

  const handleCopyLink = async code => {
    const shortUrl = `${window.location.origin}/s/${code}`;
    const result = await copyText(shortUrl);
    if (result.success) {
      setCopiedLink(code);
      setTimeout(() => setCopiedLink(null), 2000);
    }
  };

  const handleTestLink = code => {
    const shortUrl = `${window.location.origin}/s/${code}`;
    window.open(shortUrl, '_blank');
  };

  const columns = [
    {
      key: 'code',
      header: t('admin.shortlinks.code', 'Code'),
      sortable: true,
      render: l => <CodeCell link={l} />
    },
    {
      key: 'appId',
      header: t('admin.shortlinks.appId', 'App ID'),
      sortable: true,
      render: l => (
        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-300">
          {l.appId}
        </span>
      )
    },
    {
      key: 'userId',
      header: t('admin.shortlinks.userId', 'User ID'),
      sortable: true,
      hideBelow: 'lg',
      render: l => l.userId || '-'
    },
    {
      key: 'usage',
      header: t('admin.shortlinks.usage', 'Usage'),
      sortable: true,
      align: 'right',
      hideBelow: 'md',
      sortAccessor: l => l.usage || 0,
      render: l => l.usage || 0
    },
    {
      key: 'createdAt',
      header: t('admin.shortlinks.createdAt', 'Created'),
      sortable: true,
      hideBelow: 'lg',
      sortAccessor: l => (l.createdAt ? new Date(l.createdAt).getTime() : 0),
      render: l => (l.createdAt ? new Date(l.createdAt).toLocaleDateString() : '-')
    },
    {
      key: 'expiresAt',
      header: t('admin.shortlinks.expiresAt', 'Expires'),
      sortable: true,
      hideBelow: 'md',
      sortAccessor: l => (l.expiresAt ? new Date(l.expiresAt).getTime() : 0),
      render: l => (l.expiresAt ? new Date(l.expiresAt).toLocaleDateString() : '-')
    }
  ];

  const actions = [
    {
      id: 'copy',
      label: t('admin.shortlinks.copyLink', 'Copy link'),
      icon: 'copy',
      priority: 'primary',
      busy: l => copiedLink === l.code,
      onClick: l => handleCopyLink(l.code)
    },
    {
      id: 'test',
      label: t('admin.shortlinks.testLink', 'Test link'),
      icon: 'external-link',
      onClick: l => handleTestLink(l.code)
    },
    {
      id: 'delete',
      label: t('admin.shortlinks.delete', 'Delete'),
      icon: 'trash',
      destructive: true,
      onClick: l => handleDelete(l.code)
    }
  ];

  if (error) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md p-4">
          <div className="flex">
            <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800 dark:text-red-200">
                {t('admin.shortlinks.loadError', 'Error loading short links')}
              </h3>
              <p className="mt-1 text-sm text-red-700 dark:text-red-300">{error}</p>
              <button
                onClick={() => window.location.reload()}
                className="mt-2 text-sm text-red-600 dark:text-red-400 hover:text-red-500 dark:hover:text-red-300"
              >
                {t('common.retry', 'Retry')}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="sm:flex sm:items-center">
            <div className="sm:flex-auto">
              <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                {t('admin.shortlinks.title', 'Short Links Management')}
              </h1>
              <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
                {t(
                  'admin.shortlinks.subtitle',
                  'Manage and monitor short links for your applications'
                )}
              </p>
            </div>
            <div className="mt-4 sm:mt-0 sm:ml-16 sm:flex-none">
              <button
                onClick={() => navigate('/admin/shortlinks/new')}
                className="inline-flex items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 sm:w-auto"
              >
                <Icon name="plus" className="h-4 w-4 mr-2" />
                {t('admin.shortlinks.addNew', 'Add New Link')}
              </button>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <SearchInput
              value={appIdFilter}
              onChange={setAppIdFilter}
              placeholder={t('admin.shortlinks.filterByAppId', 'Filter by App ID')}
            />
            <SearchInput
              value={userFilter}
              onChange={setUserFilter}
              placeholder={t('admin.shortlinks.filterByUser', 'Filter by User')}
            />
          </div>

          <div className="mt-6">
            <DataTable
              columns={columns}
              data={links}
              getRowId={l => l.code}
              actions={actions}
              loading={loading}
              sort={sort}
              onSortChange={next => setSortParam(formatSortParam(next))}
              onRowClick={link => {
                setSelectedLink(link);
                setShowDetails(true);
              }}
              empty={{
                icon: 'link',
                title: t('admin.shortlinks.noLinks', 'No short links found'),
                description: t(
                  'admin.shortlinks.noLinksDesc',
                  'Short links will appear here when created by users.'
                )
              }}
            />
          </div>
        </div>
      </div>
      <ShortLinkDetailsPopup
        link={selectedLink}
        isOpen={showDetails}
        onClose={() => setShowDetails(false)}
      />
      <ConfirmDialog
        isOpen={!!confirmDialog}
        title={confirmDialog?.title ?? ''}
        message={confirmDialog?.message ?? ''}
        danger={confirmDialog?.danger}
        onConfirm={() => confirmDialog?.onConfirm()}
        onDeny={() => setConfirmDialog(null)}
      />
    </>
  );
}

export default AdminShortLinks;
