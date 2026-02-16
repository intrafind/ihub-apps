import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import DynamicLanguageEditor from '../../../shared/components/DynamicLanguageEditor';
import AdminNavigation from '../components/AdminNavigation';
import AdminAuth from '../components/AdminAuth';
import {
  fetchAdminWorkflow,
  createAdminWorkflow,
  updateAdminWorkflow,
  deleteAdminWorkflow
} from '../../../api/adminApi';

/**
 * Admin page for editing or creating a single workflow definition.
 * Provides metadata editing, group-based permissions, and a full JSON editor.
 *
 * URL patterns:
 * - /admin/workflows/new  : Create a new workflow
 * - /admin/workflows/:id  : Edit an existing workflow
 *
 * Follows the same patterns as AdminToolEditPage.jsx.
 */
const AdminWorkflowEditPage = () => {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const isNewWorkflow = !id;

  const [loading, setLoading] = useState(!isNewWorkflow);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [jsonError, setJsonError] = useState(null);

  // Workflow JSON as a string for the textarea editor
  const [jsonText, setJsonText] = useState('');

  // Parsed workflow data for the metadata form fields
  const [workflowData, setWorkflowData] = useState(null);

  /**
   * Returns a default empty workflow template for new workflows.
   * @returns {Object} Default workflow configuration
   */
  const getDefaultWorkflow = () => ({
    id: '',
    name: { en: '' },
    description: { en: '' },
    version: '1.0.0',
    enabled: true,
    config: {
      observability: 'standard',
      persistence: 'session',
      errorHandling: 'retry',
      humanInLoop: 'none',
      maxExecutionTime: 300000,
      maxNodes: 20
    },
    nodes: [],
    edges: []
  });

  useEffect(() => {
    if (!isNewWorkflow) {
      loadWorkflow();
    } else {
      const defaultWf = getDefaultWorkflow();
      setWorkflowData(defaultWf);
      setJsonText(JSON.stringify(defaultWf, null, 2));
    }
  }, [id, isNewWorkflow]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Loads an existing workflow definition by ID from the API.
   */
  const loadWorkflow = async () => {
    try {
      setLoading(true);
      setError(null);

      const workflow = await fetchAdminWorkflow(id);

      if (!workflow) {
        throw new Error('Workflow not found');
      }

      setWorkflowData(workflow);
      setJsonText(JSON.stringify(workflow, null, 2));
    } catch (err) {
      console.error('Error loading workflow:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Handles changes to the JSON textarea.
   * Validates JSON on each change and updates the parsed data if valid.
   * @param {string} text - The raw JSON text from the textarea
   */
  const handleJsonChange = text => {
    setJsonText(text);
    setJsonError(null);

    try {
      const parsed = JSON.parse(text);
      setWorkflowData(parsed);
      setJsonError(null);
    } catch (err) {
      setJsonError(err.message);
    }
  };

  /**
   * Handles changes to metadata form fields.
   * Updates both the parsed data object and the JSON text representation.
   * @param {string} field - Dot-notation field path (e.g., 'name.en')
   * @param {*} value - The new field value
   */
  const handleMetadataChange = (field, value) => {
    const updated = { ...workflowData };

    // Support nested field paths like 'name.en'
    const parts = field.split('.');
    let target = updated;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!target[parts[i]]) {
        target[parts[i]] = {};
      }
      target = target[parts[i]];
    }
    target[parts[parts.length - 1]] = value;

    setWorkflowData(updated);
    setJsonText(JSON.stringify(updated, null, 2));
    setJsonError(null);
  };

  /**
   * Handles changes from DynamicLanguageEditor for localized fields.
   * @param {string} field - Top-level field name (e.g., 'name', 'description')
   * @param {Object} value - The localized object { en: '...', de: '...' }
   */
  const handleLocalizedChange = (field, value) => {
    const updated = { ...workflowData, [field]: value };
    setWorkflowData(updated);
    setJsonText(JSON.stringify(updated, null, 2));
    setJsonError(null);
  };

  /**
   * Saves the workflow to the server.
   * Creates a new workflow or updates an existing one.
   */
  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);

      // Ensure JSON is valid
      if (jsonError) {
        throw new Error(t('admin.workflows.invalidJson', 'Please fix JSON errors before saving'));
      }

      // Parse the latest JSON text
      let dataToSave;
      try {
        dataToSave = JSON.parse(jsonText);
      } catch (err) {
        throw new Error(`Invalid JSON: ${err.message}`);
      }

      // Validate required fields
      if (!dataToSave.id) {
        throw new Error(t('admin.workflows.idRequired', 'Workflow ID is required'));
      }
      if (!dataToSave.name) {
        throw new Error(t('admin.workflows.nameRequired', 'Workflow name is required'));
      }

      if (isNewWorkflow) {
        await createAdminWorkflow(dataToSave);
      } else {
        await updateAdminWorkflow(id, dataToSave);
      }

      navigate('/admin/workflows');
    } catch (err) {
      console.error('Error saving workflow:', err);
      setError(err.message || 'Failed to save workflow');
    } finally {
      setSaving(false);
    }
  };

  /**
   * Deletes the current workflow after user confirmation.
   */
  const handleDelete = async () => {
    if (
      !confirm(t('admin.workflows.deleteConfirm', 'Are you sure you want to delete this workflow?'))
    ) {
      return;
    }

    try {
      setSaving(true);
      await deleteAdminWorkflow(id);
      navigate('/admin/workflows');
    } catch (err) {
      console.error('Error deleting workflow:', err);
      setError(err.message || 'Failed to delete workflow');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
        </div>
      </AdminAuth>
    );
  }

  return (
    <AdminAuth>
      <div>
        <AdminNavigation />
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* Header */}
          <div className="md:flex md:items-center md:justify-between mb-6">
            <div className="flex-1 min-w-0">
              <h1 className="text-2xl font-semibold text-gray-900">
                {isNewWorkflow
                  ? t('admin.workflows.createNew', 'Create New Workflow')
                  : t('admin.workflows.editWorkflow', 'Edit Workflow')}
              </h1>
              <p className="mt-1 text-sm text-gray-500">
                {isNewWorkflow
                  ? t(
                      'admin.workflows.createDescription',
                      'Create a new agentic workflow definition'
                    )
                  : t(
                      'admin.workflows.editDescription',
                      'Edit workflow configuration and permissions'
                    )}
              </p>
            </div>
            <div className="mt-4 flex space-x-3 md:mt-0 md:ml-4">
              {!isNewWorkflow && (
                <button
                  onClick={handleDelete}
                  disabled={saving}
                  className="inline-flex items-center px-4 py-2 border border-red-300 rounded-md shadow-sm text-sm font-medium text-red-700 bg-white hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 disabled:opacity-50"
                >
                  <Icon name="trash" className="h-4 w-4 mr-2" />
                  {t('common.delete', 'Delete')}
                </button>
              )}
              <button
                onClick={() => navigate('/admin/workflows')}
                className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="arrow-left" className="h-4 w-4 mr-2" />
                {t('common.back', 'Back')}
              </button>
            </div>
          </div>

          {/* Error display */}
          {error && (
            <div className="mb-6 bg-red-50 border border-red-200 rounded-md p-4">
              <div className="flex">
                <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
                <div className="ml-3">
                  <h3 className="text-sm font-medium text-red-800">{t('common.error', 'Error')}</h3>
                  <p className="mt-1 text-sm text-red-700">{error}</p>
                </div>
              </div>
            </div>
          )}

          {workflowData && (
            <>
              {/* Workflow Metadata Section */}
              <div className="bg-white shadow rounded-lg p-6 mb-6">
                <h2 className="text-lg font-medium text-gray-900 mb-4">
                  {t('admin.workflows.metadata', 'Workflow Metadata')}
                </h2>
                <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
                  {/* ID Field */}
                  <div>
                    <label
                      htmlFor="workflow-id"
                      className="block text-sm font-medium text-gray-700"
                    >
                      {t('admin.workflows.field.id', 'Workflow ID')}
                    </label>
                    <input
                      type="text"
                      id="workflow-id"
                      value={workflowData.id || ''}
                      onChange={e => handleMetadataChange('id', e.target.value)}
                      disabled={!isNewWorkflow}
                      className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm disabled:bg-gray-100 disabled:cursor-not-allowed"
                      placeholder="my-workflow"
                    />
                    {!isNewWorkflow && (
                      <p className="mt-1 text-xs text-gray-500">
                        {t(
                          'admin.workflows.idReadOnly',
                          'Workflow ID cannot be changed after creation'
                        )}
                      </p>
                    )}
                  </div>

                  {/* Version Field */}
                  <div>
                    <label
                      htmlFor="workflow-version"
                      className="block text-sm font-medium text-gray-700"
                    >
                      {t('admin.workflows.field.version', 'Version')}
                    </label>
                    <input
                      type="text"
                      id="workflow-version"
                      value={workflowData.version || ''}
                      onChange={e => handleMetadataChange('version', e.target.value)}
                      className="mt-1 block w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm"
                      placeholder="1.0.0"
                    />
                  </div>

                  {/* Name (localized) */}
                  <div className="sm:col-span-2">
                    <DynamicLanguageEditor
                      label={
                        <span>
                          {t('admin.workflows.field.name', 'Name')}
                          <span className="text-red-500 ml-1">*</span>
                        </span>
                      }
                      value={workflowData.name || {}}
                      onChange={value => handleLocalizedChange('name', value)}
                      required={true}
                    />
                  </div>

                  {/* Description (localized) */}
                  <div className="sm:col-span-2">
                    <DynamicLanguageEditor
                      label={t('admin.workflows.field.description', 'Description')}
                      value={workflowData.description || {}}
                      onChange={value => handleLocalizedChange('description', value)}
                      type="textarea"
                    />
                  </div>

                  {/* Enabled Toggle */}
                  <div className="sm:col-span-2">
                    <div className="flex items-center">
                      <button
                        type="button"
                        onClick={() => handleMetadataChange('enabled', !workflowData.enabled)}
                        className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 ${
                          workflowData.enabled !== false ? 'bg-indigo-600' : 'bg-gray-200'
                        }`}
                        role="switch"
                        aria-checked={workflowData.enabled !== false}
                      >
                        <span
                          className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                            workflowData.enabled !== false ? 'translate-x-5' : 'translate-x-0'
                          }`}
                        />
                      </button>
                      <span className="ml-3 text-sm font-medium text-gray-700">
                        {workflowData.enabled !== false
                          ? t('admin.workflows.enabled', 'Enabled')
                          : t('admin.workflows.disabled', 'Disabled')}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* JSON Editor Section */}
              <div className="bg-white shadow rounded-lg p-6 mb-6">
                <h2 className="text-lg font-medium text-gray-900 mb-2">
                  {t('admin.workflows.jsonEditor', 'JSON Editor')}
                </h2>
                <p className="text-sm text-gray-500 mb-4">
                  {t(
                    'admin.workflows.jsonEditorHelp',
                    'Edit the complete workflow configuration as JSON. Changes here will override the metadata fields above.'
                  )}
                </p>

                {jsonError && (
                  <div className="mb-4 bg-yellow-50 border border-yellow-200 rounded-md p-3">
                    <div className="flex">
                      <Icon
                        name="exclamation-triangle"
                        className="h-4 w-4 text-yellow-400 mt-0.5"
                      />
                      <div className="ml-2">
                        <p className="text-sm text-yellow-800">
                          {t('admin.workflows.jsonValidationError', 'JSON Validation Error:')}{' '}
                          {jsonError}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                <textarea
                  value={jsonText}
                  onChange={e => handleJsonChange(e.target.value)}
                  rows={25}
                  className={`w-full px-3 py-2 border rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 font-mono text-sm ${
                    jsonError ? 'border-yellow-300 bg-yellow-50' : 'border-gray-300'
                  }`}
                  style={{ fontFamily: 'monospace', tabSize: 2 }}
                  spellCheck={false}
                />
              </div>

              {/* Action Buttons */}
              <div className="flex justify-end space-x-3">
                <button
                  onClick={() => navigate('/admin/workflows')}
                  className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button
                  onClick={handleSave}
                  disabled={saving || !!jsonError}
                  className="inline-flex items-center px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
                >
                  {saving ? (
                    <>
                      <Icon name="refresh" className="animate-spin h-4 w-4 mr-2" />
                      {t('common.saving', 'Saving...')}
                    </>
                  ) : (
                    <>
                      <Icon name="check" className="h-4 w-4 mr-2" />
                      {t('common.save', 'Save')}
                    </>
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminWorkflowEditPage;
