import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import LoadingSpinner from '../../../shared/components/LoadingSpinner';
import {
  listCredentials,
  createCredential,
  updateCredential,
  deleteCredential
} from '../../../api/adminApi';

/**
 * Admin page for managing the central credential store.
 *
 * Credential profiles are named, typed auth credentials referenced elsewhere via
 * `credentialRef` (OpenAPI tools, MCP servers, OIDC/LDAP/NTLM/Jira/cloud-storage
 * integrations). Secret fields are write-only from the UI: existing values are
 * shown as the '***REDACTED***' placeholder and only overwritten when the admin
 * types a new value.
 *
 * Profile types and their fields:
 * - oauth2:       tokenUrl, clientId, clientSecret*, scope?, grantType, refreshToken*?
 * - bearer:       token*
 * - basic:        username, password*
 * - apiKeyHeader: headerName, key*
 * - apiKeyQuery:  paramName, key*
 * - secret:       value*
 * (* = secret field, encrypted at rest)
 */

const INPUT_CLASS =
  'w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 shadow-sm px-3 py-2 text-sm focus:border-blue-500 focus:ring-blue-500';
const MONO_INPUT_CLASS = `${INPUT_CLASS} font-mono`;
const REDACTED = '***REDACTED***';

/** Credential type ids supported by the store. */
const CREDENTIAL_TYPES = ['oauth2', 'bearer', 'basic', 'apiKeyHeader', 'apiKeyQuery', 'secret'];

/** Secret-bearing fields per type (kept in sync with the server schema). */
const SECRET_FIELDS_BY_TYPE = {
  oauth2: ['clientSecret', 'refreshToken'],
  bearer: ['token'],
  basic: ['password'],
  apiKeyHeader: ['key'],
  apiKeyQuery: ['key'],
  secret: ['value']
};

/** Empty form for a brand-new credential profile. */
const BLANK_FORM = {
  id: '',
  name: '',
  description: '',
  type: 'secret',
  // type-specific fields (only the relevant ones are submitted)
  value: '',
  token: '',
  username: '',
  password: '',
  headerName: '',
  paramName: '',
  key: '',
  tokenUrl: '',
  clientId: '',
  clientSecret: '',
  scope: '',
  grantType: 'client_credentials',
  refreshToken: ''
};

/**
 * Build the create/edit form state from an existing (redacted) profile.
 * Secret fields are seeded with the placeholder so they round-trip unchanged.
 * @param {object} profile
 * @returns {object}
 */
function profileToForm(profile) {
  const secretFields = SECRET_FIELDS_BY_TYPE[profile.type] || [];
  const form = { ...BLANK_FORM, ...profile };
  form.name = typeof profile.name === 'string' ? profile.name : profile.name?.en || '';
  form.description =
    typeof profile.description === 'string' ? profile.description : profile.description?.en || '';
  // Ensure secret inputs show the redaction placeholder for existing secrets.
  for (const field of secretFields) {
    if (profile[field]) form[field] = profile[field];
  }
  return form;
}

/**
 * Build the API payload from form state, including only the fields relevant to
 * the selected type. Secret fields equal to the placeholder are dropped on
 * create and kept (to be restored server-side) on edit.
 * @param {object} form
 * @param {boolean} isEdit
 * @returns {object}
 */
function formToPayload(form, isEdit) {
  const payload = {
    id: form.id,
    type: form.type
  };
  if (form.name) payload.name = form.name;
  if (form.description) payload.description = form.description;

  const fieldsByType = {
    oauth2: ['tokenUrl', 'clientId', 'clientSecret', 'scope', 'grantType', 'refreshToken'],
    bearer: ['token'],
    basic: ['username', 'password'],
    apiKeyHeader: ['headerName', 'key'],
    apiKeyQuery: ['paramName', 'key'],
    secret: ['value']
  };
  const secretFields = SECRET_FIELDS_BY_TYPE[form.type] || [];

  for (const field of fieldsByType[form.type] || []) {
    const val = form[field];
    if (secretFields.includes(field)) {
      // On create, never send the placeholder. On edit, keep it so the server
      // restores the stored value.
      if (val === REDACTED && !isEdit) continue;
      if (val) payload[field] = val;
    } else if (val !== '' && val != null) {
      payload[field] = val;
    }
  }
  return payload;
}

