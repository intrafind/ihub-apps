import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AdminNavigation from '../components/AdminNavigation';
import AdminAuth from '../components/AdminAuth';
import { makeAdminApiCall } from '../api/adminApi';

const AdminShortLinkEditPage = () => {
  const { code } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const isNew = code === 'new';

  const [link, setLink] = useState({
    code: '',
    appId: '',
    userId: '',
    path: '',
    url: '',
    includeParams: false,
    params: {}
  });
  const [paramsText, setParamsText] = useState('{}');
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isNew) {
      (async () => {
        try {
          const res = await makeAdminApiCall(`/api/shortlinks/${code}`);
          const data = await res.json();
          setLink({ ...data, params: data.params || {} });
          setParamsText(JSON.stringify(data.params || {}, null, 2));
        } catch (e) {
          setError(e.message);
        } finally {
          setLoading(false);
        }
      })();
    }
  }, [code, isNew]);

  const handleChange = (field, value) => {
    setLink(l => ({ ...l, [field]: value }));
  };

  const handleSave = async (e) => {
    e.preventDefault();
    let parsedParams = {};
    if (paramsText.trim()) {
      try {
        parsedParams = JSON.parse(paramsText);
      } catch (err) {
        setError(t('admin.shortlinks.invalidParams', 'Invalid params JSON'));
        return;
      }
    }
    setSaving(true);
    try {
      const method = isNew ? 'POST' : 'PUT';
      const url = isNew ? '/api/shortlinks' : `/api/shortlinks/${code}`;
      await makeAdminApiCall(url, {
        method,
        body: JSON.stringify({ ...link, params: parsedParams })
      });
      navigate('/admin/shortlinks');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  return (
    <AdminAuth>
      <div>
        <AdminNavigation />
        <div className="max-w-2xl mx-auto p-6 space-y-6">
          <h1 className="text-2xl font-semibold text-gray-900">
            {isNew ? t('admin.shortlinks.new', 'Create Short Link') : t('admin.shortlinks.edit', 'Edit Short Link')}
          </h1>
          {error && (
            <div className="text-red-600">{error}</div>
          )}
          <form onSubmit={handleSave} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700">{t('admin.shortlinks.code', 'Code')}</label>
              <input
                type="text"
                value={link.code}
                onChange={(e) => handleChange('code', e.target.value)}
                disabled={!isNew}
                className="mt-1 block w-full border-gray-300 rounded-md shadow-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">{t('admin.shortlinks.appId', 'App ID')}</label>
              <input
                type="text"
                value={link.appId}
                onChange={(e) => handleChange('appId', e.target.value)}
                className="mt-1 block w-full border-gray-300 rounded-md shadow-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">{t('admin.shortlinks.userId', 'User ID')}</label>
              <input
                type="text"
                value={link.userId}
                onChange={(e) => handleChange('userId', e.target.value)}
                className="mt-1 block w-full border-gray-300 rounded-md shadow-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">{t('admin.shortlinks.path', 'Path')}</label>
              <input
                type="text"
                value={link.path || ''}
                onChange={(e) => handleChange('path', e.target.value)}
                className="mt-1 block w-full border-gray-300 rounded-md shadow-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">{t('admin.shortlinks.url', 'Redirect URL')}</label>
              <input
                type="text"
                value={link.url || ''}
                onChange={(e) => handleChange('url', e.target.value)}
                className="mt-1 block w-full border-gray-300 rounded-md shadow-sm"
              />
            </div>
            <div className="flex items-center">
              <input
                type="checkbox"
                checked={link.includeParams}
                onChange={(e) => handleChange('includeParams', e.target.checked)}
                className="h-4 w-4 text-indigo-600 border-gray-300 rounded"
              />
              <label className="ml-2 block text-sm text-gray-700">{t('admin.shortlinks.includeParams', 'Include Params')}</label>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">{t('admin.shortlinks.params', 'Params (JSON)')}</label>
              <textarea
                rows="4"
                value={paramsText}
                onChange={(e) => setParamsText(e.target.value)}
                className="mt-1 block w-full border-gray-300 rounded-md shadow-sm font-mono"
              />
            </div>
            <div className="flex justify-end space-x-4">
              <button
                type="button"
                onClick={() => navigate('/admin/shortlinks')}
                className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 border border-transparent rounded-md text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700"
              >
                {saving ? t('common.saving', 'Saving...') : t('common.save', 'Save')}
              </button>
            </div>
          </form>
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminShortLinkEditPage;
