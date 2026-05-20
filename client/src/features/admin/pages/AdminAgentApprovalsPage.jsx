import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { fetchPendingApprovals } from '../../../api/agentsAdminApi';

export default function AdminAgentApprovalsPage() {
  const navigate = useNavigate();
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetchPendingApprovals();
        setPending(res?.data || []);
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <AdminAuth>
      <div className="bg-gray-50 min-h-screen">
        <AdminNavigation />
        <div className="max-w-4xl mx-auto py-8 px-4">
          <h1 className="text-2xl font-bold mb-6">Pending Approvals</h1>
          {error && (
            <div className="mb-3 p-3 bg-red-50 border border-red-200 text-red-800 rounded">
              {error}
            </div>
          )}
          {loading ? (
            <div>Loading…</div>
          ) : pending.length === 0 ? (
            <div className="bg-white border rounded p-8 text-center text-gray-500">
              No pending approvals.
            </div>
          ) : (
            <ul className="space-y-3">
              {pending.map(p => (
                <li key={p.runId} className="bg-white border rounded p-4">
                  <div className="flex justify-between items-start">
                    <div>
                      <p className="font-mono text-xs text-gray-600">{p.profileId}</p>
                      <p className="text-sm font-medium mt-1">
                        {p.checkpoint?.message || 'Approval requested'}
                      </p>
                    </div>
                    <button
                      onClick={() => navigate(`/admin/agents/runs/${p.runId}`)}
                      className="px-3 py-2 bg-indigo-600 text-white rounded text-sm"
                    >
                      Open run
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </AdminAuth>
  );
}