/** Localized labels for credential types. */
function typeLabel(type, t) {
  const labels = {
    oauth2: t('admin.credentials.types.oauth2', 'OAuth2'),
    bearer: t('admin.credentials.types.bearer', 'Bearer token'),
    basic: t('admin.credentials.types.basic', 'Basic (username/password)'),
    apiKeyHeader: t('admin.credentials.types.apiKeyHeader', 'API key (header)'),
    apiKeyQuery: t('admin.credentials.types.apiKeyQuery', 'API key (query)'),
    secret: t('admin.credentials.types.secret', 'Secret (opaque value)')
  };
  return labels[type] || type;
}

/**
 * Renders the type-specific field inputs for the credential form.
 * @param {object} props
 */
function TypeFields({ form, update, isEdit, t }) {
  const labelClass = 'block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1';
  const secretHint = t(
    'admin.credentials.form.secretHint',
    'Encrypted at rest. Leave as ***REDACTED*** to keep the current value.'
  );

  if (form.type === 'secret') {
    return (
      <div>
        <label className={labelClass}>
          {t('admin.credentials.form.value', 'Secret value')}
          <span className="text-red-500 ml-0.5">*</span>
        </label>
        <input
          type="password"
          value={form.value}
          onChange={e => update({ value: e.target.value })}
          className={MONO_INPUT_CLASS}
          placeholder={isEdit ? REDACTED : ''}
        />
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{secretHint}</p>
      </div>
    );
  }

  if (form.type === 'bearer') {
    return (
      <div>
        <label className={labelClass}>
          {t('admin.credentials.form.token', 'Token')}
          <span className="text-red-500 ml-0.5">*</span>
        </label>
        <input
          type="password"
          value={form.token}
          onChange={e => update({ token: e.target.value })}
          className={MONO_INPUT_CLASS}
          placeholder={isEdit ? REDACTED : ''}
        />
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{secretHint}</p>
      </div>
    );
  }

  if (form.type === 'basic') {
    return (
      <>
        <div>
          <label className={labelClass}>
            {t('admin.credentials.form.username', 'Username')}
            <span className="text-red-500 ml-0.5">*</span>
          </label>
          <input
            type="text"
            value={form.username}
            onChange={e => update({ username: e.target.value })}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label className={labelClass}>
            {t('admin.credentials.form.password', 'Password')}
            <span className="text-red-500 ml-0.5">*</span>
          </label>
          <input
            type="password"
            value={form.password}
            onChange={e => update({ password: e.target.value })}
            className={INPUT_CLASS}
            placeholder={isEdit ? REDACTED : ''}
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{secretHint}</p>
        </div>
      </>
    );
  }

  if (form.type === 'apiKeyHeader' || form.type === 'apiKeyQuery') {
    const nameField = form.type === 'apiKeyHeader' ? 'headerName' : 'paramName';
    const nameLabel =
      form.type === 'apiKeyHeader'
        ? t('admin.credentials.form.headerName', 'Header name')
        : t('admin.credentials.form.paramName', 'Query parameter name');
    return (
      <>
        <div>
          <label className={labelClass}>
            {nameLabel}
            <span className="text-red-500 ml-0.5">*</span>
          </label>
          <input
            type="text"
            value={form[nameField]}
            onChange={e => update({ [nameField]: e.target.value })}
            className={MONO_INPUT_CLASS}
            placeholder={form.type === 'apiKeyHeader' ? 'X-API-Key' : 'api_key'}
          />
        </div>
        <div>
          <label className={labelClass}>
            {t('admin.credentials.form.key', 'Key')}
            <span className="text-red-500 ml-0.5">*</span>
          </label>
          <input
            type="password"
            value={form.key}
            onChange={e => update({ key: e.target.value })}
            className={MONO_INPUT_CLASS}
            placeholder={isEdit ? REDACTED : ''}
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{secretHint}</p>
        </div>
      </>
    );
  }

  if (form.type === 'oauth2') {
    return (
      <>
        <div>
          <label className={labelClass}>
            {t('admin.credentials.form.tokenUrl', 'Token URL')}
            <span className="text-red-500 ml-0.5">*</span>
          </label>
          <input
            type="url"
            value={form.tokenUrl}
            onChange={e => update({ tokenUrl: e.target.value })}
            className={MONO_INPUT_CLASS}
            placeholder="https://auth.example.com/oauth/token"
          />
        </div>
        <div>
          <label className={labelClass}>
            {t('admin.credentials.form.clientId', 'Client ID')}
            <span className="text-red-500 ml-0.5">*</span>
          </label>
          <input
            type="text"
            value={form.clientId}
            onChange={e => update({ clientId: e.target.value })}
            className={MONO_INPUT_CLASS}
          />
        </div>
        <div>
          <label className={labelClass}>
            {t('admin.credentials.form.clientSecret', 'Client secret')}
            <span className="text-red-500 ml-0.5">*</span>
          </label>
          <input
            type="password"
            value={form.clientSecret}
            onChange={e => update({ clientSecret: e.target.value })}
            className={MONO_INPUT_CLASS}
            placeholder={isEdit ? REDACTED : ''}
          />
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{secretHint}</p>
        </div>
        <div>
          <label className={labelClass}>
            {t('admin.credentials.form.grantType', 'Grant type')}
          </label>
          <select
            value={form.grantType}
            onChange={e => update({ grantType: e.target.value })}
            className={INPUT_CLASS}
          >
            <option value="client_credentials">client_credentials</option>
            <option value="refresh_token">refresh_token</option>
          </select>
        </div>
        <div>
          <label className={labelClass}>
            {t('admin.credentials.form.scope', 'Scope (optional)')}
          </label>
          <input
            type="text"
            value={form.scope}
            onChange={e => update({ scope: e.target.value })}
            className={INPUT_CLASS}
          />
        </div>
        {form.grantType === 'refresh_token' && (
          <div>
            <label className={labelClass}>
              {t('admin.credentials.form.refreshToken', 'Refresh token')}
            </label>
            <input
              type="password"
              value={form.refreshToken}
              onChange={e => update({ refreshToken: e.target.value })}
              className={MONO_INPUT_CLASS}
              placeholder={isEdit ? REDACTED : ''}
            />
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{secretHint}</p>
          </div>
        )}
      </>
    );
  }

  return null;
}

