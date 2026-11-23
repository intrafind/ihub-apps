// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import { useAdminResourceEditor } from '../hooks/useAdminResourceEditor';
import AdminEditPageShell, {
  AdminSaveCancelButtons
} from '../../../shared/components/AdminEditPageShell';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import DualModeEditor from '../../../shared/components/DualModeEditor';
import UserFormEditor from '../components/UserFormEditor';
import {
  fetchAdminUsageLimitUser,
  getAdminApiErrorMessage,
  makeAdminApiCall,
  resetAdminUsageLimitUser
} from '../../../api/adminApi';
import { getSchemaByType } from '../../../utils/schemaService';
import AdminLoadError from '../components/AdminLoadError';
import UsageLimitsEditor from '../components/UsageLimitsEditor';
import { buildUserSavePayload } from '../utils/userSavePayload';
import { apiErrorMessage } from '../../../utils/apiErrorMessage';
import { useAuth } from '../../../shared/contexts/AuthContext';
import QuotaBar from '../../../shared/components/QuotaBar';
import { windowLabel, localizedName } from '../../../shared/utils/usageFormat';

/**
 * Bytes as "12.3 MB" for the file storage bar.
 * @param {number} bytes
 * @param {string} language
 * @returns {string}
 */
const formatBytes = (bytes, language) => {
  const n = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let unit = 0;
  while (Math.abs(value) >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toLocaleString(language, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
};

/**
 * Where an effective limit comes from, as an admin reads it.
 * @param {string|null} source - `model`, `platform`, `user` or `group:<id>`
 * @param {Function} t
 * @returns {string}
 */
const adminSourceLabel = (source, t) => {
  if (!source) return '';
  if (source === 'model') return t('admin.usageLimits.source.model', 'model');
  if (source === 'platform') return t('admin.usageLimits.source.platform', 'platform');
  if (source === 'user') return t('admin.usageLimits.source.user', 'personal limit');
  if (source.startsWith('group:')) {
    return t('admin.usageLimits.source.group', 'group: {{group}}', { group: source.slice(6) });
  }
  return source;
};

/**
 * Read-only view of a user's token usage against their effective limits, with
 * a button that resets the counts of the current windows.
 *
 * @param {Object} props
 * @param {string} props.userId - The user id (the usage tracking key)
 */
function UserUsagePanel({ userId }) {
  const { t, i18n } = useTranslation();
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setInfo(await fetchAdminUsageLimitUser(userId));
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleReset = async () => {
    setConfirmReset(false);
    try {
      setResetting(true);
      setError(null);
      setInfo(await resetAdminUsageLimitUser(userId));
    } catch (err) {
      setError(getAdminApiErrorMessage(err));
    } finally {
      setResetting(false);
    }
  };

  const buckets = info?.buckets || [];
  const files = info?.files;

  const bucketLabel = bucket => {
    const window = windowLabel(bucket.window, t);
    const scope =
      bucket.scope === 'model'
        ? localizedName(bucket.modelName, i18n.language, bucket.modelId)
        : t('admin.usageLimits.allModelsTitle', 'All models');
    return `${scope} · ${window}`;
  };

  return (
    <div className="bg-white dark:bg-gray-800 shadow-sm rounded-lg">
      <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
            {t('admin.usageLimits.currentUsageTitle', 'Current usage')}
          </h3>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
            {t(
              'admin.usageLimits.currentUsageIntro',
              'Tokens used in the current windows against the limits that apply to this user.'
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setConfirmReset(true)}
          disabled={loading || resetting || !info}
          className="inline-flex items-center px-3 py-2 border border-red-300 dark:border-red-700 shadow-xs text-sm font-medium rounded-md text-red-700 dark:text-red-300 bg-white dark:bg-gray-700 hover:bg-red-50 dark:hover:bg-red-900/40 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50"
        >
          <Icon name="refresh" className="h-4 w-4 mr-2" />
          {resetting
            ? t('admin.usageLimits.resetting', 'Resetting…')
            : t('admin.usageLimits.resetButton', 'Reset usage')}
        </button>
      </div>
      <div className="px-6 py-4 space-y-4">
        {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
        {loading ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('admin.usageLimits.loadingUsage', 'Loading usage…')}
          </p>
        ) : (
          info && (
            <>
              {buckets.length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t('admin.usageLimits.noLimitsApply', 'No token limits apply to this user.')}
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-4">
                  {buckets.map(bucket => (
                    <QuotaBar
                      key={bucket.id || `${bucket.scope}:${bucket.modelId}:${bucket.window}`}
                      label={bucketLabel(bucket)}
                      used={bucket.used}
                      limit={bucket.limit}
                      resetAt={bucket.resetAt}
                      hint={
                        bucket.source
                          ? t('admin.usageLimits.limitedBy', 'Limit from {{source}}', {
                              source: adminSourceLabel(bucket.source, t)
                            })
                          : undefined
                      }
                    />
                  ))}
                </div>
              )}
              {files && (
                <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                  <QuotaBar
                    label={t(
                      'admin.usageLimits.fileStorageUsage',
                      'File storage ({{count}} files)',
                      {
                        count: files.fileCount ?? 0
                      }
                    )}
                    used={files.usedBytes || 0}
                    limit={typeof files.limit === 'number' && files.limit >= 0 ? files.limit : null}
                    format={value => formatBytes(value, i18n.language)}
                  />
                </div>
              )}
            </>
          )
        )}
      </div>

      <ConfirmDialog
        isOpen={confirmReset}
        title={t('admin.usageLimits.resetConfirmTitle', 'Reset usage?')}
        message={t(
          'admin.usageLimits.resetConfirmMessage',
          "This sets this user's token counts for the current day, week and month back to zero. It cannot be undone."
        )}
        confirmLabel={t('admin.usageLimits.resetConfirm', 'Reset')}
        denyLabel={t('common.cancel', 'Cancel')}
        danger
        onConfirm={handleReset}
        onDeny={() => setConfirmReset(false)}
      />
    </div>
  );
}

