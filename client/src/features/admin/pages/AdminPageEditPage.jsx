import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import { fetchAdminPage, createPage, updatePage } from '../../../api/adminApi';

const AdminPageEditPage = () => {
  const { t } = useTranslation();
  const { pageId } = useParams();
  const navigate = useNavigate();
  const isNew = pageId === 'new';

  const [page, setPage] = useState({
    id: '',
    title: { en: '' },
    content: { en: '' },
    authRequired: false,
    allowedGroups: '*',
    contentType: 'markdown'
  });
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (isNew) {
      setLoading(false);
    } else {
      loadPage();
    }
  }, [pageId, isNew]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadPage = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchAdminPage(pageId);
      setPage({
        id: data.id,
        title: data.title || { en: '' },
        content: data.content || { en: '' },
        authRequired: data.authRequired || false,
        allowedGroups:
          Array.isArray(data.allowedGroups) && data.allowedGroups.length > 0
            ? data.allowedGroups.join(',')
            : '*',
        contentType: data.contentType || 'markdown'
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [pageId]);

  const handleSubmit = async e => {
    e.preventDefault();
    if (!page.id) {
      alert(t('admin.pages.fields.idRequired', 'ID is required'));
      return;
    }
    const trimmed = page.allowedGroups.trim();
    const pageData = {
      ...page,
      allowedGroups:
        trimmed === '' || trimmed === '*'
          ? '*'
          : trimmed
              .split(',')
              .map(g => g.trim())
              .filter(g => g.length > 0)
    };
    try {
      setSaving(true);
      if (isNew) {
        await createPage(pageData);
      } else {
        await updatePage(pageId, pageData);
      }
      navigate('/admin/pages');
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  return (
    <AdminAuth>
      <AdminNavigation />
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <div className="max-w-4xl mx-auto px-4 py-8">
          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('admin.pages.fields.id', 'Page ID')}
              </label>
              <input
                type="text"
                value={page.id}
                onChange={e => setPage(prev => ({ ...prev, id: e.target.value }))}
                disabled={!isNew}
                required
                className="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              />
            </div>
            <DynamicLanguageEditor
              label={t('admin.pages.fields.title', 'Title')}
              value={page.title}
              onChange={val => setPage(prev => ({ ...prev, title: val }))}
              required
            />
            <DynamicLanguageEditor
              label={t('admin.pages.fields.content', 'Content')}
              value={page.content}
              onChange={val => setPage(prev => ({ ...prev, content: val }))}
              type="textarea"
              required
            />
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('admin.pages.fields.contentType', 'Content Type')}
              </label>
              <select
                value={page.contentType}
                onChange={e => setPage(prev => ({ ...prev, contentType: e.target.value }))}
                className="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              >
                <option value="markdown">
                  {t('admin.pages.contentTypes.markdown', 'Markdown (.md)')}
                </option>
                <option value="react">
                  {t('admin.pages.contentTypes.reactComponent', 'React Component (.jsx)')}
                </option>
              </select>
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                {page.contentType === 'react'
                  ? t(
                      'admin.pages.contentTypes.jsxDescription',
                      'Write JSX code that will be compiled and rendered as a React component'
                    )
                  : t(
                      'admin.pages.contentTypes.markdownDescription',
                      'Write standard markdown content with syntax highlighting support'
                    )}
              </p>
            </div>
            <div className="flex items-center">
              <input
                id="authRequired"
                type="checkbox"
                checked={page.authRequired}
                onChange={e => setPage(prev => ({ ...prev, authRequired: e.target.checked }))}
                className="h-4 w-4 text-indigo-600 border-gray-300 dark:border-gray-600 rounded"
              />
              <label
                htmlFor="authRequired"
                className="ml-2 block text-sm text-gray-700 dark:text-gray-300"
              >
                {t('admin.pages.fields.authRequired', 'Authentication Required')}
              </label>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('admin.pages.fields.allowedGroups', 'Allowed Groups')}
              </label>
              <input
                type="text"
                value={page.allowedGroups}
                onChange={e => setPage(prev => ({ ...prev, allowedGroups: e.target.value }))}
                placeholder="admin, user or *"
                className="mt-1 block w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              />
            </div>
            {error && <div className="text-red-600 dark:text-red-400 text-sm">{error}</div>}
            <div className="flex justify-end space-x-2">
              <button
                type="button"
                onClick={() => navigate('/admin/pages')}
                className="px-4 py-2 rounded-md bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200"
              >
                {t('common.cancel', 'Cancel')}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 rounded-md bg-indigo-600 text-white"
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

export default AdminPageEditPage;
