// SPDX-FileCopyrightText: IntraFind Software AG
// SPDX-License-Identifier: LicenseRef-iHub-Apps

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminEditPageShell, {
  AdminSaveCancelButtons
} from '../../../shared/components/AdminEditPageShell';
import { useAdminResourceEditor } from '../hooks/useAdminResourceEditor';
import ContentAccessSection from '../components/ContentAccessSection';
import {
  createPrompt,
  fetchAdminApps,
  fetchAdminPrompts,
  getAdminApiErrorMessage,
  updatePrompt
} from '../../../api/adminApi';
import { clearApiCache, fetchUIConfig } from '../../../api';
import { fetchJsonSchema } from '../../../utils/schemaService';
import DualModeEditor from '../../../shared/components/DualModeEditor';
import PromptFormEditor from '../components/PromptFormEditor';
import ChangeHistoryDrawer from '../components/ChangeHistoryDrawer';
import AdminLoadError from '../components/AdminLoadError';

function AdminPromptEditPage() {
  const { t } = useTranslation();
  const { promptId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [apps, setApps] = useState([]);
  const [uiConfig, setUiConfig] = useState(null);
  const [jsonSchema, setJsonSchema] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  // What the form reports (`{ isValid, errors }`) and in which mode the editor is: a save
  // from the form waits until the form is valid; the JSON mode keeps the server's check.
  const [formValidation, setFormValidation] = useState({ isValid: true, errors: [] });
  const [editorMode, setEditorMode] = useState('form');
  // Save attempts that the form refused; from the first one on every error shows.
  const [saveAttempts, setSaveAttempts] = useState(0);
  // IDs of the existing prompts, so a new prompt hears "taken" before it is saved, and the
  // ID the server refused as taken (409) after a save.
  const [existingIds, setExistingIds] = useState([]);
  const [refusedId, setRefusedId] = useState(null);
  const takenIds = useMemo(
    () => (refusedId ? [...existingIds, refusedId] : existingIds),
    [existingIds, refusedId]
  );

  const {
    data: promptData,
    setData: setPromptData,
    loading,
    error,
    isNew: isNewPrompt,
    save,
    blocker
  } = useAdminResourceEditor({
    resourceId: promptId,
    loadResource: async id => {
      const data = await fetchAdminPrompts();
      const promptDataFromApi = data.find(p => p.id === id);

      if (!promptDataFromApi) {
        throw new Error('Prompt not found');
      }

      // Ensure proper structure for editing
      return {
        ...promptDataFromApi,
        name: promptDataFromApi.name || { en: '' },
        description: promptDataFromApi.description || { en: '' },
        prompt: promptDataFromApi.prompt || { en: '' },
        variables: promptDataFromApi.variables || [],
        appId: promptDataFromApi.appId || '',
        order: promptDataFromApi.order,
        enabled: promptDataFromApi.enabled !== false
      };
    },
    makeDefault: () => {
      const defaults = {
        id: '',
        name: { en: '' },
        description: { en: '' },
        prompt: { en: '' },
        icon: 'clipboard',
        enabled: true,
        order: undefined,
        appId: '',
        variables: [],
        category: 'creative'
      };
      const tpl = location.state?.templatePrompt;
      return tpl ? { ...defaults, ...tpl, id: '', enabled: tpl.enabled !== false } : defaults;
    },
    saveResource: async (data, id) => {
      if (id === 'new') {
        await createPrompt(data);
      } else {
        await updatePrompt(id, data);
      }

      // Clear cache to force refresh
      clearApiCache('admin_prompts');
      clearApiCache('prompts');
    }
  });

  useEffect(() => {
    // Load apps for the appId dropdown, UI config, and JSON schema
    const loadJsonSchema = async () => {
      try {
        const schema = await fetchJsonSchema('prompt');
        setJsonSchema(schema);
      } catch (err) {
        console.error('Failed to load prompt JSON schema:', err);
        // Continue without schema - validation will be server-side only
      }
    };

    loadApps();
    loadUIConfig();
    void loadJsonSchema();
  }, [promptId]); // eslint-disable-line @eslint-react/exhaustive-deps

  // A new prompt's ID must not be taken; the list is checked while the admin types.
  useEffect(() => {
    if (!isNewPrompt) return undefined;
    let cancelled = false;
    fetchAdminPrompts()
      .then(items => {
        if (!cancelled && Array.isArray(items)) setExistingIds(items.map(prompt => prompt.id));
      })
      .catch(() => {
        // Without the list the server still refuses a taken ID on save.
      });
    return () => {
      cancelled = true;
    };
  }, [isNewPrompt]);

  const loadApps = useCallback(async () => {
    try {
      const data = await fetchAdminApps();
      setApps(data);
    } catch (err) {
      console.error('Error loading apps:', err);
    }
  }, []);

  const loadUIConfig = useCallback(async () => {
    try {
      const config = await fetchUIConfig();
      setUiConfig(config);
    } catch (err) {
      console.error('Failed to load UI config:', err);
    }
  }, []);

  const handleSave = async () => {
    try {
      setSaving(true);
      setSaveError(null);

      await save();

      // Redirect to prompts list
      navigate('/admin/prompts');
    } catch (err) {
      // A taken ID belongs to the ID field: the form says it there and in its summary.
      if (isNewPrompt && err?.response?.status === 409) {
        setRefusedId(promptData?.id);
        setSaveAttempts(count => count + 1);
        return;
      }
      setSaveError(getAdminApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const handleDataChange = newData => {
    setPromptData(newData);
  };

  /**
   * The form saves only when it is valid: otherwise every error shows, with the summary on
   * top. Checks left to the browser come next, with the browser's own message.
   */
  const handleFormSubmit = async e => {
    e.preventDefault();
    if (editorMode === 'form' && !formValidation.isValid) {
      setSaveAttempts(count => count + 1);
      return;
    }
    if (typeof e.currentTarget?.reportValidity === 'function' && !e.currentTarget.reportValidity())
      return;
    await handleSave();
  };

  if (error) {
    return (
      <AdminLoadError
        title={t('admin.prompts.edit.loadError', 'Error loading prompt')}
        message={error}
        action={{
          label: t('admin.prompts.edit.backToList', 'Back to Prompts'),
          onClick: () => navigate('/admin/prompts')
        }}
      />
    );
  }

  return (
    <AdminEditPageShell
      loading={loading}
      loadingFallback={
        <div className="flex justify-center items-center h-64">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 dark:border-indigo-400"></div>
        </div>
      }
      breadcrumbs={[
        { label: t('documentTitle.admin', 'Admin'), href: '/admin' },
        { label: t('admin.nav.prompts', 'Prompts'), href: '/admin/prompts' },
        {
          label: isNewPrompt
            ? t('admin.breadcrumbs.newPrompt', 'New Prompt')
            : (promptData?.name?.en ?? promptId)
        }
      ]}
      blocker={blocker}
      extra={
        <ChangeHistoryDrawer
          isOpen={historyOpen}
          onClose={() => setHistoryOpen(false)}
          resource="prompt"
          resourceId={promptId}
        />
      }
    >
      <div className="mb-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
              {isNewPrompt
                ? t('admin.prompts.edit.createTitle', 'Create New Prompt')
                : t('admin.prompts.edit.editTitle', 'Edit Prompt')}
            </h1>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {isNewPrompt
                ? t('admin.prompts.edit.createDesc', 'Create a new prompt for your iHub Apps')
                : t('admin.prompts.edit.editDesc', 'Edit the prompt details and configuration')}
            </p>
          </div>
          <div className="flex space-x-3">
            {!isNewPrompt && (
              <button
                type="button"
                onClick={() => setHistoryOpen(true)}
                className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 shadow-xs text-sm font-medium rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="clock" className="h-4 w-4 mr-2" />
                {t('admin.prompts.edit.history', 'History')}
              </button>
            )}
            {!isNewPrompt && (
              <button
                type="button"
                onClick={() => {
                  const dataStr = JSON.stringify(promptData, null, 2);
                  const dataUri =
                    'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
                  const exportFileDefaultName = `prompt-${promptData.id}.json`;
                  const linkElement = document.createElement('a');
                  linkElement.setAttribute('href', dataUri);
                  linkElement.setAttribute('download', exportFileDefaultName);
                  linkElement.click();
                }}
                className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 shadow-xs text-sm font-medium rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="download" className="h-4 w-4 mr-2" />
                {t('common.download')}
              </button>
            )}
            <button
              onClick={() => navigate('/admin/prompts')}
              className="inline-flex items-center px-4 py-2 border border-gray-300 dark:border-gray-600 shadow-xs text-sm font-medium rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            >
              <Icon name="arrow-left" className="h-4 w-4 mr-2" />
              {t('admin.prompts.edit.backToList', 'Back to Prompts')}
            </button>
          </div>
        </div>
      </div>

      {saveError && (
        <div className="mb-6 rounded-md bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 p-4">
          <div className="flex">
            <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800 dark:text-red-200">
                {t('admin.prompts.errorTitle', 'Error')}
              </h3>
              <p className="mt-1 text-sm text-red-700 dark:text-red-300">{saveError}</p>
            </div>
          </div>
        </div>
      )}

      {/* noValidate: the form's own messages come first (see handleFormSubmit). */}
      <form onSubmit={handleFormSubmit} noValidate className="space-y-8">
        <DualModeEditor
          value={promptData}
          onChange={handleDataChange}
          formComponent={PromptFormEditor}
          onValidationChange={setFormValidation}
          onModeChange={setEditorMode}
          formProps={{
            isNewPrompt,
            showAllErrors: saveAttempts > 0,
            summaryFocusKey: saveAttempts,
            takenIds,
            apps,
            categories: uiConfig?.promptsList?.categories?.list || [],
            jsonSchema
          }}
          jsonSchema={jsonSchema}
          title={
            isNewPrompt
              ? t('admin.prompts.edit.createTitle', 'Create New Prompt')
              : t('admin.prompts.edit.editTitle', 'Edit Prompt')
          }
        />

        {/* Group access — which groups may use this prompt (groups.json) */}
        <ContentAccessSection resourceType="prompts" resourceId={promptId} isNew={isNewPrompt} />

        {/* Save buttons */}
        <AdminSaveCancelButtons
          onCancel={() => navigate('/admin/prompts')}
          cancelLabel={t('admin.prompts.edit.cancel', 'Cancel')}
          saving={saving}
          saveLabel={t('admin.prompts.edit.save', 'Save Prompt')}
          savingLabel={t('admin.prompts.edit.saving', 'Saving...')}
          cancelClassName="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-xs text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
          saveClassName="px-4 py-2 border border-transparent rounded-md shadow-xs text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-hidden focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
        />
      </form>
    </AdminEditPageShell>
  );
}

export default AdminPromptEditPage;