function AdminUserEditPage() {
  const { t } = useTranslation();
  const { userId } = useParams();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [jsonSchema, setJsonSchema] = useState(null);
  const [availableGroups, setAvailableGroups] = useState([]);
  const { user: currentUser } = useAuth();
  // The id of the user whose update that sent `active` failed: the server may
  // or may not have stored it, so that user's next save sends the admin's
  // status choice even when it matches the loaded user. Keyed by user, so a
  // save that fails after the editor moved on to another user does not force
  // `active` into that user's save (and one that succeeds does not clear it).
  const activeUncertainRef = useRef(null);
  // What the form reports (`{ isValid, errors }`) and in which mode the editor is: a save
  // from the form waits until the form is valid.
  const [formValidation, setFormValidation] = useState({ isValid: true, errors: [] });
  const [editorMode, setEditorMode] = useState('form');
  // Save attempts that the form refused; from the first one on every error shows.
  const [saveAttempts, setSaveAttempts] = useState(0);

  // Generate a unique ID for new users
  const generateUserId = () => `user_${crypto.randomUUID().replaceAll('-', '_')}`;

  const {
    data: user,
    setData: setUser,
    loading,
    error,
    isNew: isNewUser,
    initialData: acceptedUser,
    save,
    blocker
  } = useAdminResourceEditor({
    resourceId: userId,
    loadResource: async id => {
      const response = await makeAdminApiCall('/admin/auth/users');
      const data = response.data;

      // Find the user by ID in the users object
      const userData = Object.values(data.users || {}).find(u => u.id === id);
      if (!userData) {
        throw new Error('User not found');
      }

      return { ...userData, password: '' };
    },
    // Initialize new user with generated ID
    makeDefault: () => ({
      id: generateUserId(),
      username: '',
      email: null,
      fullName: '',
      name: '',
      password: '',
      internalGroups: [],
      authMethods: ['local'],
      enabled: true,
      active: true
    }),
    saveResource: async (data, id) => {
      const isNew = id === 'new';
      const method = isNew ? 'POST' : 'PUT';
      const url = isNew ? '/admin/auth/users' : `/admin/auth/users/${id}`;

      // Check if this is a local auth user (needs password)
      const isLocalAuth =
        !data.authMethods || data.authMethods.length === 0 || data.authMethods.includes('local');

      // The baseline is the hook's accepted load (or last successful save),
      // never a response it discarded: `active` is sent only when it changed.
      const apiData = buildUserSavePayload(data, {
        isNew,
        initial: acceptedUser,
        forceActive: !isNew && activeUncertainRef.current === id
      });

      // For new local auth users, ensure password is provided
      if (isNew && isLocalAuth && !data.password) {
        throw new Error('Password is required for local authentication users');
      }

      try {
        await makeAdminApiCall(url, {
          method,
          headers: {
            'Content-Type': 'application/json'
          },
          body: apiData
        });
      } catch (err) {
        if (!isNew && 'active' in apiData) activeUncertainRef.current = id;
        throw err;
      }
      if (activeUncertainRef.current === id) activeUncertainRef.current = null;
    }
  });

  useEffect(() => {
    activeUncertainRef.current = null;
  }, [userId]);

  useEffect(() => {
    void loadSchema();
    void loadGroups();
  }, [userId]);

  const loadSchema = async () => {
    try {
      const schema = await getSchemaByType('user');
      setJsonSchema(schema);
    } catch (error) {
      console.error('Failed to load user schema:', error);
    }
  };

  const loadGroups = async () => {
    try {
      const response = await makeAdminApiCall('/admin/groups');
      const groups = response.data?.groups || {};
      setAvailableGroups(Object.values(groups));
    } catch (error) {
      console.error('Failed to load groups:', error);
    }
  };

  const handleSave = async () => {
    // The form names what is missing at its fields and in its summary.
    if (editorMode === 'form' && !formValidation.isValid) {
      setSaveAttempts(count => count + 1);
      return;
    }

    if (!user.username) {
      setSaveError(t('admin.users.validation.usernameRequired', 'Username is required'));
      return;
    }

    try {
      setSaving(true);
      setSaveError(null);
      await save();
      // Success - navigate back to users list
      navigate('/admin/users');
    } catch (err) {
      // The form and every edit stay; a refusal (LAST_ADMIN, SELF_LOCKOUT) is shown
      // in the admin's language from its code.
      setSaveError(apiErrorMessage(err, t, getAdminApiErrorMessage(err)));
    } finally {
      setSaving(false);
    }
  };

  const handleDataChange = newData => {
    setUser(newData);
  };

  const handleFormSubmit = async e => {
    e.preventDefault();
    await handleSave();
  };

  if (!loading && error) {
    return <AdminLoadError title={t('common.error', 'Error')} message={error} action={null} />;
  }

  return (
    <AdminEditPageShell
      loading={loading}
      outerClassName="min-h-screen bg-gray-50 dark:bg-gray-900"
      breadcrumbs={[
        { label: t('documentTitle.admin', 'Admin'), href: '/admin' },
        { label: t('admin.nav.users', 'Users'), href: '/admin/users' },
        {
          label: isNewUser ? t('admin.breadcrumbs.newUser', 'New User') : (user?.username ?? userId)
        }
      ]}
      blocker={blocker}
    >
      <div className="mb-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
              {isNewUser
                ? t('admin.users.edit.createTitle', 'Create New User')
                : t('admin.users.edit.editTitle', 'Edit User')}
            </h1>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {isNewUser
                ? t(
                    'admin.users.edit.createDesc',
                    'Create a new user account with permissions and settings'
                  )
                : t('admin.users.edit.editDesc', 'Edit user account, permissions, and settings')}
            </p>
          </div>
          <div className="flex space-x-3">
            {!isNewUser && (
              <button
                type="button"
                onClick={() => {
                  const dataStr = JSON.stringify(user, null, 2);
                  const dataUri =
                    'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
                  const exportFileDefaultName = `user-${user.username}.json`;
                  const linkElement = document.createElement('a');
                  linkElement.setAttribute('href', dataUri);
                  linkElement.setAttribute('download', exportFileDefaultName);
                  linkElement.click();
                }}
                className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 shadow-xs text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="download" className="h-4 w-4 mr-2" />
                {t('common.download')}
              </button>
            )}
            <button
              onClick={() => navigate('/admin/users')}
              className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 shadow-xs text-sm font-medium rounded-md text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            >
              <Icon name="arrow-left" className="h-4 w-4 mr-2" />
              {t('admin.users.edit.backToList', 'Back to Users')}
            </button>
          </div>
        </div>
      </div>

      {saveError && (
        <div
          role="alert"
          className="mb-6 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-md p-4"
        >
          <div className="flex">
            <div className="shrink-0">
              <Icon name="warning" size="md" className="text-red-400" />
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800 dark:text-red-200">
                {t('admin.users.edit.saveFailedTitle', 'Could not save the user')}
              </h3>
              <div className="mt-2 text-sm text-red-700 dark:text-red-300">{saveError}</div>
            </div>
          </div>
        </div>
      )}

      {/* noValidate: the form's own messages come first (see handleSave). */}
      <form onSubmit={handleFormSubmit} noValidate className="space-y-8">
        <DualModeEditor
          value={user}
          onChange={handleDataChange}
          formComponent={UserFormEditor}
          onValidationChange={setFormValidation}
          onModeChange={setEditorMode}
          formProps={{
            isNewUser,
            showAllErrors: saveAttempts > 0,
            summaryFocusKey: saveAttempts,
            isSelf: !isNewUser && Boolean(currentUser?.id) && currentUser.id === user?.id,
            jsonSchema,
            availableGroups
          }}
          jsonSchema={jsonSchema}
          title={
            isNewUser
              ? t('admin.users.edit.createTitle', 'Create New User')
              : t('admin.users.edit.editTitle', 'Edit User')
          }
        />

        {isNewUser ? (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t(
              'admin.usageLimits.newUserHint',
              'Personal usage limits can be set once the user has been created.'
            )}
          </p>
        ) : (
          <>
            <UserUsagePanel userId={userId} />
            <UsageLimitsEditor
              level="user"
              value={user?.usageLimits}
              modelIds={['*']}
              onChange={usageLimits =>
                setUser(prev => {
                  const next = { ...prev };
                  if (usageLimits) next.usageLimits = usageLimits;
                  else delete next.usageLimits;
                  return next;
                })
              }
            />
          </>
        )}

        {/* Save buttons */}
        <AdminSaveCancelButtons
          onCancel={() => navigate('/admin/users')}
          cancelLabel={t('admin.users.edit.cancel', 'Cancel')}
          saving={saving}
          saveLabel={t('admin.users.edit.save', isNewUser ? 'Create User' : 'Save User')}
          savingLabel={t('admin.users.edit.saving', 'Saving...')}
          cancelClassName="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-xs text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          saveClassName="px-4 py-2 border border-transparent rounded-md shadow-xs text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
        />
      </form>
    </AdminEditPageShell>
  );
}

export default AdminUserEditPage;
