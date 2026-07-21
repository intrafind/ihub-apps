import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchAgentRuns } from '../../../api/agentsAdminApi';
import AdminBreadcrumb from '../components/AdminBreadcrumb';
import { DataTable } from '../components/data-table';
import StatusBadge from '../../workflows/components/StatusBadge';

import { getAdminApiErrorMessage } from '../../../api/adminApi';
const ACTIVE_POLL_MS = 5000;
const IDLE_POLL_MS = 30000;

function formatTimestamp(timestamp) {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleString();
}

export default function AgentRunsPage() {
  const navigate = useNavigate();
  const { profileId } = useParams();
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let mounted = true;
    let timer;

    async function load() {
      let hasActiveRun = true;
      try {
        const res = await fetchAgentRuns(profileId ? { profileId } : {});
        if (!mounted) return;
        const data = res?.data || [];
        setRuns(data);
        setError(null);
        hasActiveRun = data.some(r => r.status === 'running' || r.status === 'paused');
      } catch (err) {
        if (mounted) setError(getAdminApiErrorMessage(err));
      } finally {
        if (mounted) setLoading(false);
      }
      if (mounted) timer = setTimeout(load, hasActiveRun ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    }

    load();

    return () => {
      mounted = false;
      if (timer) clearTimeout(timer);
    };
  }, [profileId]);

  const columns = [
    {
      key: 'executionId',
      header: 'Run ID',
      sortable: true,
      render: r => (
        <span className="font-mono text-xs text-gray-700 dark:text-gray-300">{r.executionId}</span>
      )
    },
    {
      key: 'profile',
      header: 'Profile',
      sortable: true,
      sortAccessor: r => (r.userId || '').replace(/^agent:/, ''),
      render: r => (
        <span className="text-sm text-gray-700 dark:text-gray-300">
          {(r.userId || '').replace(/^agent:/, '')}
        </span>
      )
    },
    {
      key: 'status',
      header: 'Status',
      sortable: true,
      render: r => <StatusBadge status={r.status} />
    },
    {
      key: 'startedAt',
      header: 'Started',
      sortable: true,
      sortAccessor: r => r.startedAt || r.createdAt || '',
      render: r => (
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {formatTimestamp(r.startedAt || r.createdAt)}
        </span>
      )
    }
  ];

  const actions = [
    {
      id: 'view',
      label: 'View',
      icon: 'eye',
      onClick: r => navigate(`/admin/agents/runs/${r.executionId}`)
    }
  ];

  return (
    <div className="bg-gray-50 dark:bg-gray-950 min-h-screen">
      <div className="max-w-6xl mx-auto py-8 px-4">
        <AdminBreadcrumb
          crumbs={[
            { label: 'Admin', href: '/admin' },
            { label: 'Agent Profiles', href: '/admin/agents' },
            ...(profileId ? [{ label: profileId, href: `/admin/agents/${profileId}` }] : []),
            { label: 'Runs' }
          ]}
        />
        <h1 className="text-2xl font-bold mb-6 text-gray-900 dark:text-gray-100">
          Agent Runs{profileId ? ` — ${profileId}` : ''}
        </h1>
        {error && (
          <div className="mb-3 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 rounded">
            {error}
          </div>
        )}
        <DataTable
          columns={columns}
          data={runs}
          getRowId={r => r.executionId}
          actions={actions}
          loading={loading}
          defaultSort={{ column: 'startedAt', direction: 'desc' }}
          empty={{
            icon: 'clock',
            title: 'No runs yet.'
          }}
        />
      </div>
    </div>
  );
}
