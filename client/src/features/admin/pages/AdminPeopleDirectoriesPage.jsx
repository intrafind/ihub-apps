// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import Icon from '../../../shared/components/Icon';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import { getLocalizedContent } from '../../../utils/localizeContent';
import AdminBreadcrumb from '../components/AdminBreadcrumb';
import AdminLoadError from '../components/AdminLoadError';
import AdminPageSkeleton from '../components/AdminPageSkeleton';
import DirectoryList from '../components/people-directories/DirectoryList';
import EnablePeopleSearchAppOffer from '../components/people-directories/EnablePeopleSearchAppOffer';
import { CALLOUT_CLASS, PRIMARY_BUTTON_CLASS } from '../components/people-directories/formStyles';
import {
  fetchPeopleDirectories,
  fetchPeopleDirectoryPresets,
  savePeopleDirectories
} from '../../../api/peopleDirectoriesAdminApi';
import { getAdminApiErrorMessage } from '../../../api/adminApi';
import {
  describeSaveError,
  shouldOfferPeopleSearchApp,
  withDirectoryEnabled,
  withoutDirectory
} from '../utils/peopleDirectories';

/**
 * Admin → Integrations → People directories
 * (`/admin/integrations/people-directories`).
 *
 * Lists every directory of `peopleDirectories.json` with an enabled switch
 * that saves at once.
 *
 * Switching a directory on while the shipped "People search" app is still
 * disabled offers to enable the app too. The editor hands the same offer over
 * after a save through the router state (`{ savedId, justEnabled }`).
 */
