import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { apiClient } from '../../../api/client';
import { WorkflowEditor } from '../../workflows/editor/WorkflowEditor';
import { workflowToFlow, flowToWorkflow } from '../../workflows/editor/workflowEditorUtils';

/** Same character class enforced by validateIdForPath() on the server. */
const VALID_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

/**
 * Admin page for visually editing a workflow using the React Flow-based editor.
 * Supports creating new workflows (id="new") and editing existing ones.
 * Provides save and publish functionality via the workflow API.
 *
 * Route: /admin/workflows/:id/edit
 */
function WorkflowEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [workflow, setWorkflow] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null); // { kind: 'success'|'error', message }
  // Pending save waiting for an ID: { updated } while the ID dialog is open
  const [idDialog, setIdDialog] = useState(null);
  const [idValue, setIdValue] = useState('');

  const isNew = id === 'new';

  const showToast = useCallback((kind, message) => {
    setToast({ kind, message });
    setTimeout(() => setToast(null), 4000);
  }, []);

  useEffect(() => {
    const loadWorkflow = async () => {
      if (isNew) {
        // Scaffold a new workflow with start and end nodes connected
        setWorkflow({
          id: '',
          name: { en: 'New Workflow' },
          description: { en: '' },
          version: '1.0.0',
          enabled: true,
          status: 'draft',
          config: {},
          nodes: [
            {
              id: 'start',
              type: 'start',
              name: { en: 'Start' },
              position: { x: 250, y: 0 },
              config: {}
            },
            {
              id: 'end',
              type: 'end',
              name: { en: 'End' },
              position: { x: 250, y: 200 },
              config: {}
            }
          ],
          edges: [{ id: 'e-start-end', source: 'start', target: 'end' }]
        });
        setLoading(false);
        return;
      }

      try {
        const response = await apiClient.get(`/workflows/${id}`);
        setWorkflow(response.data);
      } catch (err) {
        setError(err.message || t('workflows.editor.loadFailed', 'Failed to load workflow'));
      } finally {
        setLoading(false);
      }
    };

    loadWorkflow();
  }, [id, isNew, t]);

  /**
   * Saves the current canvas state back to the API.
   * For new workflows, prompts for an ID and creates the workflow.
   * For existing workflows, updates in place.
   */
  /** Persists a workflow object (POST for new, PUT for existing). */
  const persistWorkflow = useCallback(
    async updated => {
      setSaving(true);
      try {
        if (isNew) {
          await apiClient.post('/workflows', updated);
          navigate(`/admin/workflows/${updated.id}/edit`, { replace: true });
        } else {
          await apiClient.put(`/workflows/${id}`, updated);
        }
        setWorkflow(updated);
        showToast('success', t('workflows.editor.saveSuccess', 'Workflow saved'));
      } catch (err) {
        showToast(
          'error',
          t('workflows.editor.saveFailed', 'Save failed: {{message}}', { message: err.message })
        );
      } finally {
        setSaving(false);
      }
    },
    [isNew, id, navigate, t, showToast]
  );

  const handleSave = useCallback(
    async (rfNodes, rfEdges) => {
      const updated = flowToWorkflow(rfNodes, rfEdges, workflow);
      if (isNew && !updated.id) {
        // Collect the ID via an in-app dialog (validated against the same
        // pattern as validateIdForPath() on the server).
        setIdValue('');
        setIdDialog({ updated });
        return;
      }
      await persistWorkflow(updated);
    },
    [workflow, isNew, persistWorkflow]
  );

  /** Confirms the new-workflow ID dialog and saves. */
  const handleIdConfirm = useCallback(async () => {
    const newId = idValue.trim();
    if (!newId || !VALID_ID_PATTERN.test(newId) || newId.includes('..')) {
      showToast(
        'error',
        t(
          'workflows.editor.promptIdHint',
          'Use only letters, numbers, dots, underscores, and hyphens.'
        )
      );
      return;
    }
    const updated = { ...idDialog.updated, id: newId };
    setIdDialog(null);
    await persistWorkflow(updated);
  }, [idValue, idDialog, persistWorkflow, showToast, t]);

  /**
   * Publishes the workflow by saving first, then calling the publish endpoint.
   */
  const handlePublish = useCallback(
    async (rfNodes, rfEdges) => {
      await handleSave(rfNodes, rfEdges);
      try {
        await apiClient.post(`/workflows/${workflow?.id || id}/publish`);
        showToast(
          'success',
          t('workflows.editor.publishSuccess', 'Workflow published successfully')
        );
      } catch (err) {
        showToast(
          'error',
          t('workflows.editor.publishFailed', 'Publish failed: {{message}}', {
            message: err.message
          })
        );
      }
    },
    [handleSave, workflow, id, t, showToast]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-gray-500">
          {t('workflows.editor.loadingWorkflow', 'Loading workflow...')}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-red-500">{error}</div>
      </div>
    );
  }

  const { nodes: initialNodes, edges: initialEdges } = workflowToFlow(workflow);

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate(-1)}
            className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
          >
            &larr; {t('workflows.editor.back', 'Back')}
          </button>
          <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {isNew
              ? t('workflows.editor.newWorkflowHeading', 'New Workflow')
              : (typeof workflow?.name === 'object' ? workflow.name.en : workflow?.name) ||
                t('workflows.editor.title', 'Workflow Editor')}
          </h1>
          {workflow?.status && (
            <span
              className={`text-xs px-2 py-0.5 rounded ${
                workflow.status === 'published'
                  ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                  : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
              }`}
            >
              {workflow.status}
            </span>
          )}
        </div>
        {saving && (
          <span className="text-sm text-gray-500">{t('workflows.editor.saving', 'Saving...')}</span>
        )}
      </div>

      <div className="flex-1 relative min-h-0">
        <WorkflowEditor
          initialNodes={initialNodes}
          initialEdges={initialEdges}
          onSave={handleSave}
          onPublish={handlePublish}
        />
        {toast && (
          <div
            role="status"
            className={`absolute bottom-4 right-4 px-4 py-2 rounded shadow-lg text-sm ${
              toast.kind === 'success' ? 'bg-green-600 text-white' : 'bg-red-600 text-white'
            }`}
          >
            {toast.message}
          </div>
        )}

        {idDialog && (
          <div
            className="absolute inset-0 bg-black/40 flex items-center justify-center z-50"
            role="dialog"
            aria-modal="true"
            aria-labelledby="workflow-id-dialog-title"
          >
            <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl p-5 w-96 max-w-[90vw]">
              <h2
                id="workflow-id-dialog-title"
                className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-2"
              >
                {t('workflows.editor.promptId', 'Enter workflow ID:')}
              </h2>
              <input
                type="text"
                value={idValue}
                onChange={e => setIdValue(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleIdConfirm();
                  if (e.key === 'Escape') setIdDialog(null);
                }}
                autoFocus
                placeholder="my-workflow"
                className="w-full text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"
              />
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                {t(
                  'workflows.editor.promptIdHint',
                  'Use only letters, numbers, dots, underscores, and hyphens.'
                )}
              </p>
              <div className="flex justify-end gap-2 mt-4">
                <button
                  onClick={() => setIdDialog(null)}
                  className="text-sm px-3 py-1.5 rounded border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  {t('common.cancel', 'Cancel')}
                </button>
                <button
                  onClick={handleIdConfirm}
                  className="text-sm px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700"
                >
                  {t('workflows.editor.save', 'Save')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default WorkflowEditorPage;
