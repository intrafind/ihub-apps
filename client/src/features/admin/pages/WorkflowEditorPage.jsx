import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import WorkflowEditor from '../../workflows/editor/WorkflowEditor.jsx';
import { flowToWorkflow } from '../../workflows/editor/workflowEditorUtils.js';
import { apiClient } from '../../../api/client.js';

// Scaffold for a new empty workflow
function createNewWorkflow(id) {
  return {
    id,
    name: { en: 'New Workflow' },
    description: { en: 'A new workflow' },
    version: '1.0.0',
    enabled: true,
    status: 'draft',
    config: { maxIterations: 20, allowCycles: false },
    nodes: [
      {
        id: 'start',
        type: 'start',
        name: { en: 'Start' },
        position: { x: 100, y: 100 },
        config: {}
      },
      { id: 'end', type: 'end', name: { en: 'End' }, position: { x: 400, y: 100 }, config: {} }
    ],
    edges: [{ id: 'e1', source: 'start', target: 'end' }]
  };
}

export default function WorkflowEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = id === 'new';
  const workflowId = isNew ? `workflow-${Date.now()}` : id;

  const [workflow, setWorkflow] = useState(null);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    if (isNew) {
      setWorkflow(createNewWorkflow(workflowId));
      return;
    }
    apiClient
      .get(`/workflows/${id}`)
      .then(res => setWorkflow(res.data))
      .catch(err => setError(err.message || 'Failed to load workflow'))
      .finally(() => setLoading(false));
  }, [id, isNew, workflowId]);

  const handleSave = useCallback(
    async (rfNodes, rfEdges) => {
      setSaving(true);
      setSaveSuccess(false);
      try {
        const workflowData = flowToWorkflow(rfNodes, rfEdges, workflow);
        if (isNew) {
          await apiClient.post('/workflows', workflowData);
          navigate(`/admin/workflows/${workflowData.id}/edit`);
        } else {
          await apiClient.put(`/workflows/${id}`, workflowData);
          setWorkflow(workflowData);
        }
        setSaveSuccess(true);
        setTimeout(() => setSaveSuccess(false), 2000);
      } catch (err) {
        setError(err.message || 'Failed to save workflow');
      } finally {
        setSaving(false);
      }
    },
    [workflow, isNew, id, navigate]
  );

  const handlePublish = useCallback(async () => {
    try {
      await apiClient.post(`/workflows/${workflow?.id || workflowId}/publish`);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
    } catch (err) {
      setError(err.message || 'Failed to publish');
    }
  }, [workflow, workflowId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-400">
        Loading workflow...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/admin')}
            className="text-gray-500 hover:text-gray-700 text-sm"
          >
            ← Admin
          </button>
          <span className="text-gray-300 dark:text-gray-600">|</span>
          <h1 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
            {isNew ? 'New Workflow' : `Edit: ${workflow?.name?.en || id}`}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {saveSuccess && <span className="text-green-600 text-xs">Saved!</span>}
          {error && <span className="text-red-500 text-xs">{error}</span>}
        </div>
      </div>

      {/* Editor canvas */}
      <div className="flex-1 overflow-hidden">
        {workflow && (
          <WorkflowEditor
            workflow={workflow}
            onSave={handleSave}
            onPublish={handlePublish}
            isSaving={saving}
          />
        )}
      </div>
    </div>
  );
}
