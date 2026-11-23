// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CHECKBOX_CLASS, INPUT_CLASS } from '../components/formStyles';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import {
  createPage,
  fetchAdminPage,
  getAdminApiErrorMessage,
  updatePage
} from '../../../api/adminApi';
import AdminBreadcrumb from '../components/AdminBreadcrumb';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import UnsavedChangesDialog from '../components/UnsavedChangesDialog';
import AdminSaveBar from '../components/AdminSaveBar';

function AdminPageEditPage() {
  const { t } = useTranslation();
  const { pageId } = useParams();
  const navigate = useNavigate();
  const isNew = pageId === 'new';

  const defaultPage = {
    id: '',
    title: { en: '' },
    content: { en: '' },
    authRequired: false,
    allowedGroups: '*',
    contentType: 'markdown'
  };

  const [page, setPage] = useState(defaultPage);
  const [initialData, setInitialData] = useState(isNew ? defaultPage : null);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  // Inline message under the Page ID field (no native alert).
  const [idError, setIdError] = useState(null);

  const { isDirty, blocker, markSaved } = useUnsavedChanges(initialData, page);
  const formRef = useRef(null);

  useEffect(() => {
    if (isNew) {
      setLoading(false);
    } else {
      loadPage();
    }
  }, [pageId, isNew]); // eslint-disable-line @eslint-react/exhaustive-deps

  const loadPage = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchAdminPage(pageId);
      const loadedPage = {
        id: data.id,
        title: data.title || { en: '' },
        content: data.content || { en: '' },
        authRequired: data.authRequired || false,
        allowedGroups:
          Array.isArray(data.allowedGroups) && data.allowedGroups.length > 0
            ? data.allowedGroups.join(',')
            : '*',
        contentType: data.contentType || 'markdown'
      };
      setPage(loadedPage);
      setInitialData(loadedPage);
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [pageId]);

  const handleSubmit = async e => {
    e.preventDefault();
    // An empty field is stopped by the browser (`required`); an id of only
    // spaces passes that check and is caught here.
    if (!page.id.trim()) {
      setIdError(t('admin.pages.fields.idRequired', 'ID is required'));
      document.getElementById('page-id')?.focus();
      return;
    }
    setIdError(null);
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
      markSaved();
      navigate('/admin/pages');
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setPage(initialData);
    setError(null);
    setIdError(null);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-4xl mx-auto px-4 py-8">
        <AdminBreadcrumb
          crumbs={[
            { label: t('documentTitle.admin', 'Admin'), href: '/admin' },
            { label: t('admin.nav.pages', 'Pages'), href: '/admin/pages' },
            {
              label: isNew
                ? t('admin.breadcrumbs.newPage', 'New Page')
                : (page?.title?.en ?? pageId)
            }
          ]}
        />
        <form ref={formRef} onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label
              htmlFor="page-id"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t('admin.pages.fields.id', 'Page ID')}
            </label>
            <input
              id="page-id"
              type="text"
              aria-invalid={idError ? 'true' : undefined}
              aria-describedby={idError ? 'page-id-error' : undefined}
              value={page.id}
              onChange={e => {
                setIdError(null);
                setPage(prev => ({ ...prev, id: e.target.value }));
              }}
              disabled={!isNew}
              required
              className={`${INPUT_CLASS} mt-1 block`}
            />
            {idError && (
              <p
                id="page-id-error"
                role="alert"
                className="mt-1 text-sm text-red-700 dark:text-red-300"
              >
                {idError}
              </p>
            )}
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
              className={`${INPUT_CLASS} mt-1 block`}
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
              className={CHECKBOX_CLASS}
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
              placeholder={t('admin.pages.fields.allowedGroupsPlaceholder', 'admins, users or *')}
              aria-describedby="page-allowed-groups-help"
              className={`${INPUT_CLASS} mt-1 block`}
            />
            <p
              id="page-allowed-groups-help"
              className="mt-1 text-xs text-gray-500 dark:text-gray-400"
            >
              {t(
                'admin.pages.fields.allowedGroupsHelp',
                'Group IDs, separated by commas, exactly as in Admin → Groups. Leave empty or enter * to allow everyone. Only members of a listed group see the page; an ID that does not exist matches nobody.'
              )}
            </p>
          </div>
          {error && <div className="text-red-600 dark:text-red-400 text-sm">{error}</div>}
          <div className="flex justify-start">
            <button
              type="button"
              onClick={() => navigate('/admin/pages')}
              className="px-4 py-2 rounded-md bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200"
            >
              {t('common.back', 'Back')}
            </button>
          </div>
        </form>
      </div>

      {/* Save goes through the form's own submit handler, so its checks run. */}
      <AdminSaveBar
        dirty={isDirty}
        saving={saving}
        saveLabel={isNew ? t('admin.ui.saveBar.create', 'Create') : undefined}
        onSave={() => formRef.current?.requestSubmit()}
        onDiscard={handleDiscard}
      />

      <UnsavedChangesDialog blocker={blocker} />
    </div>
  );
}

export default AdminPageEditPage;
