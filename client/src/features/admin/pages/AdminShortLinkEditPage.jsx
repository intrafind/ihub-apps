// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect, useMemo } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CHECKBOX_CLASS, INPUT_CLASS } from '../components/formStyles';
import { makeAdminApiCall, fetchAdminApps } from '../../../api/adminApi';
import { getLocalizedContent } from '../../../utils/localizeContent';
import ResourceSelector from '../components/ResourceSelector';
import { apiErrorMessage } from '../../../utils/apiErrorMessage';
import AdminBreadcrumb from '../components/AdminBreadcrumb';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';
import UnsavedChangesDialog from '../components/UnsavedChangesDialog';
import { getBasePath } from '../../../utils/runtimeBasePath';
import {
  buildShortLinkTarget,
  hasShortLinkParams,
  shortLinkLocation
} from '../../../../../shared/shortLinkTargetPath.js';

/**
 * The params typed into the editor as an object, or null while the JSON does
 * not parse.
 *
 * @param {string} text - The "Params (JSON)" field
 * @returns {Object|null}
 */
function parseParams(text) {
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The link as the editor holds it. A stored `url` that was built from the
 * app, path and params is not shown as a custom "Redirect URL": the field
 * stays empty, so a new app, path or params changes where the link leads
 * (CU-B1). Only a target someone typed is kept in the field.
 *
 * @param {Object} data - `GET /api/shortlinks/:code`
 * @returns {Object}
 */
function editableShortLink(data) {
  const customUrl = data.url && data.url !== buildShortLinkTarget(data) ? data.url : '';
  return {
    ...data,
    url: customUrl,
    params: data.params || {},
    expiresAt: data.expiresAt || ''
  };
}

function AdminShortLinkEditPage() {
  const { code } = useParams();
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const isNew = code === 'new';

  // The apps a link can open, for the app search box.
  const [apps, setApps] = useState([]);
  useEffect(() => {
    let active = true;
    fetchAdminApps()
      .then(items => active && setApps(Array.isArray(items) ? items : []))
      .catch(() => active && setApps([]));
    return () => {
      active = false;
    };
  }, []);

  const defaultLink = {
    code: '',
    appId: '',
    path: '',
    url: '',
    // Params typed into a new link are meant to reach it (a prefilled prompt).
    includeParams: true,
    params: {},
    expiresAt: ''
  };

  const [link, setLink] = useState(defaultLink);
  const [initialData, setInitialData] = useState(isNew ? defaultLink : null);
  const [paramsText, setParamsText] = useState('{}');
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const { blocker, markSaved } = useUnsavedChanges(initialData, link);

  // The app search box offers every app by its name in the current language;
  // an app id that is no longer configured stays visible so it can be replaced.
  const appResources = useMemo(() => {
    const resources = apps.map(app => ({
      id: app.id,
      name: getLocalizedContent(app.name, i18n.language) || app.id
    }));
    if (link.appId && !resources.some(r => r.id === link.appId)) {
      resources.push({ id: link.appId, name: link.appId });
    }
    return resources;
  }, [apps, i18n.language, link.appId]);

  useEffect(() => {
    if (!isNew) {
      void (async () => {
        try {
          const res = await makeAdminApiCall(`/shortlinks/${code}`);
          const loadedLink = editableShortLink(res.data);
          setLink(loadedLink);
          setInitialData(loadedLink);
          setParamsText(JSON.stringify(loadedLink.params, null, 2));
        } catch (e) {
          setError(e.message);
        } finally {
          setLoading(false);
        }
      })();
    }
  }, [code, isNew]);

  // Where the link leads once saved: the typed Redirect URL, else the target
  // built from the app or path and (when included) the params. A visitor of a
  // path on this server lands under the deployment base path, as /s/:code
  // redirects there.
  const typedParams = parseParams(paramsText);
  const builtTarget = buildShortLinkTarget({ ...link, params: typedParams || {} });
  const targetPreview = shortLinkLocation(link.url?.trim() || builtTarget, getBasePath());
  const paramsLeftOut = !link.url?.trim() && !link.includeParams && hasShortLinkParams(typedParams);

  const handleChange = (field, value) => {
    setLink(l => ({ ...l, [field]: value }));
  };

  const handleSave = async e => {
    e.preventDefault();
    let parsedParams = {};
    if (paramsText.trim()) {
      try {
        parsedParams = JSON.parse(paramsText);
      } catch {
        setError(t('admin.shortlinks.invalidParams', 'Invalid params JSON'));
        return;
      }
    }
    setSaving(true);
    try {
      const method = isNew ? 'POST' : 'PUT';
      const url = isNew ? '/shortlinks' : `/shortlinks/${code}`;
      await makeAdminApiCall(url, {
        method,
        body: {
          ...link,
          params: parsedParams,
          expiresAt: link.expiresAt ? new Date(link.expiresAt).toISOString() : null
        }
      });
      markSaved();
      navigate('/admin/shortlinks');
    } catch (err) {
      // A refused host comes back as SHORT_LINK_HOST_NOT_ALLOWED: the message names
      // the host and where an administrator allows it.
      setError(
        apiErrorMessage(
          err,
          t,
          t('admin.shortlinks.saveError', 'The short link could not be saved.')
        )
      );
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
    <div>
      <div className="max-w-2xl mx-auto p-6 space-y-6">
        <AdminBreadcrumb
          crumbs={[
            { label: t('documentTitle.admin', 'Admin'), href: '/admin' },
            { label: t('admin.nav.shortlinks', 'Short Links'), href: '/admin/shortlinks' },
            {
              label: isNew
                ? t('admin.breadcrumbs.newShortLink', 'New Short Link')
                : (link?.code ?? code)
            }
          ]}
        />
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
          {isNew
            ? t('admin.shortlinks.new', 'Create Short Link')
            : t('admin.shortlinks.editTitle', 'Edit Short Link')}
        </h1>
        {error && (
          <div role="alert" className="text-red-600 dark:text-red-400">
            {error}
          </div>
        )}
        <form onSubmit={handleSave} className="space-y-4">
          <div>
            <label
              htmlFor="shortlink-code"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t('admin.shortlinks.code', 'Code')}
            </label>
            <input
              type="text"
              id="shortlink-code"
              value={link.code}
              onChange={e => handleChange('code', e.target.value)}
              disabled={!isNew}
              className={`${INPUT_CLASS} mt-1 block`}
            />
          </div>
          <ResourceSelector
            label={t('admin.shortlinks.app', 'App')}
            resources={appResources}
            selectedResources={link.appId ? [link.appId] : []}
            // One app: the one picked last replaces the previous one.
            onSelectionChange={ids => handleChange('appId', ids[ids.length - 1] || '')}
            allowWildcard={false}
            placeholder={t('admin.shortlinks.appSearch', 'Search apps...')}
            emptyMessage={t('admin.shortlinks.noApp', 'No app selected')}
          />
          {/* The owner is whoever created the link; the server sets it. */}
          {!isNew && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('admin.shortlinks.userId', 'User ID')}
              </label>
              <input
                type="text"
                value={link.ownerId || ''}
                readOnly
                disabled
                className="mt-1 block w-full border border-admin-control-border dark:border-admin-control-border-dark rounded-md shadow-xs bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
              />
            </div>
          )}
          <div>
            <label
              htmlFor="shortlink-path"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t('admin.shortlinks.path', 'Path')}
            </label>
            <input
              type="text"
              id="shortlink-path"
              value={link.path || ''}
              onChange={e => handleChange('path', e.target.value)}
              className={`${INPUT_CLASS} mt-1 block`}
            />
          </div>
          <div>
            <label
              htmlFor="shortlink-url"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t('admin.shortlinks.url', 'Redirect URL')}
            </label>
            <input
              type="text"
              id="shortlink-url"
              value={link.url || ''}
              onChange={e => handleChange('url', e.target.value)}
              placeholder={builtTarget}
              aria-describedby="shortlink-url-hint"
              className={`${INPUT_CLASS} mt-1 block`}
            />
            <p id="shortlink-url-hint" className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t('admin.shortlinks.urlEmptyHint', 'Leave it empty to open the app or path above.')}{' '}
              {t(
                'admin.shortlinks.urlHint',
                'A path on this server (/apps/chat) always works. A link to another website works only when its host is on the SSRF allowlist.'
              )}{' '}
              <Link
                to="/admin/security#settings-section-ssrf"
                className="text-indigo-600 dark:text-indigo-400 underline"
              >
                {t('admin.shortlinks.ssrfLink', 'Admin → Security → SSRF Allowlist')}
              </Link>
            </p>
          </div>
          <div className="flex items-center">
            <input
              type="checkbox"
              id="shortlink-include-params"
              checked={link.includeParams}
              onChange={e => handleChange('includeParams', e.target.checked)}
              aria-describedby={paramsLeftOut ? 'shortlink-params-left-out' : undefined}
              className={CHECKBOX_CLASS}
            />
            <label
              htmlFor="shortlink-include-params"
              className="ml-2 block text-sm text-gray-700 dark:text-gray-300"
            >
              {t('admin.shortlinks.includeParams', 'Include Params')}
            </label>
          </div>
          <div>
            <label
              htmlFor="shortlink-expires-at"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t('admin.shortlinks.expiresAt', 'Expires')}
            </label>
            <input
              type="datetime-local"
              id="shortlink-expires-at"
              value={link.expiresAt ? link.expiresAt.substring(0, 16) : ''}
              onChange={e => handleChange('expiresAt', e.target.value)}
              className={`${INPUT_CLASS} mt-1 block`}
            />
          </div>
          <div>
            <label
              htmlFor="shortlink-params"
              className="block text-sm font-medium text-gray-700 dark:text-gray-300"
            >
              {t('admin.shortlinks.paramsJson', 'Params (JSON)')}
            </label>
            <textarea
              rows="4"
              id="shortlink-params"
              value={paramsText}
              onChange={e => setParamsText(e.target.value)}
              aria-describedby={paramsLeftOut ? 'shortlink-params-left-out' : undefined}
              className={`${INPUT_CLASS} mt-1 block font-mono`}
            />
            {/* Always rendered, so screen readers announce the warning when it appears. */}
            <p
              id="shortlink-params-left-out"
              role="status"
              className="mt-1 text-xs text-amber-700 dark:text-amber-300 empty:hidden"
            >
              {paramsLeftOut &&
                t(
                  'admin.shortlinks.paramsLeftOut',
                  'These params are not added to the link while “Include Params” is off.'
                )}
            </p>
          </div>
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {t('admin.shortlinks.targetPreview', 'Opens:')}{' '}
            <code data-testid="shortlink-target-preview" className="break-all">
              {targetPreview}
            </code>
          </p>
          <div className="flex justify-end space-x-4">
            <button
              type="button"
              onClick={() => navigate('/admin/shortlinks')}
              className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700"
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

      <UnsavedChangesDialog blocker={blocker} />
    </div>
  );
}

export default AdminShortLinkEditPage;