function AdminPeopleDirectoriesPage() {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();

  const [data, setData] = useState(null);
  const [presets, setPresets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  // The editor navigates here after a save with `{ savedId, justEnabled }`.
  const [message, setMessage] = useState(() =>
    location.state?.savedId
      ? {
          type: 'success',
          text: t('admin.peopleDirectories.list.saved', 'Directory "{{id}}" saved.', {
            id: location.state.savedId
          })
        }
      : null
  );
  // The directory whose switch or deletion is being saved. While it is set,
  // every switch and delete button is disabled; `savingRef` also guards clicks
  // that land before that re-render.
  const [togglingId, setTogglingId] = useState(null);
  const savingRef = useRef(false);
  const [offerRequested, setOfferRequested] = useState(() => Boolean(location.state?.justEnabled));
  const [deleteTarget, setDeleteTarget] = useState(null);

  const load = useCallback(async () => {
    try {
      const response = await fetchPeopleDirectories();
      setData({
        directories: Array.isArray(response?.directories) ? response.directories : [],
        effective: response?.effective || {},
        peopleSearchApp: response?.peopleSearchApp
      });
      setLoadError(null);
    } catch (err) {
      setLoadError(getAdminApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Presets only name the directory types; the list works without them.
    fetchPeopleDirectoryPresets()
      .then(response => setPresets(Array.isArray(response?.presets) ? response.presets : []))
      .catch(() => setPresets([]));
  }, [load]);

  // Drop the editor's state once it is shown, so a reload does not show it again.
  useEffect(() => {
    if (location.state?.savedId) {
      navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    }
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  const presetLabel = id => {
    const preset = presets.find(p => p.id === id);
    return t(`admin.peopleDirectories.presets.${id}`, preset?.label || id);
  };

  const directoryName = id => {
    const directory = data?.directories.find(d => d.id === id);
    return getLocalizedContent(directory?.name, i18n.language) || id;
  };

  /**
   * The stored list, read just before a save: the PUT replaces the whole file,
   * so writing this page's copy would undo a save made meanwhile in the editor
   * or another tab.
   */
  const fetchCurrentDirectories = async () => {
    const current = await fetchPeopleDirectories();
    return Array.isArray(current?.directories) ? current.directories : [];
  };

  const toggle = async (id, enabled) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setTogglingId(id);
    setMessage(null);
    try {
      const directories = await fetchCurrentDirectories();
      const before = directories.find(d => d.id === id);
      if (!before) {
        const name = directoryName(id);
        await load();
        setMessage({
          type: 'error',
          text: t(
            'admin.peopleDirectories.list.gone',
            '"{{name}}" no longer exists. The list has been reloaded.',
            { name }
          )
        });
        return;
      }
      await savePeopleDirectories(withDirectoryEnabled(directories, id, enabled));
      await load();
      // Whether the app still needs enabling is read from the reloaded data.
      if (enabled && before.enabled === false) setOfferRequested(true);
      setMessage({
        type: 'success',
        text: enabled
          ? t('admin.peopleDirectories.list.switchedOn', '"{{name}}" is on.', {
              name: directoryName(id)
            })
          : t('admin.peopleDirectories.list.switchedOff', '"{{name}}" is off.', {
              name: directoryName(id)
            })
      });
    } catch (err) {
      setMessage({ type: 'error', text: describeSaveError(err) });
    } finally {
      savingRef.current = false;
      setTogglingId(null);
    }
  };

  const confirmDelete = async () => {
    const id = deleteTarget;
    setDeleteTarget(null);
    if (!id || savingRef.current) return;
    savingRef.current = true;
    setTogglingId(id);
    const name = directoryName(id);
    setMessage(null);
    try {
      const directories = await fetchCurrentDirectories();
      await savePeopleDirectories(withoutDirectory(directories, id));
      await load();
      setMessage({
        type: 'success',
        text: t('admin.peopleDirectories.list.deleted', '"{{name}}" deleted.', { name })
      });
    } catch (err) {
      setMessage({ type: 'error', text: describeSaveError(err) });
    } finally {
      savingRef.current = false;
      setTogglingId(null);
    }
  };

  const app = data?.peopleSearchApp;
  const showOffer =
    offerRequested &&
    shouldOfferPeopleSearchApp(app, {
      wasEnabled: false,
      isEnabled: true
    });

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <AdminBreadcrumb
        crumbs={[
          { label: t('admin.nav.integrations', 'Integrations'), href: '/admin/integrations' },
          { label: t('admin.peopleDirectories.title', 'People directories') }
        ]}
      />
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {t('admin.peopleDirectories.title', 'People directories')}
          </h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {t(
              'admin.peopleDirectories.subtitle',
              'LDAP directories the model can search for people — your own and external ones such as x500.bund.de. Each enabled directory becomes read-only tools that apps can use.'
            )}
          </p>
        </div>
        <Link
          to="/admin/integrations/people-directories/new"
          className={`${PRIMARY_BUTTON_CLASS} shrink-0 whitespace-nowrap self-start`}
        >
          <Icon name="plus" size="sm" />
          {t('admin.peopleDirectories.list.add', 'Add directory')}
        </Link>
      </div>

      {message &&
        (message.type === 'error' ? (
          <AdminLoadError
            framed={false}
            action={null}
            className="mb-6"
            title={t('admin.peopleDirectories.list.saveFailed', 'The change was not saved')}
            message={message.text}
          />
        ) : (
          <div role="status" className={`${CALLOUT_CLASS.success} mb-6`}>
            {message.text}
          </div>
        ))}

      {showOffer && (
        <EnablePeopleSearchAppOffer
          onDone={() => setOfferRequested(false)}
          onEnabled={() => {
            setMessage({
              type: 'success',
              text: t('admin.peopleDirectories.appOffer.enabled', 'The "People search" app is on.')
            });
            void load();
          }}
        />
      )}

      {loading ? (
        <AdminPageSkeleton rows={2} hasHeader={false} />
      ) : loadError ? (
        <AdminLoadError
          framed={false}
          title={t(
            'admin.peopleDirectories.list.loadError',
            'The people directories could not be loaded'
          )}
          message={loadError}
          action={{ label: t('common.retry', 'Retry'), onClick: load }}
        />
      ) : (
        <>
          {data.directories.some(d => d.enabled !== false) ? null : (
            <p className={`${CALLOUT_CLASS.info} mb-4`}>
              {t(
                'admin.peopleDirectories.list.allOff',
                'All directories are off, so no search term leaves iHub. Switch one on to offer it to apps.'
              )}
            </p>
          )}
          <DirectoryList
            directories={data.directories}
            effective={data.effective}
            presetLabel={presetLabel}
            togglingId={togglingId}
            onToggle={toggle}
            onDelete={setDeleteTarget}
          />
        </>
      )}

      <ConfirmDialog
        isOpen={deleteTarget !== null}
        title={t('admin.peopleDirectories.list.deleteTitle', 'Delete directory')}
        message={t(
          'admin.peopleDirectories.list.deleteConfirm',
          'Delete "{{name}}"? Apps lose its tools at once.',
          { name: deleteTarget ? directoryName(deleteTarget) : '' }
        )}
        confirmLabel={t('admin.peopleDirectories.list.delete', 'Delete')}
        denyLabel={t('common.cancel', 'Cancel')}
        danger
        onConfirm={confirmDelete}
        onDeny={() => setDeleteTarget(null)}
      />
    </div>
  );
}

export default AdminPeopleDirectoriesPage;
