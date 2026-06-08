import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchAgentRuns } from '../../../api/agentsAdminApi';
import AdminBreadcrumb from '../components/AdminBreadcrumb';
import { DataTable } from '../components/data-table';

function formatTimestamp(timestamp) {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleString();
}

const STATUS_BADGE_CLASSES = {
  completed: 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300',
  failed: 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300',
  paused: 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-300',
  running: 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300'
};

function StatusBadge({ status }) {
  const cls =
    STATUS_BADGE_CLASSES[status] || 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300';
  return <span className={`px-2 py-0.5 text-xs rounded font-medium ${cls}`}>{status}</span>;
}

export default function AgentRunsPage() {
  const navigate = useNavigate();
  const { profileId } = useParams();
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let mounted = true;
    let interval;

    async function load() {
      try {
        const res = await fetchAgentRuns(profileId ? { profileId } : {});
        if (!mounted) return;
        setRuns(res?.data || []);
        setError(null);
      } catch (err) {
        if (mounted) setError(err.message);
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    // Refresh while any run is in flight; otherwise drop to a slower cadence.
    interval = setInterval(load, 5000);

    return () => {
      mounted = false;
      if (interval) clearInterval(interval);
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
