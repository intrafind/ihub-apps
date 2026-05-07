import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import GlobalPromptVariablesEditor from '../components/GlobalPromptVariablesEditor';
import Icon from '../../../shared/components/Icon';
import { makeAdminApiCall } from '../../../api/adminApi';

function AdminPromptVariablesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState(null);
  const [message, setMessage] = useState(null);
  const [hasChanges, setHasChanges] = useState(false);

  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    try {
      setLoading(true);
      const response = await makeAdminApiCall('/admin/configs/platform', {
        method: 'GET'
      });
      setConfig(response.data);
      setMessage(null);
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.message || t('admin.promptVariables.loadError', 'Failed to load configuration')
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setMessage(null);

      await makeAdminApiCall('/admin/configs/platform', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(config)
      });

      setMessage({
        type: 'success',
        text: t('admin.promptVariables.saveSuccess', 'Prompt variables saved successfully')
      });
      setHasChanges(false);
    } catch (error) {
      setMessage({
        type: 'error',
        text: error.message || t('admin.promptVariables.saveError', 'Failed to save configuration')
      });
    } finally {
      setSaving(false);
    }
  };

  const handleChange = newGlobalPromptVariables => {
    setConfig({
      ...config,
      globalPromptVariables: newGlobalPromptVariables
    });
    setHasChanges(true);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
              {t('admin.promptVariables.title', 'Global Prompt Variables')}
            </h1>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              {t(
                'admin.promptVariables.description',
                'Manage global variables that can be used across all apps, system prompts, and user prompts. Built-in variables are automatically populated, and you can create custom variables for your organization.'
              )}
            </p>
          </div>
          <button
            onClick={() => navigate('/admin')}
            className="p-2 text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"
          >
            <Icon name="x" className="w-6 h-6" />
          </button>
        </div>
      </div>

      {/* Message Display */}
      {message && (
        <div
          className={`mb-6 p-4 rounded-lg ${
            message.type === 'error'
              ? 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-200 border border-red-200 dark:border-red-800'
              : 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-200 border border-green-200 dark:border-green-800'
          }`}
        >
          <div className="flex items-center">
            <Icon
              name={message.type === 'error' ? 'exclamation-circle' : 'check-circle'}
              className="w-5 h-5 mr-2"
            />
            <span>{message.text}</span>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700 p-6">
        {config && (
          <GlobalPromptVariablesEditor
            value={config.globalPromptVariables || { context: '', variables: {} }}
            onChange={handleChange}
          />
        )}
      </div>

      {/* Action Buttons */}
      <div className="mt-6 flex items-center justify-between">
        <button
          onClick={() => navigate('/admin')}
          className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
        >
          {t('common.cancel', 'Cancel')}
        </button>
        <button
          onClick={handleSave}
          disabled={saving || !hasChanges}
          className={`px-6 py-2 rounded-lg font-medium transition-colors ${
            saving || !hasChanges
              ? 'bg-gray-300 dark:bg-gray-600 text-gray-500 dark:text-gray-400 cursor-not-allowed'
              : 'bg-blue-600 hover:bg-blue-700 text-white'
          }`}
        >
          {saving ? (
            <span className="flex items-center">
              <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              {t('common.saving', 'Saving...')}
            </span>
          ) : (
            t('common.save', 'Save Changes')
          )}
        </button>
      </div>
    </div>
  );
}

export default AdminPromptVariablesPage;
