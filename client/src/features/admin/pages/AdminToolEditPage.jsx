import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Icon from '../../../shared/components/Icon';
import AdminNavigation from '../components/AdminNavigation';
import AdminAuth from '../components/AdminAuth';
import { makeAdminApiCall } from '../../../api/adminApi';
import { fetchJsonSchema } from '../../../utils/schemaService';
import DualModeEditor from '../../../shared/components/DualModeEditor';
import { DEFAULT_LANGUAGE } from '../../../utils/localizeContent';

const AdminToolEditPage = () => {
  const { t } = useTranslation();
  const { toolId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const isNewTool = toolId === 'new';

  const [toolData, setToolData] = useState({
    id: '',
    name: { [DEFAULT_LANGUAGE]: '' },
    description: { [DEFAULT_LANGUAGE]: '' },
    script: '',
    enabled: true,
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  });

  const [loading, setLoading] = useState(!isNewTool);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [jsonSchema, setJsonSchema] = useState(null);

  useEffect(() => {
    if (isNewTool && location.state?.templateTool) {
      const tpl = location.state.templateTool;
      setToolData(prev => ({
        ...prev,
        ...tpl,
        id: '',
        enabled: tpl.enabled !== false
      }));
    }
  }, [isNewTool, location.state]);

  useEffect(() => {
    const loadJsonSchema = async () => {
      try {
        const schema = await fetchJsonSchema('tool');
        setJsonSchema(schema);
      } catch (err) {
        console.error('Failed to load tool JSON schema:', err);
        // Continue without schema - validation will be server-side only
      }
    };

    loadJsonSchema();

    if (!isNewTool) {
      loadTool();
    } else {
      setLoading(false);
    }
  }, [toolId, isNewTool, loadTool]);

  const loadTool = useCallback(async () => {
    try {
      setLoading(true);
      const response = await makeAdminApiCall(`/admin/tools/${toolId}`);
      const tool = response.data;

      // Ensure name and description are proper localized objects
      const ensureLocalizedObject = value => {
        if (!value) return { [DEFAULT_LANGUAGE]: '' };
        if (typeof value === 'string') return { [DEFAULT_LANGUAGE]: value };
        if (typeof value === 'object' && value !== null) return value;
        return { [DEFAULT_LANGUAGE]: '' };
      };

      setToolData({
        ...tool,
        name: ensureLocalizedObject(tool.name),
        description: ensureLocalizedObject(tool.description)
      });
    } catch (err) {
      console.error('Error loading tool:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [toolId]);

  const handleSave = async data => {
    setSaving(true);
    setError(null);

    try {
      if (isNewTool) {
        await makeAdminApiCall('/admin/tools', {
          method: 'POST',
          body: data
        });
      } else {
        await makeAdminApiCall(`/admin/tools/${toolId}`, {
          method: 'PUT',
          body: data
        });
      }

      navigate('/admin/tools');
    } catch (err) {
      console.error('Error saving tool:', err);
      setError(err.message);
      setSaving(false);
      throw err; // Re-throw to let DualModeEditor handle it
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
      <AdminNavigation />
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="mb-4">
          <button
            onClick={() => navigate('/admin/tools')}
            className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700"
          >
            <Icon name="arrow-left" className="h-4 w-4 mr-2" />
            {t('common.back', 'Back to Tools')}
          </button>
        </div>

        <div className="bg-white shadow sm:rounded-lg">
          <div className="px-4 py-5 sm:p-6">
            <h2 className="text-2xl font-semibold text-gray-900 mb-6">
              {isNewTool
                ? t('admin.tools.createNew', 'Create New Tool')
                : t('admin.tools.edit', 'Edit Tool')}
            </h2>

            {error && (
              <div className="mb-4 bg-red-50 border border-red-200 rounded-md p-4">
                <div className="flex">
                  <Icon name="exclamation-triangle" className="h-5 w-5 text-red-400" />
                  <div className="ml-3">
                    <h3 className="text-sm font-medium text-red-800">
                      {t('admin.tools.saveError', 'Error saving tool')}
                    </h3>
                    <p className="mt-1 text-sm text-red-700">{error}</p>
                  </div>
                </div>
              </div>
            )}

            <DualModeEditor
              data={toolData}
              onSave={handleSave}
              saving={saving}
              schema={jsonSchema}
              entityType="tool"
              entityName={
                toolData.name?.[DEFAULT_LANGUAGE] || toolData.name?.en || toolData.id || 'Tool'
              }
              backLink="/admin/tools"
            />
          </div>
        </div>
      </div>
    </AdminAuth>
  );
};

export default AdminToolEditPage;
