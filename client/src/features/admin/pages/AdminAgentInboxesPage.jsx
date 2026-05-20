import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import AdminAuth from '../components/AdminAuth';
import AdminNavigation from '../components/AdminNavigation';
import { fetchInboxes, createInbox } from '../../../api/agentsAdminApi';

export default function AdminAgentInboxesPage() {
  const navigate = useNavigate();
  const [inboxes, setInboxes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [newId, setNewId] = useState('');

  useEffect(() => {
    load();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const res = await fetchInboxes();
      setInboxes(res?.data || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (!newId) return;
    try {
      await createInbox(newId, `# ${newId}\n`);
      setNewId('');
      // Drop straight into the editor so the user can add items immediately.
      navigate(`/admin/agents/inboxes/${newId}`);
    } catch (err) {
      setError(err?.response?.data?.message || err.message);
    }
  }

  return (
    <AdminAuth>
      <div className="bg-gray-50 min-h-screen">
        <AdminNavigation />
        <div className="max-w-4xl mx-auto py-8 px-4">
          <h1 className="text-2xl font-bold mb-6">Agent Inboxes</h1>
          {error && (
            <div className="mb-3 p-3 bg-red-50 border border-red-200 text-red-800 rounded">
              {error}
            </div>
          )}
          <div className="bg-white border rounded p-4 mb-6">
            <h2 className="text-sm font-semibold mb-2">Create inbox</h2>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="engineering-todos"
                value={newId}
                onChange={e => setNewId(e.target.value)}
                className="flex-1 border-gray-300 rounded shadow-sm text-sm"
              />
              <button
                onClick={handleCreate}
                className="px-3 py-2 text-sm bg-indigo-600 text-white rounded"
              >
                Create
              </button>
            </div>
          </div>
          {loading ? (
            <div>Loading…</div>
          ) : (
            <div className="bg-white border rounded">
              <table className="min-w-full">
                <thead>
                  <tr className="bg-gray-50 text-left text-xs font-semibold uppercase">
                    <th className="px-4 py-3">ID</th>
                    <th className="px-4 py-3">Open</th>
                    <th className="px-4 py-3">Total</th>
                    <th className="px-4 py-3">Updated</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {inboxes.map(inbox => (
                    <tr key={inbox.inboxId} className="border-t">
                      <td className="px-4 py-3 font-mono">{inbox.inboxId}</td>
                      <td className="px-4 py-3">{inbox.openCount}</td>
                      <td className="px-4 py-3">{inbox.totalCount}</td>
                      <td className="px-4 py-3 text-xs">{inbox.updatedAt || '—'}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => navigate(`/admin/agents/inboxes/${inbox.inboxId}`)}
                          className="text-indigo-600 hover:underline"
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                  {inboxes.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-6 text-center text-gray-500">
                        No inboxes yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AdminAuth>
  );
}
