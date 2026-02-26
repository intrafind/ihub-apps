import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import SourceConfigForm from '../components/SourceConfigForm';
import { makeAdminApiCall } from '../../../api/adminApi';
import Icon from '../../../shared/components/Icon';

const AdminSourceEditPage = () => {
  const { t } = useTranslation();
  const { id } = useParams();
  const navigate = useNavigate();
  const isEditing = id !== 'new';

  const [source, setSource] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    const loadSourceData = async () => {
      if (isEditing) {
        try {
          setLoading(true);
          setError(null);
          const response = await makeAdminApiCall(`/admin/sources/${id}`);
          setSource(response.data);
        } catch (err) {
          console.error('Failed to load source:', err);
          setError(err.message || 'Failed to load source');
          // For editing, still set a default source so form can render with error
          setSource({
            id: id,
            name: { en: '' },
            description: { en: '' },
            type: 'filesystem',
            enabled: true,
            exposeAs: 'prompt',
            category: '',
            tags: [],
            config: {}
          });
        } finally {
          setLoading(false);
        }
      } else {
        // Create new source with default values
        setSource({
          id: '',
          name: { en: '' },
          description: { en: '' },
          type: 'filesystem',
          enabled: true,
          exposeAs: 'prompt',
          category: '',
          tags: [],
          config: {}
        });
        setLoading(false);
      }
    };

    loadSourceData();
  }, [id, isEditing]);

  // Warn about unsaved changes when leaving
  useEffect(() => {
    const handleBeforeUnload = e => {
      if (hasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

  const handleSave = async sourceData => {
    try {
      setSaving(true);
      setError(null);

      // Prepare source data for saving (remove temporary fields)
      const tempContent = sourceData.config?.tempContent;
      const cleanSourceData = {
        ...sourceData,
        config: {
          ...sourceData.config
        }
      };

      // Remove temporary fields from config before saving
      if (cleanSourceData.config) {
        delete cleanSourceData.config.tempContent;
        delete cleanSourceData.config.originalFileName;
        delete cleanSourceData.config.uploadedAt;
      }

      // Remove description field if all values are empty (to avoid validation errors)
      if (cleanSourceData.description) {
        const hasNonEmptyDescription = Object.values(cleanSourceData.description).some(
          value => value && value.trim() !== ''
        );
        if (!hasNonEmptyDescription) {
          delete cleanSourceData.description;
        }
      }

      let savedSource;

      if (isEditing) {
        const response = await makeAdminApiCall(`/admin/sources/${id}`, {
          method: 'PUT',
          body: JSON.stringify(cleanSourceData)
        });
        savedSource = response.data?.source || cleanSourceData;
      } else {
        const response = await makeAdminApiCall('/admin/sources', {
          method: 'POST',
          body: JSON.stringify(cleanSourceData)
        });
        savedSource = response.data?.source || cleanSourceData;

        // If new source has temporary content, upload it now
        if (tempContent && savedSource?.id) {
          try {
            await makeAdminApiCall(`/admin/sources/${savedSource.id}/files`, {
              method: 'POST',
              body: JSON.stringify({
                path: sourceData.config.path,
                content: tempContent,
                encoding: 'utf8'
              })
            });
          } catch (uploadErr) {
            console.error('Failed to upload temporary content:', uploadErr);
            setError(uploadErr.message || 'Source created but failed to upload content');
            return;
          }
        }
      }

      setHasUnsavedChanges(false);
      navigate('/admin/sources');
    } catch (err) {
      console.error('Failed to save source:', err);

      // Extract detailed error message from response
      let errorMessage = 'Failed to save source';

      if (err.response?.data) {
        const responseData = err.response.data;

        // If there's a main error message, use it
        if (responseData.error) {
          errorMessage = responseData.error;
        }

        // If there are validation details, append them
        if (responseData.details) {
          if (Array.isArray(responseData.details)) {
            // Zod validation errors
            const validationErrors = responseData.details
              .map(detail => {
                if (detail.path && detail.message) {
                  return `${detail.path.join('.')}: ${detail.message}`;
                }
                return detail.message || JSON.stringify(detail);
              })
              .join('; ');
            if (validationErrors) {
              errorMessage += `: ${validationErrors}`;
            }
          } else if (typeof responseData.details === 'string') {
            errorMessage += `: ${responseData.details}`;
          } else if (typeof responseData.details === 'object') {
            errorMessage += `: ${JSON.stringify(responseData.details)}`;
          }
        }
      } else if (err.message) {
        errorMessage = err.message;
      }

      setError(errorMessage);
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    if (!source || !source.id || !isEditing) {
      setError('Please save the source first before testing');
      return;
    }

    try {
      setTesting(true);
      setTestResult(null);
      setError(null);

      const response = await makeAdminApiCall(`/admin/sources/${source.id}/test`, {
        method: 'POST'
      });

      setTestResult(response.data);
    } catch (err) {
      console.error('Source test failed:', err);
      setTestResult({
        success: false,
        error: err.message,
        duration: 0
      });
    } finally {
      setTesting(false);
    }
  };

  const handleFormChange = newSource => {
    setSource(newSource);
    setHasUnsavedChanges(true);
    setTestResult(null); // Clear test results when form changes
  };

  if (loading) {
    return (
      <AdminAuth>
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
          <AdminNavigation />
          <div className="max-w-7xl mx-auto py-6 px-4">
            <div className="flex items-center justify-center h-64">
              <div className="text-center">
                <Icon
                  name="arrow-path"
                  className="animate-spin h-8 w-8 text-gray-400 mx-auto mb-4"
                />
                <p className="text-gray-500 dark:text-gray-400">{t('common.loading', 'Loading...')}</p>
              </div>
            </div>
          </div>
        </div>
      </AdminAuth>
    );
  }

  if (!source) {
    return (
      <AdminAuth>
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
          <AdminNavigation />
          <div className="max-w-7xl mx-auto py-6 px-4">
            <div className="text-center py-12">
              <Icon name="x-circle" className="h-12 w-12 text-red-400 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
                {t('admin.sources.notFound', 'Source not found')}
              </h3>
              <p className="text-gray-500 dark:text-gray-400 mb-4">
                {t('admin.sources.notFoundDescription', 'The requested source could not be found.')}
              </p>
              <button
                onClick={() => navigate('/admin/sources')}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium"
              >
                {t('common.backToList', 'Back to Sources')}
              </button>
            </div>
          </div>
        </div>
      </AdminAuth>
    );
  }

  return (
    <AdminAuth>
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <AdminNavigation />
        <div className="max-w-7xl mx-auto py-6 px-4">
          {/* Header */}
          <div className="mb-8">
            <div className="flex items-center justify-between">
              <div>
                <nav className="flex items-center space-x-2 text-sm text-gray-500 dark:text-gray-400 mb-2">
                  <button
                    onClick={() => navigate('/admin/sources')}
                    className="hover:text-gray-700 dark:hover:text-gray-300"
                  >
                    {t('admin.navigation.sources', 'Sources')}
                  </button>
                  <Icon name="chevron-right" className="h-4 w-4" />
                  <span className="font-medium text-gray-900 dark:text-gray-100">
                    {isEditing
                      ? t('admin.sources.editSource', 'Edit Source')
                      : t('admin.sources.createNew', 'Create Source')}
                  </span>
                </nav>
                <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 flex items-center">
                  <Icon name="database" className="h-6 w-6 mr-2" />
                  {isEditing
                    ? source.name?.en || source.id
                    : t('admin.sources.createNew', 'Create Source')}
                </h1>
              </div>

              <div className="flex items-center space-x-3">
                {isEditing && (
                  <button
                    onClick={handleTestConnection}
                    disabled={testing}
                    className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg font-medium flex items-center"
                  >
                    <Icon
                      name={testing ? 'arrow-path' : 'beaker'}
                      className={`h-4 w-4 mr-2 ${testing ? 'animate-spin' : ''}`}
                    />
                    {testing
                      ? t('admin.sources.testing', 'Testing...')
                      : t('admin.sources.testConnection', 'Test')}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Error Message */}
          {error && (
            <div className="mb-6 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 rounded-lg p-4">
              <div className="flex items-center">
                <Icon name="x-circle" className="h-5 w-5 text-red-400 mr-2" />
                <p className="text-red-800 dark:text-red-200">{error}</p>
                <button
                  onClick={() => setError(null)}
                  className="ml-auto text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
                >
                  <Icon name="x-mark" className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          <div className="space-y-6">
            {/* Main Form */}
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm">
              <div className="p-6">
                <SourceConfigForm
                  source={source}
                  onChange={handleFormChange}
                  onSave={handleSave}
                  saving={saving}
                  isEditing={isEditing}
                />
              </div>
            </div>

            {/* Test Results */}
            {testResult && (
              <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm p-6">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4 flex items-center">
                  <Icon name="beaker" className="h-5 w-5 mr-2" />
                  {t('admin.sources.testResults', 'Test Results')}
                </h3>

                <div
                  className={`p-4 rounded-lg ${
                    testResult.success
                      ? 'bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-800'
                      : 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800'
                  }`}
                >
                  <div className="flex items-center mb-2">
                    <Icon
                      name={testResult.success ? 'check-circle' : 'x-circle'}
                      className={`h-5 w-5 mr-2 ${
                        testResult.success ? 'text-green-600' : 'text-red-600'
                      }`}
                    />
                    <span
                      className={`font-medium ${
                        testResult.success ? 'text-green-800 dark:text-green-200' : 'text-red-800 dark:text-red-200'
                      }`}
                    >
                      {testResult.success
                        ? t('admin.sources.testSuccess', 'Connection successful')
                        : t('admin.sources.testFailed', 'Connection failed')}
                    </span>
                  </div>

                  {testResult.error && (
                    <p className="text-red-700 dark:text-red-300 text-sm mb-2">{testResult.error}</p>
                  )}

                  {testResult.duration && (
                    <p className="text-sm text-gray-600 dark:text-gray-400">
                      {t('admin.sources.testDuration', 'Duration: {{duration}}ms', {
                        duration: testResult.duration
                      })}
                    </p>
                  )}

                  {testResult.result && (
                    <pre className="mt-2 text-xs text-gray-600 dark:text-gray-400 bg-white dark:bg-gray-900 p-2 rounded border dark:border-gray-700 overflow-auto max-h-32">
                      {JSON.stringify(testResult.result, null, 2)}
                    </pre>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminSourceEditPage;
