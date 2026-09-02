import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { fetchPendingInteractions } from '../../../api';
import AdminBreadcrumb from '../components/AdminBreadcrumb';

/**
 * Pending approvals — the interactions queue filtered to `approval`: every
 * paused agent run or workflow execution waiting on a human the caller may
 * answer (admins see all, approvers see their groups'). Rows open the run
 * where the checkpoint is answered.
 */
export default function AdminAgentApprovalsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchPendingInteractions({ kind: 'approval' });
        setPending(res?.data?.interactions || []);
      } catch (err) {
        setError(err?.response?.data?.error || err?.message || String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const openRun = interaction => {
    const executionId = interaction.source?.executionId || interaction.runId;
    if (interaction.source?.profileId) {
      navigate(`/admin/agents/runs/${executionId}`);
    } else {
      navigate(`/workflows/executions/${executionId}`);
    }
  };

  return (
    <div className="bg-gray-50 dark:bg-gray-950 min-h-screen">
      <div className="max-w-4xl mx-auto py-8 px-4">
        <AdminBreadcrumb
          crumbs={[
            { label: t('admin.title', 'Admin'), href: '/admin' },
            { label: t('admin.agents.title', 'Agent Profiles'), href: '/admin/agents' },
            { label: t('admin.agents.approvals.title', 'Pending Approvals') }
          ]}
        />
        <h1 className="text-2xl font-bold mb-6 text-gray-900 dark:text-gray-100">
          {t('admin.agents.approvals.title', 'Pending Approvals')}
        </h1>
        {error && (
          <div className="mb-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 rounded">
            {error}
          </div>
        )}
        {loading ? (
          <div className="text-gray-600 dark:text-gray-400">{t('common.loading', 'Loading…')}</div>
        ) : pending.length === 0 ? (
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-8 text-center text-gray-500 dark:text-gray-400">
            {t('admin.agents.approvals.empty', 'No pending approvals.')}
          </div>
        ) : (
          <ul className="space-y-3">
            {pending.map(interaction => (
              <li
                key={interaction.id}
                className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-4"
              >
                <div className="flex justify-between items-start gap-4">
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-gray-600 dark:text-gray-400 truncate">
                      {interaction.source?.profileId || interaction.runId}
                      {interaction.source?.nodeName ? ` · ${interaction.source.nodeName}` : ''}
                    </p>
                    <p className="text-sm font-medium mt-1 text-gray-900 dark:text-gray-100">
                      {interaction.prompt?.message ||
                        t('admin.agents.approvals.defaultMessage', 'Approval requested')}
                    </p>
                    {interaction.createdAt && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        {new Date(interaction.createdAt).toLocaleString()}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => openRun(interaction)}
                    className="shrink-0 px-3 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded text-sm"
                  >
                    {t('admin.agents.approvals.openRun', 'Open run')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
