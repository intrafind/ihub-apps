import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createMarketplaceRegistry,
  updateMarketplaceRegistry,
  testMarketplaceRegistry
} from '../../../../api/adminApi';

/**
 * Modal dialog for creating or editing a marketplace registry.
 *
 * Supports four authentication types for secured registry URLs:
 * - none: No authentication
 * - bearer: Bearer token in Authorization header
 * - basic: HTTP Basic Auth (username + password)
 * - header: Custom HTTP header (name + value)
 *
 * Also allows configuring auto-refresh intervals for periodic catalog syncing.
 *
 * @param {Object} props
 * @param {Object|null} props.registry - Existing registry for editing, or null for create mode
 * @param {Function} props.onSave - Callback invoked after successful save
 * @param {Function} props.onCancel - Callback invoked when the dialog is dismissed
 */
const RegistryFormDialog = ({ registry, onSave, onCancel }) => {
  const { t } = useTranslation();
  const isEdit = !!registry;

  const [form, setForm] = useState({
    id: '',
    name: '',
    description: '',
    source: '',
    auth: { type: 'none' },
    enabled: true,
    autoRefresh: false,
    refreshIntervalHours: 24
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [errors, setErrors] = useState({});

  /** Populate form fields when editing an existing registry */
  useEffect(() => {
    if (registry) {
      setForm({
        id: registry.id,
        name: registry.name,
        description: registry.description || '',
        source: registry.source,
        auth: registry.auth || { type: 'none' },
        enabled: registry.enabled ?? true,
        autoRefresh: registry.autoRefresh ?? false,
        refreshIntervalHours: registry.refreshIntervalHours ?? 24
      });
    }
  }, [registry]);

  /**
   * Updates a top-level form field and clears its validation error.
   *
   * @param {string} field - The form field name
   * @param {*} value - The new value
   */
  const set = (field, value) => {
    setForm(f => ({ ...f, [field]: value }));
    setErrors(e => ({ ...e, [field]: undefined }));
  };

  /**
   * Updates a field within the auth sub-object.
   *
   * @param {string} field - The auth field name (type, token, username, etc.)
   * @param {*} value - The new value
   */
  const setAuth = (field, value) => {
    setForm(f => ({ ...f, auth: { ...f.auth, [field]: value } }));
  };

  /**
   * Validates all required form fields.
   *
   * @returns {Object} Map of field names to error messages (empty if valid)
   */
  const validate = () => {
    const errs = {};
    if (!form.name.trim()) {
      errs.name = t('admin.marketplace.registries.form.nameRequired', 'Name is required');
    }
    if (!form.source.trim()) {
      errs.source = t('admin.marketplace.registries.form.sourceRequired', 'Source URL is required');
    }
    if (!isEdit && !form.id.trim()) {
      errs.id = t('admin.marketplace.registries.form.idRequired', 'ID is required');
    }
    if (!isEdit && form.id && !/^[a-z0-9-]+$/.test(form.id)) {
      errs.id = t(
        'admin.marketplace.registries.form.idInvalid',
        'ID must contain only lowercase letters, numbers, and hyphens'
      );
    }
    return errs;
  };

  /**
   * Tests connectivity to the configured registry URL.
   * Displays inline success or error feedback without blocking the form.
   */
  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testMarketplaceRegistry({ source: form.source, auth: form.auth });
      setTestResult(result);
    } catch (err) {
      setTestResult({ success: false, message: err.message });
    } finally {
      setTesting(false);
    }
  };

  /**
   * Submits the form to create or update the registry.
   * Validates before submitting and reports server-side errors inline.
   *
   * @param {React.FormEvent} e - The form submission event
   */
  const handleSubmit = async e => {
    e.preventDefault();
    const errs = validate();
    if (Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }

    setSaving(true);
    try {
      if (isEdit) {
        await updateMarketplaceRegistry(registry.id, form);
      } else {
        await createMarketplaceRegistry(form);
      }
      onSave();
    } catch (err) {
      setErrors({ _global: err.message || 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Dialog header */}
        <div className="flex items-center justify-between p-6 border-b border-gray-200 dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            {isEdit
              ? t('admin.marketplace.registries.form.editTitle', 'Edit Registry')
              : t('admin.marketplace.registries.form.addTitle', 'Add Registry')}
          </h2>
          <button
            onClick={onCancel}
            className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
            aria-label={t('common.close', 'Close')}
          >
            &#x2715;
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          {/* Global error banner */}
          {errors._global && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
              {errors._global}
            </div>
          )}

          {/* Registry ID - only shown when creating */}
          {!isEdit && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('admin.marketplace.registries.form.id', 'Registry ID')} *
              </label>
              <input
                type="text"
                value={form.id}
                onChange={e => set('id', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                placeholder="my-registry"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
              />
              {errors.id && <p className="text-red-500 text-xs mt-1">{errors.id}</p>}
            </div>
          )}

          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('admin.marketplace.registries.form.name', 'Name')} *
            </label>
            <input
              type="text"
              value={form.name}
              onChange={e => set('name', e.target.value)}
              placeholder="My Registry"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
            />
            {errors.name && <p className="text-red-500 text-xs mt-1">{errors.name}</p>}
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('admin.marketplace.registries.form.description', 'Description')}
            </label>
            <input
              type="text"
              value={form.description}
              onChange={e => set('description', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
            />
          </div>

          {/* Catalog URL */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('admin.marketplace.registries.form.source', 'Catalog URL')} *
            </label>
            <input
              type="url"
              value={form.source}
              onChange={e => set('source', e.target.value)}
              placeholder="https://example.com/catalog.json"
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm font-mono"
            />
            {errors.source && <p className="text-red-500 text-xs mt-1">{errors.source}</p>}
          </div>

          {/* Authentication type selector */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('admin.marketplace.registries.form.authType', 'Authentication')}
            </label>
            <select
              value={form.auth.type}
              onChange={e => setAuth('type', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
            >
              <option value="none">{t('admin.marketplace.registries.auth.none', 'None')}</option>
              <option value="bearer">
                {t('admin.marketplace.registries.auth.bearer', 'Bearer Token')}
              </option>
              <option value="basic">
                {t('admin.marketplace.registries.auth.basic', 'Basic Auth')}
              </option>
              <option value="header">
                {t('admin.marketplace.registries.auth.header', 'Custom Header')}
              </option>
            </select>
          </div>

          {/* Bearer token input */}
          {form.auth.type === 'bearer' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Token
              </label>
              <input
                type="password"
                value={form.auth.token || ''}
                onChange={e => setAuth('token', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm font-mono"
              />
            </div>
          )}

          {/* Basic auth inputs */}
          {form.auth.type === 'basic' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Username
                </label>
                <input
                  type="text"
                  value={form.auth.username || ''}
                  onChange={e => setAuth('username', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Password
                </label>
                <input
                  type="password"
                  value={form.auth.password || ''}
                  onChange={e => setAuth('password', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                />
              </div>
            </div>
          )}

          {/* Custom header inputs */}
          {form.auth.type === 'header' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Header Name
                </label>
                <input
                  type="text"
                  value={form.auth.headerName || ''}
                  onChange={e => setAuth('headerName', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  Header Value
                </label>
                <input
                  type="password"
                  value={form.auth.headerValue || ''}
                  onChange={e => setAuth('headerValue', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                />
              </div>
            </div>
          )}

          {/* Test connection button and inline result */}
          <div>
            <button
              type="button"
              onClick={handleTest}
              disabled={testing || !form.source}
              className="text-sm text-blue-600 hover:text-blue-700 disabled:opacity-50"
            >
              {testing
                ? t('admin.marketplace.registries.form.testing', 'Testing...')
                : t('admin.marketplace.registries.form.testConnection', 'Test Connection')}
            </button>
            {testResult && (
              <div
                className={`mt-2 p-2 rounded text-sm ${
                  testResult.success
                    ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300'
                    : 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300'
                }`}
              >
                {testResult.message}
              </div>
            )}
          </div>

          {/* Auto refresh toggle with interval hours input */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => set('autoRefresh', !form.autoRefresh)}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                form.autoRefresh ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
              }`}
              aria-label={t('admin.marketplace.registries.form.autoRefresh', 'Auto Refresh')}
            >
              <span
                className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
                  form.autoRefresh ? 'translate-x-5' : 'translate-x-1'
                }`}
              />
            </button>
            <label className="text-sm text-gray-700 dark:text-gray-300">
              {t('admin.marketplace.registries.form.autoRefresh', 'Auto Refresh')}
            </label>
            {form.autoRefresh && (
              <div className="flex items-center gap-2 ml-4">
                <input
                  type="number"
                  min="1"
                  max="168"
                  value={form.refreshIntervalHours}
                  onChange={e => set('refreshIntervalHours', parseInt(e.target.value))}
                  className="w-16 px-2 py-1 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-sm text-gray-900 dark:text-white"
                />
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  {t('admin.marketplace.registries.form.hours', 'hours')}
                </span>
              </div>
            )}
          </div>

          {/* Footer buttons */}
          <div className="flex justify-end gap-3 pt-4 border-t border-gray-200 dark:border-gray-700">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200"
            >
              {t('common.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
            >
              {saving ? t('common.saving', 'Saving...') : t('common.save', 'Save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default RegistryFormDialog;
