import React, { useEffect, useState } from 'react';
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

  const [page, setPage] = useState({ id: '', title: { en: '' }, content: { en: '' } });
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (isNew) {
      setLoading(false);
    } else {
      loadPage();
    }
  }, [pageId]);

  const loadPage = async () => {
    try {
      setLoading(true);
      const data = await fetchAdminPage(pageId);
      setPage({
        id: data.id,
        title: data.title || { en: '' },
        content: data.content || { en: '' }
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async e => {
    e.preventDefault();
    if (!page.id) {
      alert(t('admin.pages.fields.idRequired', 'ID is required'));
      return;
    }
    try {
      setSaving(true);
      if (isNew) {
        await createPage(page);
      } else {
        await updatePage(pageId, page);
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
      <div className="max-w-4xl mx-auto px-4 py-8">
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              {t('admin.pages.fields.id', 'Page ID')}
            </label>
            <input
              type="text"
              value={page.id}
              onChange={e => setPage(prev => ({ ...prev, id: e.target.value }))}
              disabled={!isNew}
              required
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm"
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
          {error && <div className="text-red-600 text-sm">{error}</div>}
          <div className="flex justify-end space-x-2">
            <button
              type="button"
              onClick={() => navigate('/admin/pages')}
              className="px-4 py-2 rounded-md bg-gray-200"
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
    </AdminAuth>
  );
};

export default AdminPageEditPage;
