import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchAgentRuns } from '../../../api/agentsAdminApi';
import AdminBreadcrumb from '../components/AdminBreadcrumb';

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
        {loading ? (
          <div className="text-gray-600 dark:text-gray-400">Loading…</div>
        ) : (
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden shadow-sm">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    Run ID
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    Profile
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    Started
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                {runs.map(r => (
                  <tr
                    key={r.executionId}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                  >
                    <td className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-300">
                      {r.executionId}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-700 dark:text-gray-300">
                      {(r.userId || '').replace(/^agent:/, '')}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 text-xs rounded font-medium ${
                          r.status === 'completed'
                            ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300'
                            : r.status === 'failed'
                              ? 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300'
                              : r.status === 'paused'
                                ? 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-300'
                                : r.status === 'running'
                                  ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300'
                                  : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                        }`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
                      {r.startedAt || r.createdAt || '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => navigate(`/admin/agents/runs/${r.executionId}`)}
                        className="text-indigo-600 dark:text-indigo-400 hover:underline text-sm"
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))}
                {runs.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-4 py-6 text-center text-gray-500 dark:text-gray-400"
                    >
                      No runs yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
