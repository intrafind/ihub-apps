import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import {
  fetchAgentRun,
  cancelAgentRun,
  approveAgentRun,
  fetchRunArtifacts
} from '../../../api/agentsAdminApi';

export default function AgentRunDetailPage() {
  const navigate = useNavigate();
  const { runId } = useParams();
  const [run, setRun] = useState(null);
  const [artifacts, setArtifacts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const [runRes, artifactsRes] = await Promise.all([
          fetchAgentRun(runId),
          fetchRunArtifacts(runId)
        ]);
        if (!mounted) return;
        setRun(runRes?.data || null);
        setArtifacts(artifactsRes?.data || []);
      } catch (err) {
        if (mounted) setError(err.message);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    // Poll every 3 seconds while the run is non-terminal.
    const interval = setInterval(() => {
      if (run?.status && ['completed', 'failed', 'cancelled'].includes(run.status)) {
        clearInterval(interval);
        return;
      }
      load();
    }, 3000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
    // eslint-disable-next-line @eslint-react/exhaustive-deps
  }, [runId]);

  async function handleCancel() {
    if (!window.confirm('Cancel this run?')) return;
    try {
      await cancelAgentRun(runId, 'user_cancelled');
    } catch (err) {
      alert(err?.response?.data?.message || err.message);
    }
  }

  async function handleApprove(response) {
    const checkpoint = run?.data?.pendingCheckpoint;
    if (!checkpoint) return;
    try {
      await approveAgentRun(runId, { checkpointId: checkpoint.id, response });
    } catch (err) {
      alert(err?.response?.data?.message || err.message);
    }
  }

  if (loading) {
    return (
      <AdminAuth>
        <AdminNavigation />
        <div className="p-8">Loading…</div>
      </AdminAuth>
    );
  }

  const status = run?.status;
  const profileId =
    run?.data?._agent?.profileId || (run?.data?._workflow?.startedBy || '').replace(/^agent:/, '');
  const tasks = run?.data?._taskQueue || [];
  const isPaused = status === 'paused';
  const pendingCheckpoint = run?.data?.pendingCheckpoint;

  return (
    <AdminAuth>
      <div className="bg-gray-50 min-h-screen">
        <AdminNavigation />
        <div className="max-w-6xl mx-auto py-8 px-4">
          <div className="flex justify-between items-start mb-6">
            <div>
              <h1 className="text-2xl font-bold">Run {runId}</h1>
              <p className="text-sm text-gray-600 font-mono">{profileId}</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => navigate(-1)}
                className="px-3 py-2 border bg-white rounded text-sm"
              >
                Back
              </button>
              {status === 'running' && (
                <button
                  onClick={handleCancel}
                  className="px-3 py-2 bg-red-600 text-white rounded text-sm"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>

          {error && (
            <div className="mb-3 p-3 bg-red-50 border border-red-200 text-red-800 rounded">
              {error}
            </div>
          )}

          {isPaused && pendingCheckpoint && (
            <div className="mb-6 p-4 bg-yellow-50 border border-yellow-300 rounded">
              <h2 className="font-semibold text-yellow-900 mb-2">⏸ Awaiting approval</h2>
              <p className="text-sm text-yellow-800 mb-3">{pendingCheckpoint.message}</p>
              <div className="flex gap-2">
                {(
                  pendingCheckpoint.options || [
                    { value: 'approve', label: 'Approve' },
                    { value: 'reject', label: 'Reject' }
                  ]
                ).map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => handleApprove(opt.value)}
                    className={`px-3 py-2 text-sm rounded ${
                      opt.value === 'approve' || opt.style === 'primary'
                        ? 'bg-green-600 text-white'
                        : opt.style === 'danger' || opt.value === 'reject'
                          ? 'bg-red-600 text-white'
                          : 'bg-gray-200 text-gray-800'
                    }`}
                  >
                    {opt.label || opt.value}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-3 gap-6">
            <div className="col-span-2 space-y-4">
              <div className="bg-white border rounded p-4">
                <h2 className="font-semibold mb-2">Status</h2>
                <div className="text-sm">
                  <div>
                    Status: <span className="font-mono">{status}</span>
                  </div>
                  <div>
                    Current nodes:{' '}
                    <span className="font-mono">{(run?.currentNodes || []).join(', ') || '—'}</span>
                  </div>
                  <div>
                    Completed:{' '}
                    <span className="font-mono">{(run?.completedNodes || []).length}</span>
                  </div>
                </div>
              </div>

              <div className="bg-white border rounded p-4">
                <h2 className="font-semibold mb-2">Task Queue ({tasks.length})</h2>
                {tasks.length === 0 ? (
                  <p className="text-sm text-gray-500">No tasks yet.</p>
                ) : (
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="text-xs text-gray-500 uppercase">
                        <th className="text-left py-1">Title</th>
                        <th className="text-left py-1">Status</th>
                        <th className="text-left py-1">Depth</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tasks.map(t => (
                        <tr key={t.id} className="border-t">
                          <td className="py-2">{t.title}</td>
                          <td className="py-2">{t.status}</td>
                          <td className="py-2">{t.depth ?? 0}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="bg-white border rounded p-4">
                <h2 className="font-semibold mb-2">Artifacts</h2>
                {artifacts.length === 0 ? (
                  <p className="text-sm text-gray-500">No artifacts produced.</p>
                ) : (
                  <ul className="text-sm space-y-1">
                    {artifacts.map(a => (
                      <li key={a.name}>
                        <a
                          href={`/api/agents/runs/${runId}/artifacts/${a.name}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-indigo-600 hover:underline"
                        >
                          {a.name}
                        </a>
                        <span className="text-xs text-gray-500 ml-2">{a.bytes} bytes</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div>
              <div className="bg-white border rounded p-4">
                <h2 className="font-semibold mb-2">Metadata</h2>
                <pre className="text-xs overflow-x-auto">
                  {JSON.stringify(run?.data?._agent || {}, null, 2)}
                </pre>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AdminAuth>
  );
}
