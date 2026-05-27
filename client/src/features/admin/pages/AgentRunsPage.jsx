import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { fetchAgentRuns } from '../../../api/agentsAdminApi';

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
    <div className="bg-gray-50 min-h-screen">
      <div className="max-w-6xl mx-auto py-8 px-4">
        <h1 className="text-2xl font-bold mb-6">Agent Runs{profileId ? ` — ${profileId}` : ''}</h1>
        {error && (
          <div className="mb-3 p-3 bg-red-50 border border-red-200 text-red-800 rounded">
            {error}
          </div>
        )}
        {loading ? (
          <div>Loading…</div>
        ) : (
          <div className="bg-white border rounded">
            <table className="min-w-full">
              <thead>
                <tr className="bg-gray-50 text-left text-xs font-semibold uppercase">
                  <th className="px-4 py-3">Run ID</th>
                  <th className="px-4 py-3">Profile</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Started</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {runs.map(r => (
                  <tr key={r.executionId} className="border-t">
                    <td className="px-4 py-3 font-mono text-xs">{r.executionId}</td>
                    <td className="px-4 py-3 text-sm">{(r.userId || '').replace(/^agent:/, '')}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`px-2 py-0.5 text-xs rounded ${
                          r.status === 'completed'
                            ? 'bg-green-100 text-green-800'
                            : r.status === 'failed'
                              ? 'bg-red-100 text-red-800'
                              : r.status === 'paused'
                                ? 'bg-yellow-100 text-yellow-800'
                                : r.status === 'running'
                                  ? 'bg-blue-100 text-blue-800'
                                  : 'bg-gray-100 text-gray-700'
                        }`}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs">{r.startedAt || r.createdAt || '—'}</td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => navigate(`/admin/agents/runs/${r.executionId}`)}
                        className="text-indigo-600 hover:underline"
                      >
                        View
                      </button>
                    </td>
                  </tr>
                ))}
                {runs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-gray-500">
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
