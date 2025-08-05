import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminNavigation from '../components/AdminNavigation';
import {
  fetchAdminPrompts,
  createPrompt,
  updatePrompt,
  fetchAdminApps
} from '../../../api/adminApi';
import { clearApiCache } from '../../../api/api';
import { fetchUIConfig } from '../../../api';
import { fetchJsonSchema } from '../../../utils/schemaService';
import DualModeEditor from '../../../shared/components/DualModeEditor';
import PromptFormEditor from '../components/PromptFormEditor';

const AdminPromptEditPage = () => {
  const { t, i18n } = useTranslation();
  const { promptId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const isNewPrompt = promptId === 'new';

  const [promptData, setPromptData] = useState({
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
  });

  const [loading, setLoading] = useState(!isNewPrompt);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [apps, setApps] = useState([]);
  const [uiConfig, setUiConfig] = useState(null);
  const [jsonSchema, setJsonSchema] = useState(null);

  useEffect(() => {
    if (isNewPrompt && location.state?.templatePrompt) {
      const tpl = location.state.templatePrompt;
      setPromptData(prev => ({
        ...prev,
        ...tpl,
        id: '',
        enabled: tpl.enabled !== false
      }));
    }
  }, [isNewPrompt, location.state]);

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
    loadJsonSchema();

    if (!isNewPrompt) {
      loadPrompt();
    }
  }, [promptId, isNewPrompt]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const loadPrompt = useCallback(async () => {
    try {
      setLoading(true);
      const data = await fetchAdminPrompts();
      const promptDataFromApi = data.find(p => p.id === promptId);

      if (!promptDataFromApi) {
        throw new Error('Prompt not found');
      }

      // Ensure proper structure for editing
      const processedPrompt = {
        ...promptDataFromApi,
        name: promptDataFromApi.name || { en: '' },
        description: promptDataFromApi.description || { en: '' },
        prompt: promptDataFromApi.prompt || { en: '' },
        variables: promptDataFromApi.variables || [],
        appId: promptDataFromApi.appId || '',
        order: promptDataFromApi.order,
        enabled: promptDataFromApi.enabled !== false
      };

      setPromptData(processedPrompt);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [promptId]);

  const handleSave = async data => {
    try {
      setSaving(true);

      if (isNewPrompt) {
        await createPrompt(data);
      } else {
        await updatePrompt(promptId, data);
      }

      // Clear cache to force refresh
      clearApiCache('admin_prompts');
      clearApiCache('prompts');

      // Redirect to prompts list
      navigate('/admin/prompts');
    } catch (err) {
      console.error('Error saving prompt:', err);
      throw err; // Re-throw to let DualModeEditor handle it
    } finally {
      setSaving(false);
    }
  };

  const handleDataChange = newData => {
    setPromptData(newData);
  };

  const handleFormSubmit = async e => {
    e.preventDefault();
    await handleSave(promptData);
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-red-50 border border-red-200 rounded-md p-4">
          <div className="flex">
            <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800">
                {t('admin.prompts.edit.loadError', 'Error loading prompt')}
              </h3>
              <p className="mt-1 text-sm text-red-700">{error}</p>
              <button
                onClick={() => navigate('/admin/prompts')}
                className="mt-2 text-sm text-red-600 hover:text-red-500"
              >
                {t('admin.prompts.edit.backToList', 'Back to Prompts')}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <AdminNavigation />
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-gray-900">
                {isNewPrompt
                  ? t('admin.prompts.edit.createTitle', 'Create New Prompt')
                  : t('admin.prompts.edit.editTitle', 'Edit Prompt')}
              </h1>
              <p className="mt-1 text-sm text-gray-600">
                {isNewPrompt
                  ? t('admin.prompts.edit.createDesc', 'Create a new prompt for your AI Hub Apps')
                  : t('admin.prompts.edit.editDesc', 'Edit the prompt details and configuration')}
              </p>
            </div>
            <div className="flex space-x-3">
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
                  className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
                >
                  <Icon name="download" className="h-4 w-4 mr-2" />
                  {t('common.download')}
                </button>
              )}
              <button
                onClick={() => navigate('/admin/prompts')}
                className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                <Icon name="arrow-left" className="h-4 w-4 mr-2" />
                {t('admin.prompts.edit.backToList', 'Back to Prompts')}
              </button>
            </div>
          </div>
        </div>

        <form onSubmit={handleFormSubmit} className="space-y-8">
          <DualModeEditor
            value={promptData}
            onChange={handleDataChange}
            formComponent={PromptFormEditor}
            formProps={{
              isNewPrompt,
              apps,
              categories: uiConfig?.promptsList?.categories?.list || []
            }}
            jsonSchema={jsonSchema}
            title={
              isNewPrompt
                ? t('admin.prompts.edit.createTitle', 'Create New Prompt')
                : t('admin.prompts.edit.editTitle', 'Edit Prompt')
            }
          />

          {/* Save buttons */}
          <div className="flex justify-end space-x-4">
            <button
              type="button"
              onClick={() => navigate('/admin/prompts')}
              className="px-4 py-2 border border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            >
              {t('admin.prompts.edit.cancel', 'Cancel')}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
            >
              {saving ? (
                <>
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2 inline-block"></div>
                  {t('admin.prompts.edit.saving', 'Saving...')}
                </>
              ) : (
                t('admin.prompts.edit.save', 'Save Prompt')
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default AdminPromptEditPage;
