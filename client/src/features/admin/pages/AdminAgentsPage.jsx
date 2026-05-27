import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ConfirmDialog from '../../../shared/components/ConfirmDialog';
import {
  fetchAgentProfiles,
  toggleAgentProfile,
  deleteAgentProfile,
  triggerAgentRun
} from '../../../api/agentsAdminApi';

export default function AdminAgentsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pendingDeleteId, setPendingDeleteId] = useState(null);

  useEffect(() => {
    load();
  }, []);

  async function load() {
    try {
      setLoading(true);
      const data = await fetchAgentProfiles();
      setProfiles(data?.data || data || []);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  async function handleToggle(id) {
    try {
      const res = await toggleAgentProfile(id);
      const enabled = res?.data?.enabled;
      setProfiles(prev => prev.map(p => (p.id === id ? { ...p, enabled } : p)));
    } catch (err) {
      setError(err.message);
    }
  }

  async function confirmDelete() {
    const id = pendingDeleteId;
    if (!id) return;
    setPendingDeleteId(null);
    try {
      await deleteAgentProfile(id);
      setProfiles(prev => prev.filter(p => p.id !== id));
    } catch (err) {
      setError(err.message);
    }
  }

  async function handleTrigger(id) {
    setError(null);
    try {
      const res = await triggerAgentRun(id, {});
      const runId = res?.data?.executionId;
      if (runId) {
        navigate(`/admin/agents/runs/${runId}`);
      } else {
        setError(
          t('admin.agents.triggerSucceeded', 'Triggered: {{details}}', {
            details: JSON.stringify(res?.data)
          })
        );
      }
    } catch (err) {
      setError(
        t('admin.agents.triggerFailed', 'Trigger failed: {{message}}', {
          message: err?.response?.data?.message || err.message
        })
      );
    }
  }

  return (
    <>
      <div className="bg-gray-50 min-h-screen">
        <div className="max-w-7xl mx-auto py-8 px-4">
          <div className="flex justify-between items-center mb-6">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">
                {t('admin.agents.title', 'Agent Profiles')}
              </h1>
              <p className="text-sm text-gray-600 mt-1">
                {t(
                  'admin.agents.subtitle',
                  'Manage autonomous agents that run on schedules, webhooks, or manual triggers.'
                )}
              </p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => navigate('/admin/agents/inboxes')}
                className="px-3 py-2 text-sm border border-gray-300 bg-white rounded-md hover:bg-gray-50"
              >
                {t('admin.agents.manageInboxes', 'Manage Inboxes')}
              </button>
              <button
                onClick={() => navigate('/admin/agents/approvals')}
                className="px-3 py-2 text-sm border border-gray-300 bg-white rounded-md hover:bg-gray-50"
              >
                {t('admin.agents.approvals', 'Pending Approvals')}
              </button>
              <button
                onClick={() => navigate('/admin/agents/new')}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-700"
              >
                {t('admin.agents.new', 'New Profile')}
              </button>
            </div>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 text-red-800 rounded">
              {error}
            </div>
          )}

          {loading ? (
            <div className="text-gray-600">{t('common.loading', 'Loading…')}</div>
          ) : profiles.length === 0 ? (
            <div className="bg-white border border-gray-200 p-8 rounded text-center text-gray-600">
              {t(
                'admin.agents.empty',
                'No agent profiles yet. Create your first profile to get started.'
              )}
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded overflow-x-auto">
              <table className="min-w-full">
                <thead>
                  <tr className="bg-gray-50 text-left text-xs font-semibold text-gray-600 uppercase">
                    <th className="px-4 py-3">{t('admin.agents.col.name', 'Name')}</th>
                    <th className="px-4 py-3">{t('admin.agents.col.id', 'ID')}</th>
                    <th className="px-4 py-3">{t('admin.agents.col.inbox', 'Inbox')}</th>
                    <th className="px-4 py-3">{t('admin.agents.col.schedule', 'Schedule')}</th>
                    <th className="px-4 py-3">{t('admin.agents.col.enabled', 'Enabled')}</th>
                    <th className="px-4 py-3 text-right">
                      {t('admin.agents.col.actions', 'Actions')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {profiles.map(p => {
                    const schedule = (p.workflow?.definition?.triggers || []).find(
                      tr => tr.type === 'schedule'
                    );
                    const profileName = p.name?.en || p.id;
                    return (
                      <tr key={p.id} className="border-t border-gray-200">
                        <td className="px-4 py-3 font-medium">{profileName}</td>
                        <td className="px-4 py-3 font-mono text-xs text-gray-600">{p.id}</td>
                        <td className="px-4 py-3 text-sm">{p.inboxId || '—'}</td>
                        <td className="px-4 py-3 text-sm font-mono">
                          {schedule?.config?.cron || '—'}
                        </td>
                        <td className="px-4 py-3">
                          <button
                            onClick={() => handleToggle(p.id)}
                            aria-label={t(
                              'admin.agents.action.toggleAriaLabel',
                              'Toggle agent {{name}}',
                              { name: profileName }
                            )}
                            className={`px-2 py-1 text-xs rounded ${
                              p.enabled
                                ? 'bg-green-100 text-green-800'
                                : 'bg-gray-100 text-gray-700'
                            }`}
                          >
                            {p.enabled
                              ? t('admin.agents.action.on', 'On')
                              : t('admin.agents.action.off', 'Off')}
                          </button>
                        </td>
                        <td className="px-4 py-3 text-right text-sm space-x-2">
                          <button
                            onClick={() => handleTrigger(p.id)}
                            aria-label={t(
                              'admin.agents.action.runAriaLabel',
                              'Run agent {{name}}',
                              { name: profileName }
                            )}
                            className="text-indigo-600 hover:underline"
                          >
                            {t('admin.agents.action.run', 'Run')}
                          </button>
                          <button
                            onClick={() => navigate(`/admin/agents/${p.id}`)}
                            aria-label={t(
                              'admin.agents.action.editAriaLabel',
                              'Edit agent {{name}}',
                              { name: profileName }
                            )}
                            className="text-blue-600 hover:underline"
                          >
                            {t('admin.agents.action.edit', 'Edit')}
                          </button>
                          <button
                            onClick={() => navigate(`/admin/agents/${p.id}/runs`)}
                            aria-label={t(
                              'admin.agents.action.runsAriaLabel',
                              'View runs for agent {{name}}',
                              { name: profileName }
                            )}
                            className="text-gray-600 hover:underline"
                          >
                            {t('admin.agents.action.runs', 'Runs')}
                          </button>
                          <button
                            onClick={() => setPendingDeleteId(p.id)}
                            aria-label={t(
                              'admin.agents.action.deleteAriaLabel',
                              'Delete agent {{name}}',
                              { name: profileName }
                            )}
                            className="text-red-600 hover:underline"
                          >
                            {t('admin.agents.action.delete', 'Delete')}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      <ConfirmDialog
        isOpen={!!pendingDeleteId}
        danger
        title={t('admin.agents.deleteTitle', 'Delete profile')}
        message={t(
          'admin.agents.deleteMessage',
          'Delete agent profile "{{id}}"? This cannot be undone.',
          { id: pendingDeleteId || '' }
        )}
        confirmLabel={t('admin.agents.action.delete', 'Delete')}
        onConfirm={confirmDelete}
        onDeny={() => setPendingDeleteId(null)}
      />
    </>
  );
}