function AdminCredentialsPage() {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [credentials, setCredentials] = useState([]);
  const [message, setMessage] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'new' | profileId
  const [form, setForm] = useState(BLANK_FORM);
  const [saving, setSaving] = useState(false);

  const isEdit = editing !== null && editing !== 'new';

  const load = async () => {
    setLoading(true);
    try {
      const list = await listCredentials();
      setCredentials(list);
    } catch (err) {
      setMessage({
        type: 'error',
        text: t('admin.credentials.loadError', 'Failed to load credentials: {{error}}', {
          error: err.message
        })
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, []);

  const update = patch => setForm(prev => ({ ...prev, ...patch }));

  const startCreate = () => {
    setForm(BLANK_FORM);
    setEditing('new');
  };

  const startEdit = profile => {
    setForm(profileToForm(profile));
    setEditing(profile.id);
  };

  const closeDialog = () => setEditing(null);

  const save = async () => {
    setSaving(true);
    try {
      const payload = formToPayload(form, isEdit);
      if (isEdit) {
        await updateCredential(editing, payload);
      } else {
        await createCredential(payload);
      }
      setMessage({ type: 'success', text: t('admin.credentials.saved', 'Credential saved') });
      closeDialog();
      await load();
    } catch (err) {
      setMessage({
        type: 'error',
        text: t('admin.credentials.saveError', 'Save failed: {{error}}', {
          error: err.response?.data?.error || err.message
        })
      });
    } finally {
      setSaving(false);
    }
  };

  const remove = async id => {
    if (
      !window.confirm(
        t('admin.credentials.deleteConfirm', 'Delete credential "{{id}}"? This cannot be undone.', {
          id
        })
      )
    )
      return;
    try {
      await deleteCredential(id);
      setMessage({ type: 'success', text: t('admin.credentials.deleted', 'Credential deleted') });
      await load();
    } catch (err) {
      setMessage({
        type: 'error',
        text: t('admin.credentials.deleteError', 'Delete failed: {{error}}', {
          error: err.response?.data?.error || err.message
        })
      });
    }
  };

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-center py-16">
          <LoadingSpinner size="lg" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex justify-between items-start mb-6">
        <div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
            {t('admin.credentials.title', 'Credentials')}
          </h1>
          <p className="text-gray-600 dark:text-gray-400 mt-1">
            {t(
              'admin.credentials.subtitle',
              'Named, encrypted auth profiles referenced by tools and integrations via credentialRef.'
            )}
          </p>
        </div>
        <button
          onClick={startCreate}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700"
        >
          <Icon name="plus" size="md" className="mr-2" />
          {t('admin.credentials.create', 'Add credential')}
        </button>
      </div>

      {message && (
        <div
          className={`mb-6 p-4 rounded-md border ${
            message.type === 'success'
              ? 'bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-800 text-green-700 dark:text-green-300'
              : 'bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300'
          }`}
        >
          {message.text}
        </div>
      )}

      {credentials.length === 0 ? (
        <div className="text-center py-12 bg-white dark:bg-gray-800 rounded-lg shadow">
          <Icon name="key" className="mx-auto h-12 w-12 text-gray-400" />
          <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
            {t('admin.credentials.empty', 'No credentials configured')}
          </h3>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 shadow overflow-hidden sm:rounded-md">
          <ul className="divide-y divide-gray-200 dark:divide-gray-700">
            {credentials.map(c => (
              <li key={c.id} className="px-4 py-4 sm:px-6">
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center space-x-3">
                      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 truncate">
                        {typeof c.name === 'string' ? c.name : c.name?.en || c.id}
                      </h3>
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300">
                        {typeLabel(c.type, t)}
                      </span>
                    </div>
                    <div className="mt-1 text-sm text-gray-500 dark:text-gray-400 font-mono">
                      {c.id}
                    </div>
                    {(typeof c.description === 'string' ? c.description : c.description?.en) && (
                      <div className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                        {typeof c.description === 'string' ? c.description : c.description.en}
                      </div>
                    )}
                  </div>
                  <div className="flex space-x-2 ml-4">
                    <button
                      onClick={() => startEdit(c)}
                      className="inline-flex items-center px-3 py-2 border border-gray-300 dark:border-gray-600 shadow-sm text-sm leading-4 font-medium rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600"
                    >
                      <Icon name="pencil" size="sm" />
                    </button>
                    <button
                      onClick={() => remove(c.id)}
                      className="inline-flex items-center px-3 py-2 border border-red-300 dark:border-red-700 shadow-sm text-sm leading-4 font-medium rounded-md text-red-700 dark:text-red-400 bg-white dark:bg-gray-700 hover:bg-red-50 dark:hover:bg-red-900/50"
                    >
                      <Icon name="trash" size="sm" />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {editing !== null && (
        <div className="fixed z-10 inset-0 overflow-y-auto">
          <div className="flex items-center justify-center min-h-screen px-4">
            <div className="fixed inset-0 bg-gray-500 dark:bg-gray-900 bg-opacity-75 dark:bg-opacity-75" />
            <div className="relative bg-white dark:bg-gray-800 rounded-lg p-6 max-w-2xl w-full shadow-xl space-y-4 max-h-[90vh] overflow-y-auto">
              <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
                {isEdit
                  ? t('admin.credentials.editTitle', 'Edit credential {{id}}', { id: editing })
                  : t('admin.credentials.createTitle', 'Create credential')}
              </h2>

              {!isEdit && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('admin.credentials.form.id', 'ID')}
                    <span className="text-red-500 ml-0.5">*</span>
                  </label>
                  <input
                    type="text"
                    value={form.id}
                    onChange={e => update({ id: e.target.value })}
                    className={MONO_INPUT_CLASS}
                    placeholder="my-api-credential"
                  />
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('admin.credentials.form.name', 'Name')}
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => update({ name: e.target.value })}
                  className={INPUT_CLASS}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('admin.credentials.form.description', 'Description')}
                </label>
                <textarea
                  rows={2}
                  value={form.description}
                  onChange={e => update({ description: e.target.value })}
                  className={INPUT_CLASS}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('admin.credentials.form.type', 'Type')}
                </label>
                <select
                  value={form.type}
                  onChange={e => update({ type: e.target.value })}
                  disabled={isEdit}
                  className={INPUT_CLASS}
                >
                  {CREDENTIAL_TYPES.map(type => (
                    <option key={type} value={type}>
                      {typeLabel(type, t)}
                    </option>
                  ))}
                </select>
                {isEdit && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {t(
                      'admin.credentials.form.typeLocked',
                      'Type cannot be changed after creation. Delete and recreate to change type.'
                    )}
                  </p>
                )}
              </div>

              <fieldset className="border border-gray-200 dark:border-gray-700 rounded p-3 space-y-3">
                <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 px-1">
                  {t('admin.credentials.form.details', 'Credential details')}
                </legend>
                <TypeFields form={form} update={update} isEdit={isEdit} t={t} />
              </fieldset>

              <div className="flex justify-end space-x-2 pt-2">
                <button
                  onClick={closeDialog}
                  className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700"
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button
                  onClick={save}
                  disabled={saving || !form.id}
                  className="px-4 py-2 rounded text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
                >
                  {saving ? t('common.saving', 'Saving…') : t('common.save', 'Save')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default AdminCredentialsPage;
