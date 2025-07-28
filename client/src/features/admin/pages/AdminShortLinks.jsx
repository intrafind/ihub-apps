import { useEffect, useState, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import Icon from '../../../shared/components/Icon';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { makeAdminApiCall } from '../../../api/adminApi';
import ShortLinkDetailsPopup from '../../../shared/components/ShortLinkDetailsPopup';

const AdminShortLinks = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [appIdFilter, setAppIdFilter] = useState('');
  const [userFilter, setUserFilter] = useState('');
  const [selectedLink, setSelectedLink] = useState(null);
  const [showDetails, setShowDetails] = useState(false);
  const [sortField, setSortField] = useState('createdAt');
  const [sortDir, setSortDir] = useState('desc');

  const loadLinks = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (appIdFilter) params.set('appId', appIdFilter);
      if (userFilter) params.set('userId', userFilter);
      const response = await makeAdminApiCall(`/shortlinks?${params.toString()}`);
      const data = response.data;
      setLinks(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [appIdFilter, userFilter]);

  useEffect(() => {
    loadLinks();
  }, [loadLinks]);

  const handleDelete = async code => {
    if (!window.confirm(t('admin.shortlinks.deleteConfirm', 'Delete this link?'))) return;
    try {
      await makeAdminApiCall(`/shortlinks/${code}`, { method: 'DELETE' });
      setLinks(l => l.filter(link => link.code !== code));
    } catch (e) {
      setError(e.message);
    }
  };

  const handleRowClick = link => {
    setSelectedLink(link);
    setShowDetails(true);
  };

  const handleSort = field => {
    if (sortField === field) {
      setSortDir(dir => (dir === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const sortedLinks = useMemo(() => {
    const list = [...links];
    const compare = (a, b) => {
      let x = a[sortField];
      let y = b[sortField];
      if (x === undefined || x === null) x = '';
      if (y === undefined || y === null) y = '';
      if (sortField === 'usage') {
        return sortDir === 'asc' ? x - y : y - x;
      }
      if (sortField === 'createdAt' || sortField === 'expiresAt') {
        x = x ? new Date(x).getTime() : 0;
        y = y ? new Date(y).getTime() : 0;
        return sortDir === 'asc' ? x - y : y - x;
      }
      return sortDir === 'asc'
        ? String(x).localeCompare(String(y))
        : String(y).localeCompare(String(x));
    };
    return list.sort(compare);
  }, [links, sortField, sortDir]);

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-md p-4">
        <div className="flex">
          <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
          <div className="ml-3">
            <h3 className="text-sm font-medium text-red-800">
              {t('admin.shortlinks.loadError', 'Error loading short links')}
            </h3>
            <p className="mt-1 text-sm text-red-700">{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="mt-2 text-sm text-red-600 hover:text-red-500"
            >
              {t('common.retry', 'Retry')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <AdminAuth>
      <div>
        <AdminNavigation />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          <div className="sm:flex sm:items-center">
            <div className="sm:flex-auto">
              <h1 className="text-2xl font-semibold text-gray-900">
                {t('admin.shortlinks.title', 'Short Links Management')}
              </h1>
              <p className="mt-2 text-sm text-gray-700">
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

          {/* Search and Filter */}
          <div className="mt-8 flex flex-col sm:flex-row gap-4">
            <div className="flex-1">
              <input
                type="text"
                className="block w-full px-3 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                placeholder={t('admin.shortlinks.filterByAppId', 'Filter by App ID')}
                value={appIdFilter}
                onChange={e => setAppIdFilter(e.target.value)}
              />
            </div>
            <div className="flex-1">
              <input
                type="text"
                className="block w-full px-3 py-2 border border-gray-300 rounded-md leading-5 bg-white placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                placeholder={t('admin.shortlinks.filterByUser', 'Filter by User')}
                value={userFilter}
                onChange={e => setUserFilter(e.target.value)}
              />
            </div>
            <div className="sm:w-32">
              <button
                onClick={loadLinks}
                className="w-full inline-flex justify-center items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                {t('admin.shortlinks.filter', 'Filter')}
              </button>
            </div>
          </div>

          {/* Short Links Table */}
          <div className="mt-8 flex flex-col">
            <div className="-my-2 -mx-4 overflow-x-auto sm:-mx-6 lg:-mx-8">
              <div className="inline-block min-w-full py-2 align-middle md:px-6 lg:px-8">
                <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 md:rounded-lg">
                  <table className="min-w-full divide-y divide-gray-300">
                    <thead className="bg-gray-50">
                      <tr>
                        <th
                          scope="col"
                          onClick={() => handleSort('code')}
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer"
                        >
                          {t('admin.shortlinks.code', 'Code')}
                          {sortField === 'code' && (
                            <Icon
                              name={sortDir === 'asc' ? 'chevron-down' : 'chevron-down'}
                              className={`inline w-3 h-3 ml-1 transform ${sortDir === 'asc' ? '' : 'rotate-180'}`}
                            />
                          )}
                        </th>
                        <th
                          scope="col"
                          onClick={() => handleSort('appId')}
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer"
                        >
                          {t('admin.shortlinks.appId', 'App ID')}
                          {sortField === 'appId' && (
                            <Icon
                              name={sortDir === 'asc' ? 'chevron-down' : 'chevron-down'}
                              className={`inline w-3 h-3 ml-1 transform ${sortDir === 'asc' ? '' : 'rotate-180'}`}
                            />
                          )}
                        </th>
                        <th
                          scope="col"
                          onClick={() => handleSort('userId')}
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer"
                        >
                          {t('admin.shortlinks.userId', 'User ID')}
                          {sortField === 'userId' && (
                            <Icon
                              name={sortDir === 'asc' ? 'chevron-down' : 'chevron-down'}
                              className={`inline w-3 h-3 ml-1 transform ${sortDir === 'asc' ? '' : 'rotate-180'}`}
                            />
                          )}
                        </th>
                        <th
                          scope="col"
                          onClick={() => handleSort('usage')}
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer"
                        >
                          {t('admin.shortlinks.usage', 'Usage')}
                          {sortField === 'usage' && (
                            <Icon
                              name={sortDir === 'asc' ? 'chevron-down' : 'chevron-down'}
                              className={`inline w-3 h-3 ml-1 transform ${sortDir === 'asc' ? '' : 'rotate-180'}`}
                            />
                          )}
                        </th>
                        <th
                          scope="col"
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider"
                        >
                          {t('admin.shortlinks.createdAt', 'Created')}
                        </th>
                        <th
                          scope="col"
                          onClick={() => handleSort('expiresAt')}
                          className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider cursor-pointer"
                        >
                          {t('admin.shortlinks.expiresAt', 'Expires')}
                          {sortField === 'expiresAt' && (
                            <Icon
                              name={sortDir === 'asc' ? 'chevron-down' : 'chevron-down'}
                              className={`inline w-3 h-3 ml-1 transform ${sortDir === 'asc' ? '' : 'rotate-180'}`}
                            />
                          )}
                        </th>
                        <th scope="col" className="relative px-6 py-3">
                          <span className="sr-only">
                            {t('admin.shortlinks.actions', 'Actions')}
                          </span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {sortedLinks.map(link => (
                        <tr
                          key={link.code}
                          className="hover:bg-gray-50 cursor-pointer"
                          onClick={() => handleRowClick(link)}
                        >
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className="flex items-center">
                              <div className="flex-shrink-0 h-8 w-8">
                                <div className="h-8 w-8 rounded-full bg-indigo-100 flex items-center justify-center">
                                  <Icon name="link" className="h-4 w-4 text-indigo-600" />
                                </div>
                              </div>
                              <div className="ml-4">
                                <div className="text-sm font-medium text-gray-900">{link.code}</div>
                                <div className="text-sm text-gray-500">/s/{link.code}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                              {link.appId}
                            </span>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                            {link.userId || '-'}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                            {link.usage || 0}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                            {link.createdAt ? new Date(link.createdAt).toLocaleDateString() : '-'}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                            {link.expiresAt ? new Date(link.expiresAt).toLocaleDateString() : '-'}
                          </td>
                          <td
                            className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium"
                            onClick={e => e.stopPropagation()}
                          >
                            <button
                              onClick={() => handleDelete(link.code)}
                              className="p-2 text-red-600 hover:bg-red-50 rounded-full"
                              title={t('admin.shortlinks.delete', 'Delete')}
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

          {sortedLinks.length === 0 && (
            <div className="text-center py-12">
              <Icon name="link" className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">
                {t('admin.shortlinks.noLinks', 'No short links found')}
              </h3>
              <p className="mt-1 text-sm text-gray-500">
                {t(
                  'admin.shortlinks.noLinksDesc',
                  'Short links will appear here when created by users.'
                )}
              </p>
            </div>
          )}
        </div>
      </div>
      <ShortLinkDetailsPopup
        link={selectedLink}
        isOpen={showDetails}
        onClose={() => setShowDetails(false)}
      />
    </AdminAuth>
  );
};

export default AdminShortLinks;
